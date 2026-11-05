//go:build darwin

package main

import (
	"context"
	"fmt"
	"image"
	"io"
	"math"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// Ramka „Aktywne Wsparcie Techniczne” na macOS: okna AppKit bez ramek nad wszystkim (przepuszczają
// kliknięcia, na wszystkich biurkach i nad aplikacjami pełnoekranowymi). Rysuje je proces
// „desktop-overlay” zalogowanego użytkownika, zamykany razem z sesją pulpitu. Z podglądu operatora
// usuwa je filtr ScreenCaptureKit (okna o tytule overlayWindowTitle). MacBook z wycięciem na kamerę:
// nasz notch jest jego przedłużeniem — napis pod kamerą.

// AppKit wymaga głównego wątku — główna gorutyna zostaje na nim przez cały czas działania programu.
func init() { runtime.LockOSThread() }

const overlayWindowTitle = "OVERVNC-AktywneWsparcie"

type nsRect struct{ X, Y, W, H float64 }
type nsInsets struct{ Top, Left, Bottom, Right float64 }

var (
	cfDataCreate            func(alloc uintptr, bytes *byte, length int) uintptr
	cgDataProviderWithData  func(data uintptr) uintptr
	cgColorSpaceDeviceRGB   func() uintptr
	cgImageCreate           func(w, h, bpc, bpp, stride uintptr, cs uintptr, info uint32, provider uintptr, decode uintptr, interpolate bool, intent int32) uintptr
	cgDataProviderRelease   func(p uintptr)
	cgColorSpaceRelease     func(cs uintptr)
	overlayLibsOnce         sync.Once
	overlayLibsErr          error
	nsDefaultRunLoopModeStr objc.ID
)

func loadOverlayLibs() error {
	overlayLibsOnce.Do(func() {
		if err := loadCG(); err != nil {
			overlayLibsErr = err
			return
		}
		for _, lib := range []string{"/System/Library/Frameworks/AppKit.framework/AppKit", "/System/Library/Frameworks/QuartzCore.framework/QuartzCore"} {
			if _, err := purego.Dlopen(lib, purego.RTLD_NOW|purego.RTLD_GLOBAL); err != nil {
				overlayLibsErr = err
				return
			}
		}
		cg, _ := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		cf, _ := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		purego.RegisterLibFunc(&cfDataCreate, cf, "CFDataCreate")
		purego.RegisterLibFunc(&cgDataProviderWithData, cg, "CGDataProviderCreateWithCFData")
		purego.RegisterLibFunc(&cgColorSpaceDeviceRGB, cg, "CGColorSpaceCreateDeviceRGB")
		purego.RegisterLibFunc(&cgImageCreate, cg, "CGImageCreate")
		purego.RegisterLibFunc(&cgDataProviderRelease, cg, "CGDataProviderRelease")
		purego.RegisterLibFunc(&cgColorSpaceRelease, cg, "CGColorSpaceRelease")
		mode := []byte("kCFRunLoopDefaultMode\x00") // wartość NSDefaultRunLoopMode
		nsDefaultRunLoopModeStr = nsString(mode)
	})
	return overlayLibsErr
}

func nsString(cstr []byte) objc.ID {
	s := objc.ID(objc.GetClass("NSString")).Send(sel("stringWithUTF8String:"), &cstr[0])
	return s.Send(sel("retain"))
}

// cgImageFromRGBA — obraz CoreGraphics z bufora RGBA (premultiplied) — kopia danych (CFData).
func cgImageFromRGBA(img *image.RGBA) uintptr {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	if w == 0 || h == 0 {
		return 0
	}
	data := cfDataCreate(0, &img.Pix[0], len(img.Pix))
	if data == 0 {
		return 0
	}
	defer cfRelease(data)
	prov := cgDataProviderWithData(data)
	defer cgDataProviderRelease(prov)
	cs := cgColorSpaceDeviceRGB()
	defer cgColorSpaceRelease(cs)
	// kCGImageAlphaPremultipliedLast, kolejność bajtów R,G,B,A
	return cgImageCreate(uintptr(w), uintptr(h), 8, 32, uintptr(img.Stride), cs, 1, prov, 0, false, 0)
}

// overlayWin — okno AppKit z obrazem w warstwie (contents = CGImage).
type overlayWin struct {
	win   objc.ID
	layer objc.ID
	img   uintptr
}

func newOverlayWin(frame nsRect, scale float64) *overlayWin {
	if frame.W <= 0 || frame.H <= 0 {
		return nil
	}
	w := objc.ID(objc.GetClass("NSWindow")).Send(sel("alloc")).Send(sel("initWithContentRect:styleMask:backing:defer:"), frame, uint(0), uint(2), false)
	if w == 0 {
		return nil
	}
	w.Send(sel("setReleasedWhenClosed:"), false)
	w.Send(sel("setOpaque:"), false)
	w.Send(sel("setBackgroundColor:"), objc.ID(objc.GetClass("NSColor")).Send(sel("clearColor")))
	w.Send(sel("setHasShadow:"), false)
	w.Send(sel("setIgnoresMouseEvents:"), true)
	w.Send(sel("setLevel:"), 1000)                           // NSScreenSaverWindowLevel — nad paskiem menu i aplikacjami
	w.Send(sel("setCollectionBehavior:"), uint(1|16|64|256)) // wszystkie biurka, nieruchome, poza Cmd+Tab, nad pełnym ekranem
	if os.Getenv("OVERVNC_OVERLAY_VISIBLE") != "1" {         // test wyglądu: ramka widoczna na zrzutach
		w.Send(sel("setSharingType:"), uint(0)) // NSWindowSharingNone (dodatkowo filtr ScreenCaptureKit)
	}
	title := []byte(overlayWindowTitle + "\x00")
	w.Send(sel("setTitle:"), nsString(title))
	view := w.Send(sel("contentView"))
	view.Send(sel("setWantsLayer:"), true)
	layer := view.Send(sel("layer"))
	layer.Send(sel("setContentsScale:"), scale)
	layer.Send(sel("setContentsGravity:"), nsString([]byte("topLeft\x00"))) // bez przeskalowania obrazu
	w.Send(sel("setAlphaValue:"), 0.0)
	w.Send(sel("orderFrontRegardless"))
	return &overlayWin{win: w, layer: layer}
}

func (o *overlayWin) set(img *image.RGBA) {
	ci := cgImageFromRGBA(img)
	if ci == 0 {
		return
	}
	o.layer.Send(sel("setContents:"), objc.ID(ci))
	if o.img != 0 {
		cgImageRelease(o.img)
	}
	o.img = ci
}

func (o *overlayWin) close() {
	o.win.Send(sel("orderOut:"), objc.ID(0))
	o.win.Send(sel("close"))
	if o.img != 0 {
		cgImageRelease(o.img)
	}
}

type macOverlayScreen struct {
	frame  nsRect // punkty, układ Cocoa (y w górę)
	scale  float64
	strips []overlayStrip // piksele, układ od lewego górnego rogu ekranu
	wins   []*overlayWin
	imgs   []*image.RGBA
	notch  *overlayWin
	layout *notchLayout
	nimg   *image.RGBA
}

// runOverlayProcess — „desktop-overlay <nazwa>”: ramka do końca procesu (agent zamyka stdin).
func runOverlayProcess(name string) int {
	if err := loadOverlayLibs(); err != nil {
		return 1
	}
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}()
	app := objc.ID(objc.GetClass("NSApplication")).Send(sel("sharedApplication"))
	app.Send(sel("setActivationPolicy:"), 1) // NSApplicationActivationPolicyAccessory — bez ikony w Docku
	app.Send(sel("finishLaunching"))

	var screens []*macOverlayScreen
	var sig string
	build := func() {
		for _, s := range screens {
			for _, w := range s.wins {
				if w != nil {
					w.close()
				}
			}
			if s.notch != nil {
				s.notch.close()
			}
		}
		screens = nil
		list := objc.ID(objc.GetClass("NSScreen")).Send(sel("screens"))
		n := objc.Send[uint](list, sel("count"))
		sig = screensSig(list, n)
		// notch: ekran z wycięciem na kamerę (MacBook), a bez niego — główny ekran (z paskiem menu)
		notchAt := uint(0)
		for i := range n {
			if objc.Send[nsInsets](list.Send(sel("objectAtIndex:"), i), sel("safeAreaInsets")).Top > 0 {
				notchAt = i
				break
			}
		}
		for i := range n {
			ns := list.Send(sel("objectAtIndex:"), i)
			f := objc.Send[nsRect](ns, sel("frame"))
			sc := math.Max(1, objc.Send[float64](ns, sel("backingScaleFactor")))
			s := &macOverlayScreen{frame: f, scale: sc}
			wpx, hpx := int(f.W*sc), int(f.H*sc)
			thickPt := 14.0
			thick := int(thickPt * sc)
			s.strips = borderStrips(0, 0, wpx, hpx, thick)
			for _, st := range s.strips {
				// piksele (od góry) → punkty Cocoa (od dołu)
				r := nsRect{X: f.X + float64(st.X)/sc, Y: f.Y + f.H - float64(st.Y+st.H)/sc, W: float64(st.W) / sc, H: float64(st.H) / sc}
				s.wins = append(s.wins, newOverlayWin(r, sc))
				s.imgs = append(s.imgs, image.NewRGBA(image.Rect(0, 0, st.W, st.H)))
			}
			in := objc.Send[nsInsets](ns, sel("safeAreaInsets"))
			hasHW := in.Top > 0
			if i == notchAt {
				var lay *notchLayout
				if hasHW {
					l := objc.Send[nsRect](ns, sel("auxiliaryTopLeftArea"))
					r := objc.Send[nsRect](ns, sel("auxiliaryTopRightArea"))
					hw := (f.W - l.W - r.W) * sc // szerokość wycięcia (px)
					lay = newNotchLayoutFor(name, sc, hw+2*14*sc+2*28*sc, in.Top*sc)
				} else {
					lay = newNotchLayout(name, sc)
				}
				// rozmiar i położenie w pełnych pikselach ekranu — inaczej macOS rozmywa obraz o pół piksela
				if k := int(sc); k > 1 {
					lay.W += (k - lay.W%k) % k
					lay.H += (k - lay.H%k) % k
				}
				xpx := math.Round((f.W*sc - float64(lay.W)) / 2)
				wpt, hpt := float64(lay.W)/sc, float64(lay.H)/sc
				s.notch = newOverlayWin(nsRect{X: f.X + xpx/sc, Y: f.Y + f.H - hpt, W: wpt, H: hpt}, sc)
				s.layout = lay
			}
			screens = append(screens, s)
		}
	}
	build()

	start := time.Now()
	lastCheck := start
	pool := objc.GetClass("NSAutoreleasePool")
	for {
		p := objc.ID(pool).Send(sel("alloc")).Send(sel("init"))
		until := objc.ID(objc.GetClass("NSDate")).Send(sel("dateWithTimeIntervalSinceNow:"), 0.05)
		for {
			ev := app.Send(sel("nextEventMatchingMask:untilDate:inMode:dequeue:"), ^uint(0), until, nsDefaultRunLoopModeStr, true)
			if ev == 0 {
				break
			}
			app.Send(sel("sendEvent:"), ev)
			until = objc.ID(objc.GetClass("NSDate")).Send(sel("distantPast"))
		}
		now := time.Now()
		if now.Sub(lastCheck) > 3*time.Second {
			lastCheck = now
			list := objc.ID(objc.GetClass("NSScreen")).Send(sel("screens"))
			if screensSig(list, objc.Send[uint](list, sel("count"))) != sig {
				build() // zmiana monitorów albo rozdzielczości
			}
		}
		t := now.Sub(start).Seconds()
		k := math.Min(1, t/0.45)
		ease := 1 - math.Pow(1-k, 3)
		for _, s := range screens {
			wpx, hpx := int(s.frame.W*s.scale), int(s.frame.H*s.scale)
			for i, st := range s.strips {
				if s.wins[i] == nil {
					continue
				}
				renderStrip(s.imgs[i], st, 0, 0, wpx, hpx, int(4*s.scale), t)
				s.wins[i].set(s.imgs[i])
				s.wins[i].win.Send(sel("setAlphaValue:"), ease)
			}
			if s.notch != nil {
				per := float64(2*wpx + 2*hpx)
				x0 := float64(wpx-s.layout.W) / 2
				s.notch.set(renderNotch(s.layout, t, x0/per, (x0+float64(s.layout.W))/per))
				s.notch.win.Send(sel("setAlphaValue:"), ease)
			}
		}
		p.Send(sel("drain"))
	}
}

// screensSig — układ ekranów (położenie, rozmiar, skala); zmiana = nowe okna ramki.
func screensSig(list objc.ID, n uint) string {
	out := ""
	for i := range n {
		ns := list.Send(sel("objectAtIndex:"), i)
		f := objc.Send[nsRect](ns, sel("frame"))
		out += fmt.Sprintf("%v,%v,%v,%v,%v;", f.X, f.Y, f.W, f.H, objc.Send[float64](ns, sel("backingScaleFactor")))
	}
	return out
}

// ---------- uruchamianie przez agenta ----------

type macOverlayProc struct {
	cmd  *exec.Cmd
	in   io.WriteCloser
	once sync.Once
}

func (o *macOverlayProc) stop() {
	o.once.Do(func() {
		_ = o.in.Close() // proces kończy się sam po zamknięciu stdin
		go func() {
			done := make(chan struct{})
			go func() { _ = o.cmd.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				_ = o.cmd.Process.Kill()
			}
		}()
	})
}

// startSupportOverlay — ramka jako proces zalogowanego użytkownika (w jego sesji graficznej).
func startSupportOverlay(name string) interface{ stop() } {
	if desktopTestMode() {
		return nil
	}
	exe, err := executablePath()
	if err != nil {
		return nil
	}
	cmd, err := asConsoleUser(context.Background(), exe, "desktop-overlay", cleanOverlayName(name))
	if err != nil {
		return nil
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil
	}
	if err := cmd.Start(); err != nil {
		return nil
	}
	return &macOverlayProc{cmd: cmd, in: in}
}
