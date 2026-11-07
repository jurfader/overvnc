package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Ikona OVERVNC w zasobniku (sesja użytkownika) i jej odpowiednik w usłudze agenta.
//   - `overvnc-agent tray`: ikona, menu, dymki z wiadomościami od wsparcia, okno czatu,
//   - usługa: kanał \\.\pipe\OVERVNC-Tray (tylko zalogowani interaktywnie) i uruchamianie ikony
//     w sesji użytkownika — na zwykłych komputerach (nie na kioskach).

var (
	procShellNotifyIconW       = shell32.NewProc("Shell_NotifyIconW")
	procCreatePopupMenu        = user32.NewProc("CreatePopupMenu")
	procAppendMenuW            = user32.NewProc("AppendMenuW")
	procTrackPopupMenu         = user32.NewProc("TrackPopupMenu")
	procDestroyMenu            = user32.NewProc("DestroyMenu")
	procSetForegroundWindow    = user32.NewProc("SetForegroundWindow")
	procRegisterWindowMessageW = user32.NewProc("RegisterWindowMessageW")
	procCreateIconIndirect     = user32.NewProc("CreateIconIndirect")
	procDestroyIcon            = user32.NewProc("DestroyIcon")
	procGetSystemMetrics       = user32.NewProc("GetSystemMetrics")
	procGetCursorPos           = user32.NewProc("GetCursorPos")
	procCreateBitmap           = gdi32.NewProc("CreateBitmap")
)

const (
	trayPipe       = `\\.\pipe\OVERVNC-Tray`
	nimAdd         = 0
	nimModify      = 1
	nimDelete      = 2
	nifMessage     = 0x1
	nifIcon        = 0x2
	nifTip         = 0x4
	nifInfo        = 0x10
	niifInfo       = 0x1
	ninBalloonUser = 0x405
	wmRButtonUp    = 0x0205
	wmContextMenu  = 0x007B
	trayCallback   = wmApp + 10
	trayRefresh    = wmApp + 11
	trayBalloon    = wmApp + 12
	mfString       = 0x0
	mfSeparator    = 0x800
	mfGrayed       = 0x1
	mfDefault      = 0x1000
	tpmReturnCmd   = 0x0100
	tpmRightButton = 0x0002
	menuChat       = 1
	menuEnd        = 2
	menuInfo       = 3
)

type notifyIconData struct {
	cbSize           uint32
	hwnd             uintptr
	uID              uint32
	uFlags           uint32
	uCallbackMessage uint32
	hIcon            uintptr
	szTip            [128]uint16
	dwState          uint32
	dwStateMask      uint32
	szInfo           [256]uint16
	uVersion         uint32
	szInfoTitle      [64]uint16
	dwInfoFlags      uint32
	guidItem         windows.GUID
	hBalloonIcon     uintptr
}

func copyUTF16(dst []uint16, s string) {
	u, _ := windows.UTF16FromString(s)
	if len(u) > len(dst) {
		u = append(u[:len(dst)-1], 0)
	}
	copy(dst, u)
}

// hiconFromImage — ikona Windows z obrazu (32-bit z kanałem alfa).
func hiconFromImage(img *image.RGBA) uintptr {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	dc, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, dc)
	bmi := bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	bmi.Size = uint32(unsafe.Sizeof(bmi))
	var bits unsafe.Pointer
	color, _, _ := procCreateDIBSection.Call(dc, uintptr(unsafe.Pointer(&bmi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if color == 0 {
		return 0
	}
	px := unsafe.Slice((*byte)(bits), w*h*4)
	for i := 0; i+3 < len(img.Pix); i += 4 {
		px[i], px[i+1], px[i+2], px[i+3] = img.Pix[i+2], img.Pix[i+1], img.Pix[i], img.Pix[i+3]
	}
	mask, _, _ := procCreateBitmap.Call(uintptr(w), uintptr(h), 1, 1, 0)
	info := struct {
		fIcon              int32
		xHotspot, yHotspot uint32
		hbmMask, hbmColor  uintptr
	}{fIcon: 1, hbmMask: mask, hbmColor: color}
	icon, _, _ := procCreateIconIndirect.Call(uintptr(unsafe.Pointer(&info)))
	procDeleteObject.Call(color)
	procDeleteObject.Call(mask)
	return icon
}

// ---------- proces ikony (sesja użytkownika) ----------

var tray struct {
	hwnd    uintptr
	nid     notifyIconData
	icon    uintptr
	remote  bool
	state   *trayState
	url     string
	mu      sync.Mutex
	balloon *chatMsg
	pipe    *os.File
	pipeMu  sync.Mutex
}

func runTray() int {
	runtime.LockOSThread()
	name, _ := windows.UTF16PtrFromString(`Local\OVERVNC-Tray`)
	if h, _, err := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name))); h == 0 || errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return 0
	}
	setDpiAware()
	st := &trayState{}
	if u, err := user.Current(); err == nil {
		st.user = u.Username
	}
	st.sendChat = func(text string) error { return trayToService(map[string]any{"t": "chat", "text": text}) }
	st.endRemote = func() error { return trayToService(map[string]any{"t": "end-remote"}) }
	tray.state = st
	url, err := startTrayServer(st)
	if err != nil {
		return 1
	}
	tray.url = url

	class := windows.StringToUTF16Ptr("OVERVNCTray")
	taskbarCreated, _, _ := procRegisterWindowMessageW.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("TaskbarCreated"))))
	wc := wndClassEx{lpfnWndProc: windows.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
		switch {
		case msg == trayCallback:
			switch lp & 0xFFFF {
			case wmLButtonUp, ninBalloonUser:
				trayOpenChat()
			case wmRButtonUp, wmContextMenu:
				trayMenu(hwnd)
			}
			return 0
		case msg == trayRefresh:
			trayUpdateIcon(false)
			return 0
		case msg == trayBalloon:
			tray.mu.Lock()
			m := tray.balloon
			tray.mu.Unlock()
			if m != nil {
				trayShowBalloon("Wiadomość od wsparcia — "+firstNonEmpty(m.Author, "OVERVNC"), m.Text)
			}
			return 0
		case msg == taskbarCreated && taskbarCreated != 0:
			trayUpdateIcon(true) // Eksplorator uruchomiony ponownie — ikona od nowa
			return 0
		}
		r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
		return r
	}), lpszClassName: class}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	tray.hwnd, _, _ = procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(class)), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
	if tray.hwnd == 0 {
		return 1
	}
	trayUpdateIcon(true)
	defer func() {
		procShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&tray.nid)))
	}()
	go trayServiceLink()

	var msg winMsg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 {
			return 0
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

func trayUpdateIcon(add bool) {
	remote := len(tray.state.remoteNames()) > 0
	if tray.icon == 0 || remote != tray.remote {
		size, _, _ := procGetSystemMetrics.Call(49 /* SM_CXSMICON */)
		if size == 0 {
			size = 16
		}
		if old := tray.icon; old != 0 {
			defer procDestroyIcon.Call(old)
		}
		tray.icon = hiconFromImage(renderTrayIcon(int(size), remote))
		tray.remote = remote
	}
	tray.nid.cbSize = uint32(unsafe.Sizeof(tray.nid))
	tray.nid.hwnd = tray.hwnd
	tray.nid.uID = 1
	tray.nid.uFlags = nifMessage | nifIcon | nifTip
	tray.nid.uCallbackMessage = trayCallback
	tray.nid.hIcon = tray.icon
	tip := "OVERVNC — wsparcie techniczne"
	if names := tray.state.remoteNames(); len(names) > 0 {
		tip = "OVERVNC — połączono: " + strings.Join(names, ", ")
	}
	tray.nid.szTip = [128]uint16{}
	copyUTF16(tray.nid.szTip[:], tip)
	op := uintptr(nimModify)
	if add {
		op = nimAdd
	}
	if r, _, _ := procShellNotifyIconW.Call(op, uintptr(unsafe.Pointer(&tray.nid))); r == 0 && !add {
		procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&tray.nid)))
	}
}

func trayShowBalloon(title, text string) {
	n := tray.nid
	n.uFlags = nifInfo
	n.dwInfoFlags = niifInfo
	if r := []rune(text); len(r) > 200 {
		text = string(r[:199]) + "…"
	}
	copyUTF16(n.szInfoTitle[:], title)
	copyUTF16(n.szInfo[:], text)
	procShellNotifyIconW.Call(nimModify, uintptr(unsafe.Pointer(&n)))
}

func trayOpenChat() {
	_ = openAppWindow(tray.url, "chat-window", "--window-size=440,680")
}

func trayMenu(hwnd uintptr) {
	m, _, _ := procCreatePopupMenu.Call()
	defer procDestroyMenu.Call(m)
	add := func(flags uintptr, id int, text string) {
		t, _ := windows.UTF16PtrFromString(text)
		procAppendMenuW.Call(m, flags, uintptr(id), uintptr(unsafe.Pointer(t)))
	}
	add(mfString|mfDefault, menuChat, "Napisz do wsparcia")
	if names := tray.state.remoteNames(); len(names) > 0 {
		add(mfString, menuEnd, "Zakończ sesję zdalną ("+strings.Join(names, ", ")+")")
	}
	add(mfSeparator, 0, "")
	add(mfString, menuInfo, "Informacje o komputerze")
	var pt struct{ x, y int32 }
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	procSetForegroundWindow.Call(hwnd) // menu zamyka się po kliknięciu obok
	cmd, _, _ := procTrackPopupMenu.Call(m, tpmReturnCmd|tpmRightButton, uintptr(pt.x), uintptr(pt.y), 0, hwnd, 0)
	procPostMessageW.Call(hwnd, 0, 0, 0)
	switch cmd {
	case menuChat:
		trayOpenChat()
	case menuEnd:
		if messageBox(hwnd, "Zakończyć zdalną sesję? Osoba ze wsparcia straci podgląd Twojego ekranu.", "OVERVNC", mbYesNo|mbIconQuestion|mbTopmost) == idYes {
			_ = trayToService(map[string]any{"t": "end-remote"})
		}
	case menuInfo:
		st := tray.state
		st.mu.Lock()
		online, computer := st.online && st.linked, st.computer
		st.mu.Unlock()
		state := "połączony ze wsparciem"
		if !online {
			state = "brak połączenia ze wsparciem"
		}
		messageBox(hwnd, fmt.Sprintf("Komputer: %s\nUżytkownik: %s\nOVERVNC Agent %s — %s\n\nPodaj nazwę komputera osobie ze wsparcia.", firstNonEmpty(computer, hostnameOr("?")), st.user, version, state), "OVERVNC — informacje", mbIconInfo|mbTopmost)
	}
}

// trayServiceLink — połączenie z usługą agenta (ponawiane); wiadomości do okna i dymków.
func trayServiceLink() {
	for {
		f, err := os.OpenFile(trayPipe, os.O_RDWR, 0)
		if err != nil {
			tray.state.setLinked(false)
			procPostMessageW.Call(tray.hwnd, trayRefresh, 0, 0)
			time.Sleep(5 * time.Second)
			continue
		}
		tray.pipeMu.Lock()
		tray.pipe = f
		tray.pipeMu.Unlock()
		tray.state.setLinked(true)
		_ = trayToService(map[string]any{"t": "hello", "user": tray.state.user})
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64<<10), 4<<20)
		for sc.Scan() {
			incoming, status := tray.state.apply(sc.Bytes())
			if status {
				procPostMessageW.Call(tray.hwnd, trayRefresh, 0, 0)
			}
			if incoming != nil {
				tray.mu.Lock()
				tray.balloon = incoming
				tray.mu.Unlock()
				procPostMessageW.Call(tray.hwnd, trayBalloon, 0, 0)
				if !tray.state.windowOpen() {
					trayOpenChat() // wiadomość od wsparcia — okno czatu od razu
				}
			}
		}
		tray.pipeMu.Lock()
		tray.pipe = nil
		tray.pipeMu.Unlock()
		f.Close()
		tray.state.setLinked(false)
		procPostMessageW.Call(tray.hwnd, trayRefresh, 0, 0)
		time.Sleep(2 * time.Second)
	}
}

func trayToService(v any) error {
	b, _ := json.Marshal(v)
	tray.pipeMu.Lock()
	defer tray.pipeMu.Unlock()
	if tray.pipe == nil {
		return errors.New("brak połączenia z usługą OVERVNC — spróbuj za chwilę")
	}
	_, err := tray.pipe.Write(append(b, '\n'))
	return err
}

// ---------- usługa agenta ----------

type trayConn struct {
	mu   sync.Mutex
	f    *os.File
	user string
}

func (c *trayConn) send(v any) error {
	b, _ := json.Marshal(v)
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.f.Write(append(b, '\n'))
	return err
}

func runTrayService(ctx context.Context) {
	go runTrayPipe(ctx)
	var proc windows.Handle
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		// ikona tylko na zwykłych komputerach — klienci kiosku nie piszą do wsparcia
		want := !currentProfile().Kiosk
		running := processRunning(proc)
		switch {
		case want && !running:
			if proc != 0 {
				windows.CloseHandle(proc)
				proc = 0
			}
			if _, err := targetSession(); err == nil {
				if h, err := startAsConsoleUser("tray"); err == nil {
					proc = h
				}
			}
		case !want && running:
			_ = windows.TerminateProcess(proc, 0)
		}
	}
}

func runTrayPipe(ctx context.Context) {
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GRGW;;;IU)")
	if err != nil {
		return
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	name, _ := windows.UTF16PtrFromString(trayPipe)
	for ctx.Err() == nil {
		h, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX,
			windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS,
			windows.PIPE_UNLIMITED_INSTANCES, 64<<10, 64<<10, 0, &sa)
		if err != nil {
			time.Sleep(30 * time.Second)
			continue
		}
		if err := windows.ConnectNamedPipe(h, nil); err != nil && err != windows.ERROR_PIPE_CONNECTED {
			windows.CloseHandle(h)
			continue
		}
		go serveTrayConn(os.NewFile(uintptr(h), "tray-pipe"))
	}
}

func serveTrayConn(f *os.File) {
	defer f.Close()
	c := &trayConn{f: f}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 256<<10)
	registered := false
	defer func() {
		if registered {
			chatRemovePeer(c)
		}
	}()
	for sc.Scan() {
		var m struct {
			T    string `json:"t"`
			User string `json:"user"`
			Text string `json:"text"`
		}
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		switch m.T {
		case "hello":
			c.user = filepath.Base(strings.ReplaceAll(m.User, `\`, "/"))
			if !registered {
				registered = true
				chatAddPeer(c)
			}
		case "chat":
			chatFromUser(firstNonEmpty(c.user, "użytkownik"), m.Text)
		case "end-remote":
			endDesktopSessions("Użytkownik komputera zakończył zdalną sesję.")
		}
	}
}
