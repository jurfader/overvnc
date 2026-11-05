//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// Pulpit zdalny na macOS: obraz z CoreGraphics (CGDisplayCreateImage), wejście przez CGEvent.
// Biblioteki systemowe wołane przez purego — bez cgo, agent nadal budowany jednym poleceniem.
//
// Pomocnik działa w sesji graficznej zalogowanego użytkownika (launchctl asuser). macOS wymaga zgód
// dla /usr/local/bin/overvnc-agent: „Nagrywanie ekranu” (obraz) i „Dostępność” (mysz i klawiatura).

func init() { pasteModifier = "MetaLeft" }

func desktopSupported() bool { return true }

type cgPoint struct{ X, Y float64 }
type cgSize struct{ W, H float64 }
type cgRect struct {
	Origin cgPoint
	Size   cgSize
}

var (
	cgOnce sync.Once
	cgErr  error

	cgGetActiveDisplayList         func(max uint32, displays *uint32, count *uint32) int32
	cgMainDisplayID                func() uint32
	cgDisplayBounds                func(id uint32) cgRect
	cgDisplayIsBuiltin             func(id uint32) bool
	cgDisplayCreateImage           func(id uint32) uintptr
	cgImageGetWidth                func(img uintptr) uintptr
	cgImageGetHeight               func(img uintptr) uintptr
	cgImageGetBytesPerRow          func(img uintptr) uintptr
	cgImageGetBitsPerPixel         func(img uintptr) uintptr
	cgImageGetBitmapInfo           func(img uintptr) uint32
	cgImageGetDataProvider         func(img uintptr) uintptr
	cgDataProviderCopyData         func(provider uintptr) uintptr
	cgImageRelease                 func(img uintptr)
	cfDataGetBytePtr               func(data uintptr) *byte
	cfDataGetLength                func(data uintptr) int
	cfRelease                      func(ref uintptr)
	cgEventCreate                  func(source uintptr) uintptr
	cgEventGetLocation             func(ev uintptr) cgPoint
	cgEventCreateMouseEvent        func(source uintptr, typ uint32, p cgPoint, button uint32) uintptr
	cgEventCreateKeyboardEvent     func(source uintptr, key uint16, down bool) uintptr
	cgEventCreateScrollWheelEvent2 func(source uintptr, units uint32, count uint32, w1, w2, w3 int32) uintptr
	cgEventSetFlags                func(ev uintptr, flags uint64)
	cgEventSetIntegerValueField    func(ev uintptr, field uint32, value int64)
	cgEventPost                    func(tap uint32, ev uintptr)
	cgPreflightScreenCaptureAccess func() bool
	cgRequestScreenCaptureAccess   func() bool
	axIsProcessTrusted             func() bool
	axIsProcessTrustedWithOptions  func(options uintptr) bool
)

func loadCG() error {
	cgOnce.Do(func() {
		cg, err := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			cgErr = err
			return
		}
		cf, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			cgErr = err
			return
		}
		as, err := purego.Dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			cgErr = err
			return
		}
		defer func() {
			if r := recover(); r != nil {
				cgErr = fmt.Errorf("CoreGraphics: %v", r)
			}
		}()
		reg := purego.RegisterLibFunc
		reg(&cgGetActiveDisplayList, cg, "CGGetActiveDisplayList")
		reg(&cgMainDisplayID, cg, "CGMainDisplayID")
		reg(&cgDisplayBounds, cg, "CGDisplayBounds")
		reg(&cgDisplayIsBuiltin, cg, "CGDisplayIsBuiltin")
		reg(&cgDisplayCreateImage, cg, "CGDisplayCreateImage")
		reg(&cgImageGetWidth, cg, "CGImageGetWidth")
		reg(&cgImageGetHeight, cg, "CGImageGetHeight")
		reg(&cgImageGetBytesPerRow, cg, "CGImageGetBytesPerRow")
		reg(&cgImageGetBitsPerPixel, cg, "CGImageGetBitsPerPixel")
		reg(&cgImageGetBitmapInfo, cg, "CGImageGetBitmapInfo")
		reg(&cgImageGetDataProvider, cg, "CGImageGetDataProvider")
		reg(&cgDataProviderCopyData, cg, "CGDataProviderCopyData")
		reg(&cgImageRelease, cg, "CGImageRelease")
		reg(&cfDataGetBytePtr, cf, "CFDataGetBytePtr")
		reg(&cfDataGetLength, cf, "CFDataGetLength")
		reg(&cfRelease, cf, "CFRelease")
		reg(&cgEventCreate, cg, "CGEventCreate")
		reg(&cgEventGetLocation, cg, "CGEventGetLocation")
		reg(&cgEventCreateMouseEvent, cg, "CGEventCreateMouseEvent")
		reg(&cgEventCreateKeyboardEvent, cg, "CGEventCreateKeyboardEvent")
		reg(&cgEventCreateScrollWheelEvent2, cg, "CGEventCreateScrollWheelEvent2")
		reg(&cgEventSetFlags, cg, "CGEventSetFlags")
		reg(&cgEventSetIntegerValueField, cg, "CGEventSetIntegerValueField")
		reg(&cgEventPost, cg, "CGEventPost")
		reg(&cgPreflightScreenCaptureAccess, cg, "CGPreflightScreenCaptureAccess")
		reg(&cgRequestScreenCaptureAccess, cg, "CGRequestScreenCaptureAccess")
		reg(&axIsProcessTrusted, as, "AXIsProcessTrusted")
		reg(&axIsProcessTrustedWithOptions, as, "AXIsProcessTrustedWithOptions")
	})
	return cgErr
}

// ---------- uruchomienie w sesji użytkownika ----------

// consoleUID — użytkownik przy ekranie (właściciel /dev/console); 0 = nikt (okno logowania).
func consoleUID() (int, string) {
	fi, err := os.Stat("/dev/console")
	if err != nil {
		return 0, ""
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Uid == 0 {
		return 0, ""
	}
	u, err := user.LookupId(strconv.Itoa(int(st.Uid)))
	if err != nil {
		return 0, ""
	}
	return int(st.Uid), u.Username
}

// spawnDesktopHelper — pomocnik w sesji graficznej użytkownika (launchctl asuser): tylko tam działa
// połączenie z serwerem okien. Proces dziedziczy uprawnienia agenta (root) — jak SYSTEM na Windows.
func spawnDesktopHelper(args ...string) (helperProc, error) {
	if desktopTestMode() || os.Geteuid() != 0 {
		return spawnPlainHelper(args...)
	}
	uid, _ := consoleUID()
	if uid == 0 {
		return nil, errors.New("nikt nie jest zalogowany na tym Macu (ekran logowania)")
	}
	// rzeczywista ścieżka w pakiecie „OVERVNC Agent.app” (nie dowiązanie z /usr/local/bin)
	exe, err := executablePath()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("/bin/launchctl", append([]string{"asuser", strconv.Itoa(uid), exe, "desktop-helper"}, args...)...)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start pomocnika: %w", err)
	}
	return &execHelper{cmd: cmd, in: in, out: out}, nil
}

// asConsoleUser — polecenie w sesji i z kontem użytkownika przy ekranie (osascript, komunikaty).
func asConsoleUser(ctx context.Context, name string, args ...string) (*exec.Cmd, error) {
	uid, username := consoleUID()
	if uid == 0 {
		return nil, errors.New("nikt nie jest zalogowany")
	}
	if os.Geteuid() != 0 {
		return exec.CommandContext(ctx, name, args...), nil
	}
	return exec.CommandContext(ctx, "/bin/launchctl", append([]string{"asuser", strconv.Itoa(uid), "/usr/bin/sudo", "-u", username, "--", name}, args...)...), nil
}

func appleScriptString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// askDesktopConsent: none — bez komunikatu, notify — powiadomienie, ask — okno Tak/Nie (30 s, brak odpowiedzi = odmowa).
func askDesktopConsent(mode, viewer string) (bool, error) {
	if desktopTestMode() || mode == "" || mode == "none" {
		return true, nil
	}
	who := cleanOverlayName(viewer)
	if who == "" {
		who = "Administrator"
	}
	switch mode {
	case "notify":
		// bez powiadomienia — przez całą sesję widać ramkę „Aktywne Wsparcie Techniczne” (overlay_darwin.go)
		return true, nil
	case "ask":
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()
		cmd, err := asConsoleUser(ctx, "/usr/bin/osascript", "-e",
			"display dialog "+appleScriptString(who+" chce połączyć się zdalnie z tym komputerem i widzieć ekran.\n\nCzy zezwolić?")+
				` with title "OVERVNC" buttons {"Nie", "Tak"} default button "Nie" cancel button "Nie" giving up after 30 with icon caution`)
		if err != nil {
			return false, protoErr("consent_failed", "nie można zapytać użytkownika o zgodę: %v", err)
		}
		out, _ := cmd.Output()
		return strings.Contains(string(out), "button returned:Tak") && !strings.Contains(string(out), "gave up:true"), nil
	}
	return false, protoErr("bad_request", "nieznany tryb zgody %q", mode)
}

// showScreenMessage — okno komunikatu u użytkownika (bez czekania na zamknięcie).
func showScreenMessage(title, text string, seconds int) error {
	if desktopTestMode() {
		logger.Infof("komunikat na ekranie (%d s): %s — %s", seconds, title, text)
		return nil
	}
	cmd, err := asConsoleUser(context.Background(), "/usr/bin/osascript", "-e",
		"display dialog "+appleScriptString(text)+" with title "+appleScriptString(title)+` buttons {"OK"} default button "OK" giving up after `+strconv.Itoa(seconds)+" with icon note")
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// ---------- przechwytywanie i wejście ----------

type macBackend struct {
	ids      []uint32
	out      []byte
	cursorOn bool
	// wejście
	buttons    [3]bool
	flags      uint64
	lastDown   time.Time
	lastDownAt cgPoint
	lastButton int
	clicks     int64
	asked      bool
	// ScreenCaptureKit (strumień) — zapasowo CoreGraphics na starszych systemach
	sck        *sckStream
	sckFailed  bool      // ScreenCaptureKit niedostępny (macOS < 12.3) — zapasowo CoreGraphics
	sckRetryAt time.Time // ponowny start strumienia po błędzie (bez przechodzenia na CoreGraphics)
	lastSeq    uint64
	force      bool
	lastCursor cgPoint
	screenOK   bool
	lastPerm   time.Time
	lastExcl   time.Time // ostatnie sprawdzenie okien ramki wsparcia do wyłączenia z obrazu
}

// invalidate — pełna klatka na żądanie przeglądarki, także bez zmian na ekranie.
func (b *macBackend) invalidate() { b.force = true }

// screenAllowed — zgoda „Nagrywanie ekranu” (sprawdzana co 2 s). Bez niej nie przechwytujemy wcale:
// każda próba na nowym macOS wyświetlałaby użytkownikowi kolejne okno z pytaniem.
func (b *macBackend) screenAllowed() bool {
	if time.Since(b.lastPerm) > 2*time.Second {
		b.screenOK, b.lastPerm = cgPreflightScreenCaptureAccess(), time.Now()
	}
	return b.screenOK
}

func cursorPos() (cgPoint, bool) {
	ev := cgEventCreate(0)
	if ev == 0 {
		return cgPoint{}, false
	}
	p := cgEventGetLocation(ev)
	cfRelease(ev)
	return p, true
}

func (b *macBackend) captureSCK(m MonitorInfo) ([]byte, int, int, error) {
	s := b.sck
	moved := false
	if b.cursorOn {
		if p, ok := cursorPos(); ok && p != b.lastCursor {
			b.lastCursor, moved = p, true
		}
	}
	s.mu.Lock()
	if s.seq == 0 || (s.seq == b.lastSeq && !b.force && !moved) {
		s.mu.Unlock()
		return nil, 0, 0, errNoChange
	}
	need := m.W * m.H * 4
	if cap(b.out) < need {
		b.out = make([]byte, need)
	}
	b.out = b.out[:need]
	copy(b.out, s.front)
	b.lastSeq = s.seq
	s.mu.Unlock()
	b.force = false
	if b.cursorOn {
		b.drawCursor(b.out, m)
	}
	return b.out, m.W, m.H, nil
}

func newDesktopBackend(_ bool) (desktopBackend, error) {
	if desktopTestMode() {
		return newSyntheticBackend(), nil
	}
	if err := loadCG(); err != nil {
		return nil, fmt.Errorf("CoreGraphics: %w", err)
	}
	b := &macBackend{cursorOn: true}
	// pierwsze połączenie: macOS pokaże użytkownikowi prośbę o zgodę na nagrywanie ekranu
	if !cgPreflightScreenCaptureAccess() {
		cgRequestScreenCaptureAccess()
		b.asked = true
	}
	// bez zgody „Dostępność” sterowanie nie działa — macOS pokaże okno z przyciskiem „Otwórz Ustawienia systemowe”
	if !axIsProcessTrusted() {
		requestAccessibilityPrompt()
	}
	return b, nil
}

// requestAccessibilityPrompt — systemowa prośba o zgodę „Dostępność” (AXIsProcessTrustedWithOptions
// z kAXTrustedCheckOptionPrompt = true). Klucz to stała CFString „AXTrustedCheckOptionPrompt”.
func requestAccessibilityPrompt() {
	defer func() { _ = recover() }() // brak Foundation albo zmiana API — nie przerywa sesji
	if _, err := purego.Dlopen("/System/Library/Frameworks/Foundation.framework/Foundation", purego.RTLD_NOW|purego.RTLD_GLOBAL); err != nil {
		return
	}
	name := []byte("AXTrustedCheckOptionPrompt\x00")
	key := objc.ID(objc.GetClass("NSString")).Send(sel("stringWithUTF8String:"), &name[0])
	val := objc.ID(objc.GetClass("NSNumber")).Send(sel("numberWithBool:"), true)
	opts := objc.ID(objc.GetClass("NSDictionary")).Send(sel("dictionaryWithObject:forKey:"), val, key)
	if opts != 0 {
		axIsProcessTrustedWithOptions(uintptr(opts))
	}
}

func (b *macBackend) notice() string {
	var n []string
	if !cgPreflightScreenCaptureAccess() {
		n = append(n, "screen")
	}
	if !axIsProcessTrusted() {
		n = append(n, "input")
	}
	return strings.Join(n, ",")
}

func (b *macBackend) monitors() ([]MonitorInfo, string) {
	var ids [16]uint32
	var n uint32
	if cgGetActiveDisplayList(16, &ids[0], &n) != 0 || n == 0 {
		return nil, "Default"
	}
	main := cgMainDisplayID()
	b.ids = b.ids[:0]
	var out []MonitorInfo
	for i := range int(n) {
		id := ids[i]
		r := cgDisplayBounds(id)
		name := fmt.Sprintf("Ekran %d", i+1)
		if cgDisplayIsBuiltin(id) {
			name = "Wbudowany"
		}
		b.ids = append(b.ids, id)
		out = append(out, MonitorInfo{
			Index: i, X: int(r.Origin.X), Y: int(r.Origin.Y), W: int(r.Size.W), H: int(r.Size.H),
			Primary: id == main, Name: name,
		})
	}
	return out, "Default"
}

// capture: obraz ekranu w rozdzielczości punktowej (Retina: każdy piksel obrazu = 2×2 piksele ekranu).
func (b *macBackend) capture(m MonitorInfo) ([]byte, int, int, error) {
	if m.Index < 0 || m.Index >= len(b.ids) || m.W <= 0 || m.H <= 0 {
		return nil, 0, 0, errors.New("brak monitora")
	}
	if !b.screenAllowed() {
		if b.sck != nil {
			b.sck.stop()
			b.sck = nil
		}
		return nil, 0, 0, errNoChange // panel pokazuje instrukcję (notice)
	}
	id := b.ids[m.Index]
	if !b.sckFailed {
		if s := b.sck; s == nil || s.display != id || s.w != m.W || s.h != m.H {
			if s != nil {
				s.stop()
				b.sck = nil
			}
			if time.Now().Before(b.sckRetryAt) {
				return nil, 0, 0, errNoChange
			}
			if err := loadSCK(); err != nil {
				// tylko brak ScreenCaptureKit przełącza na CoreGraphics — ono na nowym macOS pytałoby co klatkę
				b.sckFailed = true
				helperLogHook(fmt.Sprintf("przechwytywanie ekranu: ScreenCaptureKit niedostępny (%v) — CoreGraphics", err))
			} else if ns, err := startSCK(id, m.W, m.H); err != nil {
				b.sckRetryAt = time.Now().Add(3 * time.Second)
				return nil, 0, 0, errNoChange
			} else {
				b.sck, b.lastSeq = ns, 0
			}
		}
		if b.sck != nil {
			if e := b.sck.startErr.Load(); e != nil {
				// system odmówił (np. „Otwórz Ustawienia” zamiast „Zezwól”) — ponowna próba za chwilę
				go b.sck.stop()
				b.sck = nil
				b.sckRetryAt = time.Now().Add(5 * time.Second)
				return nil, 0, 0, errNoChange
			}
			// ramka wsparcia nie może trafić do podglądu operatora — sprawdzenie zaraz po starcie i co 2 s
			if since := time.Since(b.lastExcl); since > 2*time.Second || (b.lastSeq <= 1 && since > 700*time.Millisecond) {
				b.lastExcl = time.Now()
				b.sck.refreshExclusions()
			}
			return b.captureSCK(m)
		}
	}
	img := cgDisplayCreateImage(id)
	if img == 0 {
		return nil, 0, 0, errors.New("nie można przechwycić ekranu (Mac zablokowany albo brak zgody na nagrywanie)")
	}
	defer cgImageRelease(img)
	iw, ih := int(cgImageGetWidth(img)), int(cgImageGetHeight(img))
	stride := int(cgImageGetBytesPerRow(img))
	if int(cgImageGetBitsPerPixel(img)) != 32 || iw <= 0 || ih <= 0 {
		return nil, 0, 0, errors.New("nieobsługiwany format obrazu ekranu")
	}
	data := cgDataProviderCopyData(cgImageGetDataProvider(img))
	if data == 0 {
		return nil, 0, 0, errors.New("brak danych obrazu")
	}
	defer cfRelease(data)
	n := cfDataGetLength(data)
	if n < stride*(ih-1)+iw*4 {
		return nil, 0, 0, errors.New("niepełne dane obrazu")
	}
	src := unsafe.Slice(cfDataGetBytePtr(data), n)
	info := cgImageGetBitmapInfo(img)
	// kCGBitmapByteOrder32Little + alfa pierwsza = w pamięci B,G,R,A (typowe); inaczej A,R,G,B
	bgra := info&0x7000 == 0x2000

	w, h := m.W, m.H
	if need := w * h * 4; cap(b.out) < need {
		b.out = make([]byte, need)
	} else {
		b.out = b.out[:need]
	}
	dst := b.out
	sx, sy := float64(iw)/float64(w), float64(ih)/float64(h)
	exact2 := iw == 2*w && ih == 2*h
	for y := range h {
		row := dst[y*w*4 : (y+1)*w*4]
		if exact2 {
			// Retina: średnia z 2×2 pikseli — ostry tekst bez migotania
			r0 := src[2*y*stride:]
			r1 := src[(2*y+1)*stride:]
			for x := range w {
				o := x * 8
				for c := range 4 {
					row[x*4+c] = byte((int(r0[o+c]) + int(r0[o+4+c]) + int(r1[o+c]) + int(r1[o+4+c]) + 2) >> 2)
				}
			}
		} else {
			srow := src[min(ih-1, int(float64(y)*sy))*stride:]
			for x := range w {
				o := min(iw-1, int(float64(x)*sx)) * 4
				copy(row[x*4:x*4+4], srow[o:o+4])
			}
		}
		if !bgra {
			for x := 0; x < len(row); x += 4 {
				a, r, g, bl := row[x], row[x+1], row[x+2], row[x+3]
				row[x], row[x+1], row[x+2], row[x+3] = bl, g, r, a
			}
		}
	}
	if b.cursorOn {
		b.drawCursor(dst, m)
	}
	return dst, w, h, nil
}

// kursor nie jest częścią obrazu ekranu — dorysowujemy prostą strzałkę (gdy przeglądarka nie rysuje własnego)
var cursorArrow = []string{
	"X",
	"XX",
	"X.X",
	"X..X",
	"X...X",
	"X....X",
	"X.....X",
	"X......X",
	"X.......X",
	"X........X",
	"X.....XXXXX",
	"X..X..X",
	"X.X X..X",
	"XX  X..X",
	"X    X..X",
	"     X..X",
	"      XX",
}

func (b *macBackend) drawCursor(dst []byte, m MonitorInfo) {
	p, ok := cursorPos()
	if !ok {
		return
	}
	cx, cy := int(p.X)-m.X, int(p.Y)-m.Y
	for dy, line := range cursorArrow {
		for dx, ch := range line {
			x, y := cx+dx, cy+dy
			if ch == ' ' || x < 0 || y < 0 || x >= m.W || y >= m.H {
				continue
			}
			v := byte(255)
			if ch == 'X' {
				v = 0
			}
			o := (y*m.W + x) * 4
			dst[o], dst[o+1], dst[o+2] = v, v, v
		}
	}
}

func (b *macBackend) setCursor(on bool)       { b.cursorOn = on }
func (b *macBackend) interval() time.Duration { return 50 * time.Millisecond }
func (b *macBackend) close() {
	if b.sck != nil {
		b.sck.stop()
		b.sck = nil
	}
}

// setClipboard — tekst do schowka użytkownika (pbcopy w jego sesji; UTF-8).
func (b *macBackend) setClipboard(text string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/pbcopy")
	cmd.Env = append(os.Environ(), "LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8")
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}

const (
	evLeftDown     = 1
	evLeftUp       = 2
	evRightDown    = 3
	evRightUp      = 4
	evMoved        = 5
	evLeftDragged  = 6
	evRightDragged = 7
	evOtherDown    = 25
	evOtherUp      = 26
	evOtherDragged = 27
	fieldClicks    = 1 // kCGMouseEventClickState
	hidTap         = 0 // kCGHIDEventTap

	flagShift   = 0x20000
	flagControl = 0x40000
	flagAlt     = 0x80000
	flagCommand = 0x100000
)

func (b *macBackend) post(ev uintptr) {
	if ev == 0 {
		return
	}
	cgEventSetFlags(ev, b.flags)
	cgEventPost(hidTap, ev)
	cfRelease(ev)
}

func (b *macBackend) point(ev InputEvent, m MonitorInfo) cgPoint {
	x := math.Min(math.Max(ev.X, 0), 0.9999)
	y := math.Min(math.Max(ev.Y, 0), 0.9999)
	return cgPoint{float64(m.X) + x*float64(m.W), float64(m.Y) + y*float64(m.H)}
}

func (b *macBackend) input(ev InputEvent, m MonitorInfo) error {
	switch ev.T {
	case "m":
		p := b.point(ev, m)
		// z wciśniętym przyciskiem macOS oczekuje zdarzeń „przeciągania”, nie ruchu
		typ, btn := uint32(evMoved), uint32(0)
		switch {
		case b.buttons[0]:
			typ, btn = evLeftDragged, 0
		case b.buttons[2]:
			typ, btn = evRightDragged, 1
		case b.buttons[1]:
			typ, btn = evOtherDragged, 2
		}
		b.post(cgEventCreateMouseEvent(0, typ, p, btn))
	case "b":
		if ev.B < 0 || ev.B > 2 {
			return nil
		}
		p := b.point(ev, m)
		var typ, btn uint32
		switch ev.B {
		case 0:
			typ, btn = map[bool]uint32{true: evLeftDown, false: evLeftUp}[ev.D], 0
		case 1:
			typ, btn = map[bool]uint32{true: evOtherDown, false: evOtherUp}[ev.D], 2
		case 2:
			typ, btn = map[bool]uint32{true: evRightDown, false: evRightUp}[ev.D], 1
		}
		if ev.D {
			// dwuklik: macOS liczy kliknięcia z pola zdarzenia, nie z odstępu czasu
			if ev.B == b.lastButton && time.Since(b.lastDown) < 450*time.Millisecond && math.Abs(p.X-b.lastDownAt.X) < 5 && math.Abs(p.Y-b.lastDownAt.Y) < 5 {
				b.clicks = min(b.clicks+1, 3)
			} else {
				b.clicks = 1
			}
			b.lastDown, b.lastDownAt, b.lastButton = time.Now(), p, ev.B
		}
		b.buttons[ev.B] = ev.D
		e := cgEventCreateMouseEvent(0, typ, p, btn)
		if e != 0 {
			cgEventSetIntegerValueField(e, fieldClicks, b.clicks)
		}
		b.post(e)
	case "w":
		// przeglądarka: dodatnie = w dół (ok. 100–120 na „ząbek”); macOS: dodatnie = w górę
		lines := int32(math.Round(float64(-ev.DY) / 40))
		if lines == 0 && ev.DY != 0 {
			lines = int32(-sign(ev.DY))
		}
		b.post(cgEventCreateScrollWheelEvent2(0, 1 /* linie */, 1, lines, 0, 0))
	case "k":
		code, ok := macKeyCodes[ev.Code]
		if !ok {
			return nil
		}
		if f := modifierFlag(ev.Code); f != 0 {
			if ev.D {
				b.flags |= f
			} else {
				b.flags &^= f
			}
		}
		b.post(cgEventCreateKeyboardEvent(0, code, ev.D))
	}
	return nil
}

func sign(v int) int {
	if v < 0 {
		return -1
	}
	return 1
}

func modifierFlag(code string) uint64 {
	switch code {
	case "ShiftLeft", "ShiftRight":
		return flagShift
	case "ControlLeft", "ControlRight":
		return flagControl
	case "AltLeft", "AltRight":
		return flagAlt
	case "MetaLeft", "MetaRight", "OSLeft", "OSRight":
		return flagCommand
	}
	return 0
}

// macKeyCodes — KeyboardEvent.code → kod klawisza macOS (pozycyjny, niezależny od układu klawiatury).
var macKeyCodes = map[string]uint16{
	"KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05, "KeyZ": 0x06, "KeyX": 0x07,
	"KeyC": 0x08, "KeyV": 0x09, "IntlBackslash": 0x0A, "KeyB": 0x0B, "KeyQ": 0x0C, "KeyW": 0x0D, "KeyE": 0x0E, "KeyR": 0x0F,
	"KeyY": 0x10, "KeyT": 0x11, "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16, "Digit5": 0x17,
	"Equal": 0x18, "Digit9": 0x19, "Digit7": 0x1A, "Minus": 0x1B, "Digit8": 0x1C, "Digit0": 0x1D, "BracketRight": 0x1E,
	"KeyO": 0x1F, "KeyU": 0x20, "BracketLeft": 0x21, "KeyI": 0x22, "KeyP": 0x23, "Enter": 0x24, "KeyL": 0x25, "KeyJ": 0x26,
	"Quote": 0x27, "KeyK": 0x28, "Semicolon": 0x29, "Backslash": 0x2A, "Comma": 0x2B, "Slash": 0x2C, "KeyN": 0x2D,
	"KeyM": 0x2E, "Period": 0x2F, "Tab": 0x30, "Space": 0x31, "Backquote": 0x32, "Backspace": 0x33, "Escape": 0x35,
	"MetaRight": 0x36, "MetaLeft": 0x37, "OSRight": 0x36, "OSLeft": 0x37, "ShiftLeft": 0x38, "CapsLock": 0x39,
	"AltLeft": 0x3A, "ControlLeft": 0x3B, "ShiftRight": 0x3C, "AltRight": 0x3D, "ControlRight": 0x3E,
	"F17": 0x40, "NumpadDecimal": 0x41, "NumpadMultiply": 0x43, "NumpadAdd": 0x45, "NumLock": 0x47,
	"AudioVolumeUp": 0x48, "AudioVolumeDown": 0x49, "AudioVolumeMute": 0x4A, "NumpadDivide": 0x4B, "NumpadEnter": 0x4C,
	"NumpadSubtract": 0x4E, "F18": 0x4F, "F19": 0x50, "NumpadEqual": 0x51, "Numpad0": 0x52, "Numpad1": 0x53,
	"Numpad2": 0x54, "Numpad3": 0x55, "Numpad4": 0x56, "Numpad5": 0x57, "Numpad6": 0x58, "Numpad7": 0x59, "F20": 0x5A,
	"Numpad8": 0x5B, "Numpad9": 0x5C, "F5": 0x60, "F6": 0x61, "F7": 0x62, "F3": 0x63, "F8": 0x64, "F9": 0x65,
	"F11": 0x67, "F13": 0x69, "F16": 0x6A, "F14": 0x6B, "F10": 0x6D, "ContextMenu": 0x6E, "F12": 0x6F, "F15": 0x71,
	"Insert": 0x72, "Help": 0x72, "Home": 0x73, "PageUp": 0x74, "Delete": 0x75, "F4": 0x76, "End": 0x77, "F2": 0x78,
	"PageDown": 0x79, "F1": 0x7A, "ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,
}
