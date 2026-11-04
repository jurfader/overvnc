package main

import (
	"bufio"
	"encoding/json"
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
}

const (
	helperFrameInterval = 66 * time.Millisecond // maks. ~15 kl./s
	helperMaxCredits    = 2                     // najwyżej 2 klatki „w drodze” do przeglądarki
	helperInfoInterval  = 2 * time.Second
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
	be, err := newDesktopBackend()
	if err != nil {
		out.log("pulpit niedostępny: %v", err)
		return 1
	}
	defer be.close()

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
	)
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
			enc.reset() // inny pulpit (np. ekran blokady) — pełna klatka
		}
		info := DesktopInfo{Monitors: mons, Current: monitor().Index, Desktop: desk}
		b, _ := json.Marshal(info)
		if force || string(b) != lastInfo {
			lastInfo = string(b)
			enc.reset()
			_ = out.send(msgInfo, b)
		}
	}
	refreshInfo(true)
	infoTick := time.NewTicker(helperInfoInterval)
	defer infoTick.Stop()

	for {
		wait := helperInfoInterval
		if credits > 0 {
			wait = max(time.Millisecond, helperFrameInterval-time.Since(last))
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
						enc.reset()
					}
					if ev.Monitor != nil {
						current = *ev.Monitor
						refreshInfo(true)
					}
				case "kf":
					enc.reset()
				default:
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

		if credits > 0 && time.Since(last) >= helperFrameInterval {
			last = time.Now()
			mon := monitor()
			bgra, w, h, err := be.capture(mon)
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
