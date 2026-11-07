package main

import (
	"context"
	"errors"
	"fmt"
	"image"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Okienko z odliczaniem do zaplanowanego restartu / wyłączenia — `overvnc-agent power-notice action=… at=… msg=…`
// w sesji użytkownika (uruchamia je usługa, także gdy ktoś zaloguje się już po zaplanowaniu).

// runPowerNoticeService — usługa: okienko działa w sesji użytkownika, dopóki plan jest aktualny.
func runPowerNoticeService(ctx context.Context) {
	var proc windows.Handle
	running := ""
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	stop := func() {
		if proc != 0 {
			if processRunning(proc) {
				_ = windows.TerminateProcess(proc, 0)
			}
			windows.CloseHandle(proc)
			proc, running = 0, ""
		}
	}
	defer stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-powerNoticeNow:
		}
		p := currentPowerPending()
		if p == nil {
			stop()
			continue
		}
		key := fmt.Sprintf("%s|%d|%s", p.Action, p.At, p.Message)
		if proc != 0 && key == running && processRunning(proc) {
			continue
		}
		stop()
		args := []string{"power-notice", "action=" + p.Action, "at=" + strconv.FormatInt(p.At, 10)}
		if p.Message != "" {
			args = append(args, "msg="+p.Message)
		}
		if h, err := startAsConsoleUser(args...); err == nil { // nikt nie jest zalogowany — spróbujemy za chwilę
			proc, running = h, key
		}
	}
}

var pn struct {
	win       *layerWin
	screenDC  uintptr
	layout    pnLayout
	state     powerNoticeState
	at        time.Time
	hit       image.Rectangle // „Zwiń” albo plakietka (w obrazie)
	tracking  bool
	lastShown string
}

var pnClass = windows.StringToUTF16Ptr("OVERVNCPowerNotice")

func pnRedraw(force bool) {
	pn.state.Remaining = time.Until(pn.at)
	img, hit := renderPowerNotice(pn.layout, pn.state)
	key := fmt.Sprintf("%s|%v|%v", formatCountdown(pn.state.Remaining), pn.state.Collapsed, pn.state.Hover)
	if !force && key == pn.lastShown {
		return
	}
	pn.lastShown, pn.hit = key, hit
	pn.win.update(pn.screenDC, img, 255, pn.win.y)
}

func pnPlace() (x, y int) {
	_, _, r, b := workArea()
	m := int(16 * pn.layout.scale)
	return r - pn.layout.w - m, b - pn.layout.h - m
}

// runPowerNotice — proces w sesji użytkownika.
func runPowerNotice(args []string) int {
	var action, msg string
	var at int64
	for _, a := range args {
		k, v, _ := strings.Cut(a, "=")
		switch k {
		case "action":
			action = v
		case "at":
			at, _ = strconv.ParseInt(v, 10, 64)
		case "msg":
			msg = v
		}
	}
	if (action != "reboot" && action != "shutdown") || at == 0 {
		return 2
	}
	runtime.LockOSThread()
	name, _ := windows.UTF16PtrFromString(`Local\OVERVNC-PowerNotice`)
	if h, _, err := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name))); h == 0 || errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return 0 // już działa
	}
	setDpiAware()
	wc := wndClassEx{lpfnWndProc: windows.NewCallback(pnProc), lpszClassName: pnClass}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	pn.at = time.UnixMilli(at)
	pn.state = powerNoticeState{Action: action, Message: msg}
	pn.screenDC, _, _ = procGetDC.Call(0)
	_, _, r, b := workArea()
	pn.layout = powerNoticeLayout(monitorScale(r-10, b-10), msg)
	x, y := pnPlace()
	pn.win = newLayerWinEx(pn.screenDC, x, y, pn.layout.w, pn.layout.h, wsExLayered|wsExTopmost|wsExToolWindow|wsExNoActivate, pnClass)
	if pn.win == nil {
		return 1
	}
	pnRedraw(true)
	pn.win.show()
	procSetTimer.Call(pn.win.hwnd, 1, 250, 0)  // odliczanie
	procSetTimer.Call(pn.win.hwnd, 2, 2000, 0) // na wierzchu, położenie po zmianie ekranu

	var m winMsg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			return 0
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func pnPoint(lp uintptr) image.Point {
	return image.Pt(int(int16(lp&0xffff)), int(int16((lp>>16)&0xffff)))
}

func pnProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmMouseAct:
		return maNoActivate // klik nie zabiera fokusu z okna, w którym ktoś pisze
	case wmSetCursor:
		if pn.state.Hover {
			cur, _, _ := procLoadCursorW.Call(0, idcHand)
			procSetCursor.Call(cur)
			return 1
		}
	case wmMouseMove:
		if !pn.tracking {
			tme := struct {
				size, flags uint32
				hwnd        uintptr
				hover       uint32
			}{flags: 2 /* TME_LEAVE */, hwnd: hwnd}
			tme.size = uint32(unsafe.Sizeof(tme))
			procTrackMouseEvent.Call(uintptr(unsafe.Pointer(&tme)))
			pn.tracking = true
		}
		if h := pnPoint(lp).In(pn.hit); h != pn.state.Hover {
			pn.state.Hover = h
			pnRedraw(false)
		}
		return 0
	case wmMouseLeave:
		pn.tracking = false
		if pn.state.Hover {
			pn.state.Hover = false
			pnRedraw(false)
		}
		return 0
	case wmLButtonUp:
		if pnPoint(lp).In(pn.hit) {
			pn.state.Collapsed = !pn.state.Collapsed
			pn.state.Hover = false
			pnRedraw(true)
		}
		return 0
	case wmTimer:
		if wp == 2 {
			x, y := pnPlace()
			pn.win.x, pn.win.y = x, y
			procSetWindowPos.Call(hwnd, ^uintptr(0) /* HWND_TOPMOST */, uintptr(x), uintptr(y), 0, 0, swpNoSize|swpNoActivate)
			pnRedraw(true)
			return 0
		}
		// po terminie (z zapasem) system już się zamyka — albo ktoś anulował restart na komputerze
		if time.Since(pn.at) > powerPendingGrace {
			os.Exit(0)
		}
		if pn.state.Collapsed && time.Until(pn.at) <= pnUrgent {
			pn.state.Collapsed = false // ostatnia minuta: rozwinięte
		}
		pnRedraw(false)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}
