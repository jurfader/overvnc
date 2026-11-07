package main

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// „Zakończ i usuń moje dane” — po stronie klienta kiosku (jego sesja, jego konto):
//   - `session-button`: przycisk zawsze na wierzchu w lewym dolnym rogu (nie zabiera fokusu),
//   - `session-end`: to samo bez przycisku (kafelek w menu Start).
// Po potwierdzeniu: programy zamykane normalnie (przeglądarka sama wylogowuje ze stron), potem prośba do
// usługi agenta (kanał \\.\pipe\OVERVNC-Kiosk) — ona usuwa Pobrane i restartuje (UWF odrzuca resztę).

var (
	procMessageBoxW              = user32.NewProc("MessageBoxW")
	procSystemParametersInfoW    = user32.NewProc("SystemParametersInfoW")
	procSetCursor                = user32.NewProc("SetCursor")
	procLoadCursorW              = user32.NewProc("LoadCursorW")
	procTrackMouseEvent          = user32.NewProc("TrackMouseEvent")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procPostMessageW             = user32.NewProc("PostMessageW")
	procGetClassNameW            = user32.NewProc("GetClassNameW")
	procSetTimer                 = user32.NewProc("SetTimer")
)

const (
	kioskPipe     = `\\.\pipe\OVERVNC-Kiosk`
	wmClose       = 0x0010
	wmSetCursor   = 0x0020
	wmMouseAct    = 0x0021
	wmTimer       = 0x0113
	wmMouseMove   = 0x0200
	wmLButtonDown = 0x0201
	wmLButtonUp   = 0x0202
	wmMouseLeave  = 0x02A3
	wmApp         = 0x8000
	mbIconErr     = 0x10
	mbTopmost     = 0x40000
	idcHand       = 32649
	maNoActivate  = 3
)

const endConfirmText = "Zakończyć i usunąć Twoje dane?\n\n" +
	"Zamknę otwarte programy, usunę pliki z folderu Pobrane i wyloguję Cię ze wszystkich stron. " +
	"Komputer uruchomi się ponownie — potrwa to około 1–2 minut.\n\n" +
	"Pliki, które chcesz zachować, najpierw zapisz na swoim pendrivie."

func messageBox(owner uintptr, text, title string, flags uintptr) uintptr {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(title)
	r, _, _ := procMessageBoxW.Call(owner, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
	return r
}

// endSessionFlow — pytanie, zamknięcie programów, prośba do usługi. busy() — przycisk pokazuje „Usuwam dane…”.
func endSessionFlow(owner uintptr, busy func(bool)) {
	if messageBox(owner, endConfirmText, endBtnLabel, mbYesNo|mbIconQuestion|mbDefButton2|mbTopmost|mbSetForeground) != idYes {
		return
	}
	busy(true)
	closeClientApps(10 * time.Second)
	if err := requestKioskCleanup(); err != nil {
		busy(false)
		messageBox(owner, "Nie udało się usunąć danych: "+err.Error()+"\n\nPoproś obsługę o pomoc.", endBtnLabel, mbIconErr|mbTopmost|mbSetForeground)
	}
}

// runSessionEnd — `overvnc-agent session-end` (kafelek w Start).
func runSessionEnd() int {
	endSessionFlow(0, func(bool) {})
	return 0
}

// closeClientApps — prośba o zamknięcie (WM_CLOSE) okien przeglądarek, LibreOffice, Notatnika i folderów;
// czeka, aż przeglądarki się zamkną (wtedy czyszczą ciasteczka i logowania).
func closeClientApps(wait time.Duration) {
	self := uint32(os.Getpid())
	targets := map[string]bool{"chrome.exe": true, "msedge.exe": true, "soffice.bin": true, "soffice.exe": true, "notepad.exe": true}
	cb := windows.NewCallback(func(hwnd, _ uintptr) uintptr {
		if v, _, _ := procIsWindowVisible.Call(hwnd); v == 0 {
			return 1
		}
		var pid uint32
		procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid == self {
			return 1
		}
		name := strings.ToLower(filepath.Base(processPath(pid)))
		if targets[name] || (name == "explorer.exe" && windowClass(hwnd) == "CabinetWClass") {
			procPostMessageW.Call(hwnd, wmClose, 0, 0)
		}
		return 1
	})
	procEnumWindows.Call(cb, 0)
	for deadline := time.Now().Add(wait); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		if !processesRunning("chrome.exe", "msedge.exe") {
			return
		}
	}
}

func processPath(pid uint32) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

func windowClass(hwnd uintptr) string {
	buf := make([]uint16, 64)
	n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf[:n])
}

// processesRunning — czy działa któryś z procesów (tej sesji — inne sesje nas nie dotyczą).
func processesRunning(names ...string) bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)
	var mySession uint32
	_ = windows.ProcessIdToSessionId(uint32(os.Getpid()), &mySession)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err := windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		exe := strings.ToLower(windows.UTF16ToString(e.ExeFile[:]))
		for _, n := range names {
			var sid uint32
			if exe == n && windows.ProcessIdToSessionId(e.ProcessID, &sid) == nil && sid == mySession {
				return true
			}
		}
	}
	return false
}

// requestKioskCleanup — prośba do usługi agenta; odpowiedź „ok” albo „error: …”.
func requestKioskCleanup() error {
	f, err := os.OpenFile(kioskPipe, os.O_RDWR, 0)
	if err != nil {
		return errors.New("usługa OVERVNC nie odpowiada")
	}
	defer f.Close()
	if _, err := f.Write([]byte("cleanup\n")); err != nil {
		return err
	}
	line, err := bufio.NewReader(f).ReadString('\n')
	if err != nil && line == "" {
		return errors.New("brak odpowiedzi usługi OVERVNC")
	}
	line = strings.TrimSpace(line)
	if msg, ok := strings.CutPrefix(line, "error: "); ok {
		return errors.New(msg)
	}
	return nil
}

// ---------- przycisk na ekranie ----------

var endBtn struct {
	win            *layerWin
	screenDC       uintptr
	scale          float64
	hover, pressed bool
	busy           bool
	tracking       bool
}

var endBtnClass = windows.StringToUTF16Ptr("OVERVNCEndSessionButton")

func endBtnRedraw() {
	st := endBtnNormal
	switch {
	case endBtn.busy:
		st = endBtnBusy
	case endBtn.pressed:
		st = endBtnPressed
	case endBtn.hover:
		st = endBtnHover
	}
	endBtn.win.update(endBtn.screenDC, renderEndButton(endBtn.scale, st), 255, endBtn.win.y)
}

// workArea — pulpit bez paska zadań (monitor główny).
func workArea() (left, top, right, bottom int) {
	var r struct{ l, t, r, b int32 }
	procSystemParametersInfoW.Call(0x0030 /* SPI_GETWORKAREA */, 0, uintptr(unsafe.Pointer(&r)), 0)
	return int(r.l), int(r.t), int(r.r), int(r.b)
}

func endBtnPlace() (x, y int) {
	l, _, _, b := workArea()
	_, h, _ := endBtnSize(endBtn.scale)
	m := int(16 * endBtn.scale)
	return l + m, b - h - m
}

// runEndButton — `overvnc-agent session-button`: przycisk do końca sesji klienta.
func runEndButton() int {
	runtime.LockOSThread()
	name, _ := windows.UTF16PtrFromString(`Local\OVERVNC-EndButton`)
	if h, _, err := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name))); h == 0 || errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return 0 // już działa
	}
	setDpiAware()
	wc := wndClassEx{lpfnWndProc: windows.NewCallback(endBtnProc), lpszClassName: endBtnClass}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	endBtn.screenDC, _, _ = procGetDC.Call(0)
	l, _, _, b := workArea()
	endBtn.scale = monitorScale(l+10, b-10)
	w, h, _ := endBtnSize(endBtn.scale)
	x, y := endBtnPlace()
	endBtn.win = newLayerWinEx(endBtn.screenDC, x, y, w, h, wsExLayered|wsExTopmost|wsExToolWindow|wsExNoActivate, endBtnClass)
	if endBtn.win == nil {
		return 1
	}
	endBtnRedraw()
	endBtn.win.show()
	procSetTimer.Call(endBtn.win.hwnd, 1, 2000, 0)

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

func endBtnProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmMouseAct:
		return maNoActivate // klik nie zabiera fokusu oknu klienta
	case wmSetCursor:
		cur, _, _ := procLoadCursorW.Call(0, idcHand)
		procSetCursor.Call(cur)
		return 1
	case wmMouseMove:
		if !endBtn.tracking {
			tme := struct {
				size, flags uint32
				hwnd        uintptr
				hover       uint32
			}{flags: 2 /* TME_LEAVE */, hwnd: hwnd}
			tme.size = uint32(unsafe.Sizeof(tme))
			procTrackMouseEvent.Call(uintptr(unsafe.Pointer(&tme)))
			endBtn.tracking = true
		}
		if !endBtn.hover {
			endBtn.hover = true
			endBtnRedraw()
		}
		return 0
	case wmMouseLeave:
		endBtn.tracking, endBtn.hover, endBtn.pressed = false, false, false
		endBtnRedraw()
		return 0
	case wmLButtonDown:
		endBtn.pressed = true
		endBtnRedraw()
		return 0
	case wmLButtonUp:
		if endBtn.pressed && !endBtn.busy {
			endBtn.pressed = false
			endBtnRedraw()
			procPostMessageW.Call(hwnd, wmApp+1, 0, 0)
		}
		return 0
	case wmApp + 1:
		endSessionFlow(hwnd, func(b bool) {
			endBtn.busy = b
			endBtnRedraw()
		})
		return 0
	case wmTimer:
		// zawsze na wierzchu (np. nad przeglądarką na pełnym ekranie) i nad paskiem zadań po zmianie ekranu
		x, y := endBtnPlace()
		endBtn.win.x, endBtn.win.y = x, y
		procSetWindowPos.Call(hwnd, ^uintptr(0) /* HWND_TOPMOST */, uintptr(x), uintptr(y), 0, 0, swpNoSize|swpNoActivate)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}
