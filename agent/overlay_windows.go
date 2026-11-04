//go:build windows

package main

import (
	"fmt"
	"image"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Nakładka „Aktywne Wsparcie Techniczne” (Windows): przezroczyste okna warstwowe (UpdateLayeredWindow)
// zawsze na wierzchu, przepuszczające kliknięcia, wyłączone z przechwytywania obrazu — operator
// nie widzi ich w podglądzie. Żyją tyle, co proces pomocnika pulpitu (koniec sesji = koniec nakładki).

var (
	procRegisterClassExW         = user32.NewProc("RegisterClassExW")
	procCreateWindowExW          = user32.NewProc("CreateWindowExW")
	procDestroyWindow            = user32.NewProc("DestroyWindow")
	procDefWindowProcW           = user32.NewProc("DefWindowProcW")
	procUpdateLayeredWindow      = user32.NewProc("UpdateLayeredWindow")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procPeekMessageW             = user32.NewProc("PeekMessageW")
	procTranslateMessage         = user32.NewProc("TranslateMessage")
	procDispatchMessageW         = user32.NewProc("DispatchMessageW")
	procSetWindowDisplayAffinity = user32.NewProc("SetWindowDisplayAffinity")
	procGetWindowDisplayAffinity = user32.NewProc("GetWindowDisplayAffinity")
	procGetDpiForMonitor         = windows.NewLazySystemDLL("shcore.dll").NewProc("GetDpiForMonitor")
	procMonitorFromPoint         = user32.NewProc("MonitorFromPoint")
	procOpenDesktopW             = user32.NewProc("OpenDesktopW")
)

const (
	wsPopup            = 0x80000000
	wsExLayered        = 0x00080000
	wsExTransparent    = 0x00000020
	wsExTopmost        = 0x00000008
	wsExToolWindow     = 0x00000080
	wsExNoActivate     = 0x08000000
	ulwAlpha           = 0x2
	swShowNoActivate   = 4
	swpNoSize          = 0x0001
	swpNoMove          = 0x0002
	swpNoActivate      = 0x0010
	pmRemove           = 0x0001
	wdaExcludeCapture  = 0x00000011
	overlayFrame       = 50 * time.Millisecond
	overlayFadeIn      = 450 * time.Millisecond
	overlayRelayoutDur = 3 * time.Second
)

type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type winMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
	private uint32
}

type blendFunction struct {
	op, flags, alpha, format byte
}

// layerWin — jedno okno warstwowe z własnym buforem 32-bit (premultiplied BGRA).
type layerWin struct {
	hwnd, dc, bmp uintptr
	bits          []byte
	x, y, w, h    int
}

var overlayClass = windows.StringToUTF16Ptr("OVERVNCSupportOverlay")

func registerOverlayClass() {
	wc := wndClassEx{lpfnWndProc: windows.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
		r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
		return r
	}), lpszClassName: overlayClass}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	_, _, _ = procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
}

func newLayerWin(screenDC uintptr, x, y, w, h int) *layerWin {
	if w <= 0 || h <= 0 {
		return nil
	}
	hwnd, _, _ := procCreateWindowExW.Call(
		wsExLayered|wsExTransparent|wsExTopmost|wsExToolWindow|wsExNoActivate,
		uintptr(unsafe.Pointer(overlayClass)), 0, wsPopup,
		uintptr(x), uintptr(y), uintptr(w), uintptr(h), 0, 0, 0, 0)
	if hwnd == 0 {
		return nil
	}
	dc, _, _ := procCreateCompatibleDC.Call(screenDC)
	bmi := bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	bmi.Size = uint32(unsafe.Sizeof(bmi))
	var bits unsafe.Pointer
	bmp, _, _ := procCreateDIBSection.Call(screenDC, uintptr(unsafe.Pointer(&bmi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if dc == 0 || bmp == 0 || bits == nil {
		_, _, _ = procDestroyWindow.Call(hwnd)
		if dc != 0 {
			_, _, _ = procDeleteDC.Call(dc)
		}
		return nil
	}
	_, _, _ = procSelectObject.Call(dc, bmp)
	return &layerWin{hwnd: hwnd, dc: dc, bmp: bmp, bits: unsafe.Slice((*byte)(bits), w*h*4), x: x, y: y, w: w, h: h}
}

// update kopiuje obraz (RGBA premultiplied) do bufora BGRA i odświeża okno z przezroczystością `alpha`.
func (l *layerWin) update(screenDC uintptr, img *image.RGBA, alpha byte, y int) {
	src := img.Pix
	n := min(len(src), len(l.bits))
	for i := 0; i+3 < n; i += 4 {
		l.bits[i], l.bits[i+1], l.bits[i+2], l.bits[i+3] = src[i+2], src[i+1], src[i], src[i+3]
	}
	pt := struct{ x, y int32 }{int32(l.x), int32(y)}
	size := struct{ cx, cy int32 }{int32(l.w), int32(l.h)}
	zero := struct{ x, y int32 }{}
	bf := blendFunction{alpha: alpha, format: 1} // AC_SRC_ALPHA
	_, _, _ = procUpdateLayeredWindow.Call(l.hwnd, screenDC, uintptr(unsafe.Pointer(&pt)), uintptr(unsafe.Pointer(&size)),
		l.dc, uintptr(unsafe.Pointer(&zero)), 0, uintptr(unsafe.Pointer(&bf)), ulwAlpha)
}

func (l *layerWin) show() { _, _, _ = procShowWindow.Call(l.hwnd, swShowNoActivate) }

// excludeFromCapture — operator nie powinien widzieć ramki w podglądzie (Windows 10 2004+).
// Zwraca opis wyniku do diagnostyki: co Windows faktycznie ustawił.
func (l *layerWin) excludeFromCapture() string {
	r, _, e := procSetWindowDisplayAffinity.Call(l.hwnd, wdaExcludeCapture)
	var got uint32
	r2, _, e2 := procGetWindowDisplayAffinity.Call(l.hwnd, uintptr(unsafe.Pointer(&got)))
	res := fmt.Sprintf("%dx%d set=%d", l.w, l.h, r)
	if r == 0 {
		res += fmt.Sprintf(" (%v)", e)
	}
	if r2 != 0 {
		res += fmt.Sprintf(" affinity=%#x", got)
	} else {
		res += fmt.Sprintf(" get-failed (%v)", e2)
	}
	return res
}

// writeOverlayDiag — wynik ukrywania ramki przed przechwytywaniem (C:\ProgramData\OVERVNC\overlay.log).
func writeOverlayDiag(lines []string) {
	v := windows.RtlGetVersion()
	head := fmt.Sprintf("%s  Windows %d.%d.%d\r\n", time.Now().Format(time.RFC3339), v.MajorVersion, v.MinorVersion, v.BuildNumber)
	_ = os.WriteFile(filepath.Join(os.Getenv("ProgramData"), "OVERVNC", "overlay.log"), []byte(head+strings.Join(lines, "\r\n")+"\r\n"), 0o644)
}

func (l *layerWin) raise() {
	_, _, _ = procSetWindowPos.Call(l.hwnd, ^uintptr(0) /* HWND_TOPMOST */, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
}

func (l *layerWin) destroy() {
	_, _, _ = procDestroyWindow.Call(l.hwnd)
	_, _, _ = procDeleteObject.Call(l.bmp)
	_, _, _ = procDeleteDC.Call(l.dc)
}

// monitorScale — powiększenie ekranu (100% = 1.0) dla monitora zawierającego punkt.
func monitorScale(x, y int) float64 {
	if procGetDpiForMonitor.Find() != nil {
		return 1
	}
	pt := uintptr(uint32(int32(x))) | uintptr(uint32(int32(y)))<<32
	hmon, _, _ := procMonitorFromPoint.Call(pt, 2 /* MONITOR_DEFAULTTONEAREST */)
	var dx, dy uint32
	if r, _, _ := procGetDpiForMonitor.Call(hmon, 0, uintptr(unsafe.Pointer(&dx)), uintptr(unsafe.Pointer(&dy))); r != 0 || dx == 0 {
		return 1
	}
	return math.Max(1, float64(dx)/96)
}

func listMonitorsNow() []MonitorInfo {
	monitorsMu.Lock()
	defer monitorsMu.Unlock()
	monitorsAcc = nil
	_, _, _ = procEnumDisplayMonitors.Call(0, 0, monitorsCB, 0)
	return append([]MonitorInfo(nil), monitorsAcc...)
}

type overlayMon struct {
	m      MonitorInfo
	strips []overlayStrip
	wins   []*layerWin
	imgs   []*image.RGBA
	line   int
}

type overlayState struct {
	mons     []*overlayMon
	notch    *layerWin
	layout   *notchLayout
	notchMon MonitorInfo
	sig      string
}

func (s *overlayState) destroy() {
	for _, m := range s.mons {
		for _, w := range m.wins {
			if w != nil {
				w.destroy()
			}
		}
	}
	if s.notch != nil {
		s.notch.destroy()
	}
	*s = overlayState{}
}

func monitorsSig(ms []MonitorInfo) string {
	b := make([]byte, 0, 64)
	for _, m := range ms {
		b = append(b, []byte(m.Name)...)
		b = append(b, byte(m.X), byte(m.X>>8), byte(m.Y), byte(m.Y>>8), byte(m.W), byte(m.W>>8), byte(m.H), byte(m.H>>8))
	}
	return string(b)
}

func (s *overlayState) build(screenDC uintptr, name string, ms []MonitorInfo) {
	s.destroy()
	s.sig = monitorsSig(ms)
	for _, m := range ms {
		sc := monitorScale(m.X+m.W/2, m.Y+m.H/2)
		thick := int(math.Round(14 * sc))
		om := &overlayMon{m: m, line: int(math.Round(4 * sc))}
		om.strips = borderStrips(m.X, m.Y, m.W, m.H, thick)
		for _, st := range om.strips {
			om.wins = append(om.wins, newLayerWin(screenDC, st.X, st.Y, st.W, st.H))
			om.imgs = append(om.imgs, image.NewRGBA(image.Rect(0, 0, st.W, st.H)))
		}
		s.mons = append(s.mons, om)
		if m.Primary || s.layout == nil {
			s.notchMon = m
			s.layout = newNotchLayout(name, sc)
		}
	}
	if s.layout != nil {
		m := s.notchMon
		s.notch = newLayerWin(screenDC, m.X+(m.W-s.layout.W)/2, m.Y, s.layout.W, s.layout.H)
	}
}

// startSupportOverlay uruchamia nakładkę w osobnym wątku systemowym (z własną pętlą komunikatów).
func startSupportOverlay(name string) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				helperLogHook("nakładka wsparcia: błąd wewnętrzny")
			}
		}()
		runtime.LockOSThread()
		// zawsze zwykły pulpit użytkownika — wątek główny pomocnika przełącza się na ekran blokady/UAC
		if name16, err := windows.UTF16PtrFromString("Default"); err == nil {
			if h, _, _ := procOpenDesktopW.Call(uintptr(unsafe.Pointer(name16)), 0, 0, 0x01FF /* DESKTOP_ALL */); h != 0 {
				_, _, _ = procSetThreadDesktop.Call(h)
			}
		}
		registerOverlayClass()
		screenDC, _, _ := procGetDC.Call(0)
		defer procReleaseDC.Call(0, screenDC)

		var st overlayState
		st.build(screenDC, name, listMonitorsNow())
		start := time.Now()
		lastCheck, lastRaise := start, start
		shown := false
		var msg winMsg
		for {
			for {
				r, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, pmRemove)
				if r == 0 {
					break
				}
				_, _, _ = procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
				_, _, _ = procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
			}
			now := time.Now()
			// zmiana ekranów (rozdzielczość, podłączony monitor) — nowe okna
			if now.Sub(lastCheck) > overlayRelayoutDur {
				lastCheck = now
				if ms := listMonitorsNow(); monitorsSig(ms) != st.sig {
					st.build(screenDC, name, ms)
					shown = false
				}
			}
			t := now.Sub(start).Seconds()
			// wejście: płynne pojawienie się obrysu i „zjazd” notcha z góry
			k := math.Min(1, float64(now.Sub(start))/float64(overlayFadeIn))
			ease := 1 - math.Pow(1-k, 3)
			alpha := byte(255 * ease)
			for _, om := range st.mons {
				for i, s := range om.strips {
					if om.wins[i] == nil {
						continue
					}
					renderStrip(om.imgs[i], s, om.m.X, om.m.Y, om.m.W, om.m.H, om.line, t)
					om.wins[i].update(screenDC, om.imgs[i], alpha, om.wins[i].y)
				}
			}
			if st.notch != nil {
				m := st.notchMon
				per := float64(2*m.W + 2*m.H)
				x0 := float64(st.notch.x - m.X)
				img := renderNotch(st.layout, t, x0/per, (x0+float64(st.notch.w))/per)
				y := st.notch.y - int(float64(st.notch.h)*(1-ease))
				st.notch.update(screenDC, img, 255, y)
			}
			if !shown {
				var diag []string
				for _, om := range st.mons {
					for _, w := range om.wins {
						if w != nil {
							w.show()
							diag = append(diag, w.excludeFromCapture())
						}
					}
				}
				if st.notch != nil {
					st.notch.show()
					diag = append(diag, "notch "+st.notch.excludeFromCapture())
				}
				writeOverlayDiag(diag)
				shown = true
			}
			// inne okna „zawsze na wierzchu” (np. przeglądarka kiosku) nie mogą przykryć ramki
			if now.Sub(lastRaise) > 2*time.Second {
				lastRaise = now
				for _, om := range st.mons {
					for _, w := range om.wins {
						if w != nil {
							w.raise()
						}
					}
				}
				if st.notch != nil {
					st.notch.raise()
				}
			}
			time.Sleep(overlayFrame)
		}
	}()
}
