//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ===================== usługa: zgoda użytkownika i uruchomienie pomocnika =====================

var procWTSSendMessage = wtsapi.NewProc("WTSSendMessageW")

const (
	mbOK            = 0x00000000
	mbYesNo         = 0x00000004
	mbIconQuestion  = 0x00000020
	mbIconInfo      = 0x00000040
	mbDefButton2    = 0x00000100
	mbSystemModal   = 0x00001000
	mbSetForeground = 0x00010000
	idYes           = 6
)

func desktopSupported() bool { return true }

// targetSession — sesja z ekranem: konsola (także ekran logowania); bez konsoli — pierwsza aktywna sesja RDP.
func targetSession() (uint32, error) {
	if sid := windows.WTSGetActiveConsoleSessionId(); sid != 0xFFFFFFFF {
		return sid, nil
	}
	var sessions *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &sessions, &count); err != nil {
		return 0, err
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(sessions)))
	for _, s := range unsafe.Slice(sessions, count) {
		if s.State == windows.WTSActive && s.SessionID != 0 {
			return s.SessionID, nil
		}
	}
	return 0, errors.New("brak sesji z pulpitem")
}

func wtsSendMessage(session uint32, title, msg string, style, timeoutSec uint32, wait bool) (uint32, error) {
	t, _ := windows.UTF16FromString(title)
	m, _ := windows.UTF16FromString(msg)
	var resp uint32
	w := uintptr(0)
	if wait {
		w = 1
	}
	r, _, err := procWTSSendMessage.Call(0, uintptr(session),
		uintptr(unsafe.Pointer(&t[0])), uintptr((len(t)-1)*2),
		uintptr(unsafe.Pointer(&m[0])), uintptr((len(m)-1)*2),
		uintptr(style), uintptr(timeoutSec), uintptr(unsafe.Pointer(&resp)), w)
	if r == 0 {
		return 0, err
	}
	return resp, nil
}

// askDesktopConsent: none — bez komunikatu (kiosk), notify — informacja na ekranie bez blokowania,
// ask — pytanie Tak/Nie (30 s, domyślnie „Nie”; brak odpowiedzi = odmowa).
func askDesktopConsent(mode, viewer string) (bool, error) {
	if mode == "" || mode == "none" {
		return true, nil
	}
	who := viewer
	if who == "" {
		who = "Administrator"
	}
	sid, err := targetSession()
	if err != nil {
		return mode != "ask", nil
	}
	switch mode {
	case "notify":
		_, _ = wtsSendMessage(sid, "OVERVNC", who+" łączy się zdalnie z tym komputerem (OVERVNC).", mbOK|mbIconInfo|mbSetForeground, 10, false)
		return true, nil
	case "ask":
		resp, err := wtsSendMessage(sid, "OVERVNC — prośba o połączenie",
			who+" chce połączyć się zdalnie z tym komputerem i widzieć ekran.\n\nCzy zezwolić?",
			mbYesNo|mbIconQuestion|mbDefButton2|mbSystemModal|mbSetForeground, 30, true)
		if err != nil {
			return false, protoErr("consent_failed", "nie można zapytać użytkownika o zgodę: %v", err)
		}
		return resp == idYes, nil
	}
	return false, protoErr("bad_request", "nieznany tryb zgody %q", mode)
}

type winHelper struct {
	proc windows.Handle
	in   *os.File
	out  *os.File
	once sync.Once
}

func (h *winHelper) stdin() io.Writer  { return h.in }
func (h *winHelper) stdout() io.Reader { return h.out }
func (h *winHelper) wait() {
	_, _ = windows.WaitForSingleObject(h.proc, windows.INFINITE)
	h.once.Do(func() { _ = windows.CloseHandle(h.proc) })
}
func (h *winHelper) kill() {
	_ = h.in.Close()
	_ = windows.TerminateProcess(h.proc, 1)
}

// spawnDesktopHelper uruchamia „desktop-helper” jako SYSTEM w sesji użytkownika (token usługi
// z podmienionym identyfikatorem sesji) — widzi wtedy także ekran blokady i okna UAC.
// args: dodatkowe argumenty (np. "snapshot 640" — jednorazowy zrzut ekranu).
func spawnDesktopHelper(args ...string) (helperProc, error) {
	sid, err := targetSession()
	if err != nil {
		return nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}

	var self windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY|windows.TOKEN_ADJUST_DEFAULT|windows.TOKEN_ADJUST_SESSIONID, &self); err != nil {
		return nil, fmt.Errorf("token usługi: %w", err)
	}
	defer self.Close()
	var tok windows.Token
	if err := windows.DuplicateTokenEx(self, windows.MAXIMUM_ALLOWED, nil, windows.SecurityImpersonation, windows.TokenPrimary, &tok); err != nil {
		return nil, fmt.Errorf("duplikat tokenu: %w", err)
	}
	defer tok.Close()
	if err := windows.SetTokenInformation(tok, windows.TokenSessionId, (*byte)(unsafe.Pointer(&sid)), 4); err != nil {
		return nil, fmt.Errorf("sesja %d: %w", sid, err)
	}

	sa := &windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, sa, 0); err != nil {
		return nil, err
	}
	if err := windows.CreatePipe(&outR, &outW, sa, 0); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		return nil, err
	}
	// końcówki po stronie usługi nie mogą być dziedziczone
	_ = windows.SetHandleInformation(inW, windows.HANDLE_FLAG_INHERIT, 0)
	_ = windows.SetHandleInformation(outR, windows.HANDLE_FLAG_INHERIT, 0)
	nulName, _ := windows.UTF16PtrFromString("NUL")
	nul, _ := windows.CreateFile(nulName, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, sa, windows.OPEN_EXISTING, 0, 0)

	desk, _ := windows.UTF16PtrFromString(`winsta0\default`)
	si := windows.StartupInfo{
		Desktop:    desk,
		Flags:      windows.STARTF_USESTDHANDLES | windows.STARTF_USESHOWWINDOW,
		ShowWindow: windows.SW_HIDE,
		StdInput:   inR,
		StdOutput:  outW,
		StdErr:     nul,
	}
	si.Cb = uint32(unsafe.Sizeof(si))
	line := `"` + exe + `" desktop-helper`
	for _, a := range args {
		line += " " + windows.EscapeArg(a)
	}
	cmd, _ := windows.UTF16PtrFromString(line)
	var pi windows.ProcessInformation
	// ForkLock: w czasie tworzenia procesu inne wątki nie mogą tworzyć dziedziczonych uchwytów
	syscall.ForkLock.Lock()
	err = windows.CreateProcessAsUser(tok, nil, cmd, nil, nil, true, windows.CREATE_NO_WINDOW, nil, nil, &si, &pi)
	syscall.ForkLock.Unlock()
	windows.CloseHandle(inR)
	windows.CloseHandle(outW)
	if nul != 0 && nul != windows.InvalidHandle {
		windows.CloseHandle(nul)
	}
	if err != nil {
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		return nil, fmt.Errorf("CreateProcessAsUser: %w", err)
	}
	windows.CloseHandle(pi.Thread)
	return &winHelper{proc: pi.Process, in: os.NewFile(uintptr(inW), "desktop-in"), out: os.NewFile(uintptr(outR), "desktop-out")}, nil
}

// ===================== pomocnik: przechwytywanie GDI i SendInput =====================

var (
	user32                     = windows.NewLazySystemDLL("user32.dll")
	gdi32                      = windows.NewLazySystemDLL("gdi32.dll")
	procGetDC                  = user32.NewProc("GetDC")
	procReleaseDC              = user32.NewProc("ReleaseDC")
	procEnumDisplayMonitors    = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW        = user32.NewProc("GetMonitorInfoW")
	procSetCursorPos           = user32.NewProc("SetCursorPos")
	procSendInput              = user32.NewProc("SendInput")
	procGetCursorInfo          = user32.NewProc("GetCursorInfo")
	procGetIconInfo            = user32.NewProc("GetIconInfo")
	procDrawIconEx             = user32.NewProc("DrawIconEx")
	procOpenInputDesktop       = user32.NewProc("OpenInputDesktop")
	procSetThreadDesktop       = user32.NewProc("SetThreadDesktop")
	procCloseDesktop           = user32.NewProc("CloseDesktop")
	procGetUserObjectInfoW     = user32.NewProc("GetUserObjectInformationW")
	procSetDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDPIAware     = user32.NewProc("SetProcessDPIAware")
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection       = gdi32.NewProc("CreateDIBSection")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
)

const (
	srcCopy  = 0x00CC0020
	diNormal = 3

	inputMouse    = 0
	inputKeyboard = 1

	mouseLeftDown   = 0x0002
	mouseLeftUp     = 0x0004
	mouseRightDown  = 0x0008
	mouseRightUp    = 0x0010
	mouseMiddleDown = 0x0020
	mouseMiddleUp   = 0x0040
	mouseWheel      = 0x0800

	keyExtended = 0x0001
	keyUp       = 0x0002
	keyScancode = 0x0008
)

type rect struct{ Left, Top, Right, Bottom int32 }

type monitorInfoEx struct {
	cbSize    uint32
	rcMonitor rect
	rcWork    rect
	dwFlags   uint32
	szDevice  [32]uint16
}

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type cursorInfo struct {
	cbSize  uint32
	flags   uint32
	hCursor uintptr
	x, y    int32
}

type iconInfo struct {
	fIcon    int32
	xHotspot uint32
	yHotspot uint32
	hbmMask  uintptr
	hbmColor uintptr
}

// struktury INPUT (64-bit): 40 bajtów — zły rozmiar = SendInput po cichu nic nie robi
type mouseInput struct {
	typ       uint32
	_         uint32
	dx, dy    int32
	mouseData uint32
	flags     uint32
	time      uint32
	extra     uintptr
}

type keyInput struct {
	typ   uint32
	_     uint32
	vk    uint16
	scan  uint16
	flags uint32
	time  uint32
	extra uintptr
	_     [8]byte
}

// kontrola rozmiaru przy kompilacji (indeks spoza zakresu = błąd kompilacji)
var (
	_ = [1]struct{}{}[unsafe.Sizeof(mouseInput{})-40]
	_ = [1]struct{}{}[unsafe.Sizeof(keyInput{})-40]
)

type gdiBackend struct {
	desk     uintptr
	deskName string
	memDC    uintptr
	bmp      uintptr
	oldObj   uintptr
	bits     unsafe.Pointer
	w, h     int
	out      []byte // bufor klatki używany ponownie (bez 8 MB nowej pamięci na każdą klatkę)
}

var (
	monitorsMu  sync.Mutex
	monitorsAcc []MonitorInfo
	monitorsCB  = windows.NewCallback(func(hmon, hdc, lprc, lparam uintptr) uintptr {
		mi := monitorInfoEx{}
		mi.cbSize = uint32(unsafe.Sizeof(mi))
		if r, _, _ := procGetMonitorInfoW.Call(hmon, uintptr(unsafe.Pointer(&mi))); r != 0 {
			monitorsAcc = append(monitorsAcc, MonitorInfo{
				Index:   len(monitorsAcc),
				X:       int(mi.rcMonitor.Left),
				Y:       int(mi.rcMonitor.Top),
				W:       int(mi.rcMonitor.Right - mi.rcMonitor.Left),
				H:       int(mi.rcMonitor.Bottom - mi.rcMonitor.Top),
				Primary: mi.dwFlags&1 != 0,
				Name:    windows.UTF16ToString(mi.szDevice[:]),
			})
		}
		return 1
	})
)

func newDesktopBackend() (desktopBackend, error) {
	// fizyczne piksele na ekranach z powiększeniem (125%, 150%…) — inaczej obraz i kliknięcia się rozjadą
	// SetProcessDpiAwarenessContext istnieje od Windows 10 1703 — wywołanie brakującej funkcji kończy się paniką
	perMonitor := false
	if procSetDpiAwarenessContext.Find() == nil {
		r, _, _ := procSetDpiAwarenessContext.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
		perMonitor = r != 0
	}
	if !perMonitor && procSetProcessDPIAware.Find() == nil {
		_, _, _ = procSetProcessDPIAware.Call()
	}
	b := &gdiBackend{}
	b.switchDesktop()
	return b, nil
}

// switchDesktop przełącza wątek na bieżący pulpit wejściowy (zwykły / ekran blokady / UAC).
func (b *gdiBackend) switchDesktop() {
	h, _, _ := procOpenInputDesktop.Call(0, 0, windows.GENERIC_ALL)
	if h == 0 {
		return
	}
	var name [64]uint16
	var needed uint32
	_, _, _ = procGetUserObjectInfoW.Call(h, 2 /* UOI_NAME */, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)*2), uintptr(unsafe.Pointer(&needed)))
	n := windows.UTF16ToString(name[:])
	if n == b.deskName {
		_, _, _ = procCloseDesktop.Call(h)
		return
	}
	if r, _, _ := procSetThreadDesktop.Call(h); r == 0 {
		_, _, _ = procCloseDesktop.Call(h)
		return
	}
	if b.desk != 0 {
		_, _, _ = procCloseDesktop.Call(b.desk)
	}
	b.desk, b.deskName = h, n
}

func (b *gdiBackend) monitors() ([]MonitorInfo, string) {
	b.switchDesktop()
	monitorsMu.Lock()
	defer monitorsMu.Unlock()
	monitorsAcc = nil
	_, _, _ = procEnumDisplayMonitors.Call(0, 0, monitorsCB, 0)
	return append([]MonitorInfo(nil), monitorsAcc...), b.deskName
}

func (b *gdiBackend) ensureBitmap(w, h int) error {
	if b.memDC != 0 && b.w == w && b.h == h {
		return nil
	}
	b.freeBitmap()
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return errors.New("GetDC")
	}
	defer procReleaseDC.Call(0, screen)
	b.memDC, _, _ = procCreateCompatibleDC.Call(screen)
	bmi := bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32} // ujemna wysokość = od góry
	bmi.Size = uint32(unsafe.Sizeof(bmi))
	var bits unsafe.Pointer
	b.bmp, _, _ = procCreateDIBSection.Call(screen, uintptr(unsafe.Pointer(&bmi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if b.memDC == 0 || b.bmp == 0 || bits == nil {
		b.freeBitmap()
		return errors.New("CreateDIBSection")
	}
	b.oldObj, _, _ = procSelectObject.Call(b.memDC, b.bmp)
	b.bits, b.w, b.h = bits, w, h
	return nil
}

func (b *gdiBackend) freeBitmap() {
	if b.memDC != 0 {
		if b.oldObj != 0 {
			_, _, _ = procSelectObject.Call(b.memDC, b.oldObj)
		}
		_, _, _ = procDeleteDC.Call(b.memDC)
	}
	if b.bmp != 0 {
		_, _, _ = procDeleteObject.Call(b.bmp)
	}
	b.memDC, b.bmp, b.oldObj, b.bits = 0, 0, 0, nil
}

func (b *gdiBackend) capture(m MonitorInfo) ([]byte, int, int, error) {
	b.switchDesktop()
	if m.W <= 0 || m.H <= 0 {
		return nil, 0, 0, errors.New("brak monitora")
	}
	if err := b.ensureBitmap(m.W, m.H); err != nil {
		return nil, 0, 0, err
	}
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil, 0, 0, errors.New("GetDC")
	}
	// bez CAPTUREBLT: przy kompozycji DWM (Windows 8+) okna warstwowe i tak są w obrazie, a ta flaga
	// wielokrotnie spowalnia BitBlt na słabszych procesorach i powoduje miganie kursora
	r, _, err := procBitBlt.Call(b.memDC, 0, 0, uintptr(m.W), uintptr(m.H), screen, uintptr(int32(m.X)), uintptr(int32(m.Y)), srcCopy)
	_, _, _ = procReleaseDC.Call(0, screen)
	if r == 0 {
		return nil, 0, 0, fmt.Errorf("BitBlt: %v", err)
	}
	b.drawCursor(m)
	n := m.W * m.H * 4
	if len(b.out) != n {
		b.out = make([]byte, n)
	}
	copy(b.out, unsafe.Slice((*byte)(b.bits), n))
	return b.out, m.W, m.H, nil
}

func (b *gdiBackend) drawCursor(m MonitorInfo) {
	ci := cursorInfo{}
	ci.cbSize = uint32(unsafe.Sizeof(ci))
	if r, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci))); r == 0 || ci.flags&1 == 0 || ci.hCursor == 0 {
		return
	}
	var ii iconInfo
	if r, _, _ := procGetIconInfo.Call(ci.hCursor, uintptr(unsafe.Pointer(&ii))); r == 0 {
		return
	}
	x := int(ci.x) - m.X - int(ii.xHotspot)
	y := int(ci.y) - m.Y - int(ii.yHotspot)
	_, _, _ = procDrawIconEx.Call(b.memDC, uintptr(int32(x)), uintptr(int32(y)), ci.hCursor, 0, 0, 0, 0, diNormal)
	if ii.hbmMask != 0 {
		_, _, _ = procDeleteObject.Call(ii.hbmMask)
	}
	if ii.hbmColor != 0 {
		_, _, _ = procDeleteObject.Call(ii.hbmColor)
	}
}

func sendMouse(flags, data uint32) error {
	in := mouseInput{typ: inputMouse, flags: flags, mouseData: data}
	if r, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in)); r == 0 {
		return fmt.Errorf("SendInput: %v", err)
	}
	return nil
}

func (b *gdiBackend) moveTo(ev InputEvent, m MonitorInfo) {
	x := m.X + int(ev.X*float64(m.W-1)+0.5)
	y := m.Y + int(ev.Y*float64(m.H-1)+0.5)
	_, _, _ = procSetCursorPos.Call(uintptr(int32(x)), uintptr(int32(y)))
}

func (b *gdiBackend) input(ev InputEvent, m MonitorInfo) error {
	b.switchDesktop()
	switch ev.T {
	case "m":
		b.moveTo(ev, m)
	case "b":
		b.moveTo(ev, m)
		var f uint32
		switch ev.B {
		case 0:
			f = map[bool]uint32{true: mouseLeftDown, false: mouseLeftUp}[ev.D]
		case 1:
			f = map[bool]uint32{true: mouseMiddleDown, false: mouseMiddleUp}[ev.D]
		case 2:
			f = map[bool]uint32{true: mouseRightDown, false: mouseRightUp}[ev.D]
		default:
			return nil
		}
		return sendMouse(f, 0)
	case "w":
		// przeglądarka: dodatnie = w dół; Windows: dodatnie = od użytkownika (w górę)
		return sendMouse(mouseWheel, uint32(int32(-ev.DY)))
	case "k":
		sc, ext, ok := scanCodeFor(ev.Code)
		if !ok {
			return nil
		}
		flags := uint32(keyScancode)
		if ext {
			flags |= keyExtended
		}
		if !ev.D {
			flags |= keyUp
		}
		in := keyInput{typ: inputKeyboard, scan: sc, flags: flags}
		if r, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in)); r == 0 {
			return fmt.Errorf("SendInput: %v", err)
		}
	}
	return nil
}

func (b *gdiBackend) close() {
	b.freeBitmap()
	if b.desk != 0 {
		_, _, _ = procCloseDesktop.Call(b.desk)
	}
}

// showScreenMessage wyświetla okno komunikatu w sesji z ekranem (nie czeka na zamknięcie).
func showScreenMessage(title, text string, seconds int) error {
	sid, err := targetSession()
	if err != nil {
		return err
	}
	_, err = wtsSendMessage(sid, title, text, mbOK|mbIconInfo|mbSetForeground|mbSystemModal, uint32(seconds), false)
	return err
}
