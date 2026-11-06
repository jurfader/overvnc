package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"time"
)

// desktopBackend — przechwytywanie ekranu i wstrzykiwanie wejścia (Windows: GDI + SendInput;
// inne systemy: syntetyczny ekran testowy, tylko z OVERVNC_DESKTOP_TEST=1).
type desktopBackend interface {
	// monitors zwraca monitory i nazwę bieżącego pulpitu wejściowego (zmiana = ekran blokady/UAC).
	monitors() ([]MonitorInfo, string)
	capture(m MonitorInfo) (bgra []byte, w, h int, err error)
	input(ev InputEvent, m MonitorInfo) error
	close()
	// setCursor: czy dorysowywać kursor do obrazu (wyłączony, gdy przeglądarka rysuje własny)
	setCursor(on bool)
	// interval: minimalny odstęp między klatkami dla tej metody przechwytywania
	interval() time.Duration
	// setClipboard umieszcza tekst w schowku komputera (sesji użytkownika)
	setClipboard(text string) error
}

// pasteModifier — klawisz wklejania razem z V (Windows: Ctrl, macOS: Cmd).
var pasteModifier = "ControlLeft"

// noticer — backend zgłasza problem do pokazania w panelu (np. brak zgody macOS na sterowanie).
type noticer interface{ notice() string }

// errNoChange — obraz się nie zmienił; nie ma czego wysyłać (DXGI wie to bez kopiowania ekranu).
var errNoChange = errors.New("bez zmian")

const (
	helperMaxCredits   = 3 // najwyżej 3 klatki „w drodze” (przy opóźnieniu łącza przez Cloudflare 2 to za mało)
	helperInfoInterval = 2 * time.Second
)

type helperOut struct {
	mu sync.Mutex
	w  *bufio.Writer
}

func (o *helperOut) send(typ byte, p []byte) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := writeMsg(o.w, typ, p); err != nil {
		return err
	}
	return o.w.Flush()
}

func (o *helperOut) log(format string, a ...any) {
	_ = o.send(msgLog, []byte(fmt.Sprintf(format, a...)))
}

// helperLogHook — backend może zapisać wpis do logu agenta (przez protokół, nie stdout).
var helperLogHook = func(string) {}

type helperMsg struct {
	typ byte
	p   []byte
}

// runDesktopHelper — proces pomocniczy w sesji użytkownika. stdout to WYŁĄCZNIE kanał protokołu.
func runDesktopHelper() int {
	// Windows: przełączanie na bieżący pulpit wejściowy (np. ekran blokady) działa per wątek systemowy,
	// więc przechwytywanie i wstrzykiwanie muszą iść z jednego, przypiętego wątku.
	runtime.LockOSThread()
	out := &helperOut{w: bufio.NewWriterSize(os.Stdout, 256<<10)}
	helperLogHook = func(s string) { out.log("%s", s) }
	be, err := newDesktopBackend(true)
	if err != nil {
		out.log("pulpit niedostępny: %v", err)
		return 1
	}
	defer be.close()
	watching := startLocalInputWatch()
	gate := newRemoteGate()

	msgs := make(chan helperMsg, 1024)
	go func() {
		in := bufio.NewReaderSize(os.Stdin, 64<<10)
		for {
			typ, p, err := readMsg(in)
			if err != nil {
				close(msgs)
				return
			}
			msgs <- helperMsg{typ, p}
		}
	}()

	var (
		enc      frameEncoder
		credits  int
		quality  = "medium"
		current  = -1 // -1 = monitor główny
		mons     []MonitorInfo
		desk     string
		lastInfo string
		last     time.Time
		lastErr  time.Time
		local    bool // ostatnio wysłany stan „osoba przy komputerze używa myszy/klawiatury”
	)
	// fullFrame — następna klatka w całości; backend z przechwytywaniem „tylko zmian” (DXGI, ScreenCaptureKit)
	// musi wtedy oddać obraz nawet bez zmian na ekranie
	fullFrame := func() {
		enc.reset()
		if f, ok := be.(interface{ invalidate() }); ok {
			f.invalidate()
		}
	}

	monitor := func() MonitorInfo {
		for _, m := range mons {
			if m.Index == current {
				return m
			}
		}
		for _, m := range mons {
			if m.Primary {
				return m
			}
		}
		if len(mons) > 0 {
			return mons[0]
		}
		return MonitorInfo{}
	}
	refreshInfo := func(force bool) {
		var d string
		mons, d = be.monitors()
		if d != desk {
			desk = d
			fullFrame() // inny pulpit (np. ekran blokady) — pełna klatka
		}
		info := DesktopInfo{Monitors: mons, Current: monitor().Index, Desktop: desk, LocalWatch: watching}
		if n, ok := be.(noticer); ok {
			info.Notice = n.notice()
		}
		b, _ := json.Marshal(info)
		changed := force || string(b) != lastInfo
		if changed {
			lastInfo = string(b)
			fullFrame()
		}
		// sama zmiana „osoba przy komputerze używa myszy” nie wymaga pełnej klatki
		now := gate.yield && localActive(time.Now())
		if changed || now != local {
			local = now
			info.Local = now
			b, _ = json.Marshal(info)
			_ = out.send(msgInfo, b)
		}
	}
	// blocked — zdalne wejście czeka, bo osoba przy komputerze właśnie go używa; przy przejęciu
	// zwalniamy to, co zdalnie wciśnięte, żeby nie przeszkadzał jej „zawieszony” klawisz
	blocked := func() bool {
		b := gate.yield && localActive(time.Now())
		if b && !local {
			for _, ev := range gate.releaseAll() {
				_ = be.input(ev, monitor())
			}
			refreshInfo(false)
		}
		return b
	}
	refreshInfo(true)
	infoTick := time.NewTicker(helperInfoInterval)
	defer infoTick.Stop()

	for {
		wait := helperInfoInterval
		frameInterval := be.interval()
		if credits > 0 {
			wait = max(time.Millisecond, frameInterval-time.Since(last))
		}
		if watching {
			wait = min(wait, 250*time.Millisecond) // szybka informacja w panelu o przejęciu / zwolnieniu
		}
		select {
		case m, ok := <-msgs:
			if !ok {
				return 0 // usługa zamknęła potok
			}
			switch m.typ {
			case msgQuit:
				return 0
			case msgNext:
				credits = min(credits+1, helperMaxCredits)
			case msgEvent:
				var ev InputEvent
				if json.Unmarshal(m.p, &ev) != nil {
					continue
				}
				switch ev.T {
				case "cfg":
					if ev.Quality != "" {
						quality = ev.Quality
						fullFrame()
					}
					if ev.Monitor != nil {
						current = *ev.Monitor
						refreshInfo(true)
					}
					if ev.Cursor != nil {
						be.setCursor(*ev.Cursor)
					}
					if ev.Yield != nil {
						gate.yield = *ev.Yield
						refreshInfo(false)
					}
				case "kf":
					fullFrame()
				case "clip":
					if blocked() {
						continue
					}
					// tekst do schowka komputera, potem Ctrl+V — wklejanie w dowolnym programie
					if err := be.setClipboard(ev.Text); err != nil {
						out.log("schowek: %v", err)
						continue
					}
					for _, k := range []InputEvent{{T: "k", Code: pasteModifier, D: true}, {T: "k", Code: "KeyV", D: true}, {T: "k", Code: "KeyV"}, {T: "k", Code: pasteModifier}} {
						_ = be.input(k, monitor())
					}
				default:
					if !gate.allow(ev, blocked()) {
						continue
					}
					if err := be.input(ev, monitor()); err != nil && time.Since(lastErr) > 5*time.Second {
						lastErr = time.Now()
						out.log("wejście: %v", err)
					}
				}
			}
		case <-infoTick.C:
			refreshInfo(false)
		case <-time.After(wait):
		}
		if watching && gate.yield && localActive(time.Now()) != local {
			blocked() // zwolnienie zdalnie wciśniętych przy przejęciu
			refreshInfo(false)
		}

		if credits > 0 && time.Since(last) >= frameInterval {
			last = time.Now()
			mon := monitor()
			bgra, w, h, err := be.capture(mon)
			if errors.Is(err, errNoChange) {
				continue
			}
			if err != nil {
				if time.Since(lastErr) > 5*time.Second {
					lastErr = time.Now()
					out.log("przechwytywanie: %v", err)
				}
				continue
			}
			data, err := enc.encode(bgra, w, h, quality)
			if err != nil || data == nil {
				continue // brak zmian — nie zużywamy zgody na klatkę
			}
			if out.send(msgFrame, data) != nil {
				return 1
			}
			credits--
		}
	}
}
