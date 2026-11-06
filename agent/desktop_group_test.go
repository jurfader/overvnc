package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeHelper — pomocnik pulpitu w pamięci: test czyta to, co usługa mu wysyła, i pisze „klatki”.
type fakeHelper struct {
	inR, outR   *io.PipeReader
	inW, outW   *io.PipeWriter
	mu          sync.Mutex
	got         []string // wiadomości od usługi: "N", "Q", "E:{json}"
	done        chan struct{}
	killed      bool
	writeToHost sync.Mutex
}

func newFakeHelper() *fakeHelper {
	h := &fakeHelper{done: make(chan struct{})}
	h.inR, h.inW = io.Pipe()
	h.outR, h.outW = io.Pipe()
	go func() {
		r := bufio.NewReader(h.inR)
		for {
			typ, p, err := readMsg(r)
			if err != nil {
				return
			}
			h.mu.Lock()
			if typ == msgEvent {
				h.got = append(h.got, "E:"+string(p))
			} else {
				h.got = append(h.got, string(typ))
			}
			h.mu.Unlock()
			if typ == msgQuit {
				h.exit()
			}
		}
	}()
	return h
}

func (h *fakeHelper) stdin() io.Writer  { return h.inW }
func (h *fakeHelper) stdout() io.Reader { return h.outR }
func (h *fakeHelper) wait() int         { <-h.done; return 0 }
func (h *fakeHelper) kill()             { h.exit() }
func (h *fakeHelper) exit() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.killed {
		h.killed = true
		_ = h.outW.Close()
		close(h.done)
	}
}
func (h *fakeHelper) emit(typ byte, p string) {
	h.writeToHost.Lock()
	defer h.writeToHost.Unlock()
	_ = writeMsg(h.outW, typ, []byte(p))
}
func (h *fakeHelper) count(s string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, g := range h.got {
		if g == s {
			n++
		}
	}
	return n
}
func (h *fakeHelper) lastCfg() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := len(h.got) - 1; i >= 0; i-- {
		if strings.HasPrefix(h.got[i], `E:{"t":"cfg"`) {
			return h.got[i][2:]
		}
	}
	return ""
}

// fakeServer — połączenie z serwerem: klatki per kanał i zdarzenia.
type fakeServer struct {
	mu     sync.Mutex
	frames map[uint32][]string // "F…", "I…", "C…"
	events []string
	io     *sessionIO
}

func newFakeServer() *fakeServer {
	s := &fakeServer{frames: map[uint32][]string{}}
	s.io = &sessionIO{
		channels: newChannelManager(),
		writeBinary: func(b []byte) error {
			_, ch, p, _ := decodeFrame(b)
			s.mu.Lock()
			s.frames[ch] = append(s.frames[ch], string(p))
			s.mu.Unlock()
			return nil
		},
		event: func(typ string, data any) error {
			b, _ := json.Marshal(data)
			s.mu.Lock()
			s.events = append(s.events, typ+string(b))
			s.mu.Unlock()
			return nil
		},
	}
	return s
}
func (s *fakeServer) got(ch uint32) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.frames[ch]...)
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("nie doczekano się: %s", what)
}

func TestDesktopGroupSharesOneHelper(t *testing.T) {
	var helpers []*fakeHelper
	var overlays []string
	spawnHelperFn = func(...string) (helperProc, error) { h := newFakeHelper(); helpers = append(helpers, h); return h, nil }
	overlayFn = func(name string) interface{ stop() } { overlays = append(overlays, name); return nil }
	t.Cleanup(func() { spawnHelperFn, overlayFn = spawnDesktopHelper, startSupportOverlay })

	srv := newFakeServer()
	ctx := withSession(context.Background(), srv.io)
	open := func(ch uint32, viewer string) {
		b, _ := json.Marshal(desktopOpenReq{Channel: ch, Consent: "none", Viewer: viewer})
		if _, err := handleDesktopOpen(ctx, b); err != nil {
			t.Fatal(err)
		}
	}

	open(1, "Anna")
	h := helpers[0]
	waitUntil(t, "3 zgody na klatki", func() bool { return h.count("N") == 3 })
	h.emit(msgInfo, `{"monitors":[]}`)
	h.emit(msgFrame, "klatka1")
	waitUntil(t, "klatka u Anny", func() bool { return len(srv.got(1)) == 2 })

	// druga osoba: ten sam pomocnik, od razu informacja o monitorach i prośba o pełną klatkę
	open(2, "Jan")
	if len(helpers) != 1 {
		t.Fatalf("drugi pomocnik dla drugiej osoby: %d", len(helpers))
	}
	waitUntil(t, "informacja dla dołączającego", func() bool { g := srv.got(2); return len(g) == 1 && g[0] == `I{"monitors":[]}` })
	waitUntil(t, "pełna klatka po dołączeniu", func() bool { return h.count(`E:{"t":"kf"}`) == 1 })
	h.emit(msgFrame, "klatka2")
	waitUntil(t, "klatka u obojga", func() bool { return len(srv.got(1)) == 3 && len(srv.got(2)) == 2 })

	// tempo: kolejna zgoda dopiero, gdy klatki potwierdzą wszyscy
	ch1, ch2 := srv.io.channels.get(1).(acker), srv.io.channels.get(2).(acker)
	ch1.ack(1)
	ch1.ack(1)
	time.Sleep(30 * time.Millisecond)
	// Jan dołączył po klatce 1 (ma ją zaliczoną), klatki 2 jeszcze nie potwierdził: najwolniejszy = 1 -> 1+3 zgody
	if n := h.count("N"); n != 4 {
		t.Fatalf("zgoda przed potwierdzeniem przez drugą osobę: %d", n)
	}
	ch2.ack(1)
	waitUntil(t, "zgoda po potwierdzeniu przez oboje", func() bool { return h.count("N") == 5 })

	// kursor: Anna rysuje własny (false), Jan domyślnie chce kursora w obrazie -> w obrazie
	_ = srv.io.channels.get(1).write([]byte(`{"t":"cfg","cursor":false,"clipSync":true}`))
	// schowek komputera tylko do Anny (włączyła clipSync)
	h.emit(msgClip, "tekst")
	waitUntil(t, "schowek u Anny", func() bool { g := srv.got(1); return g[len(g)-1] == "Ctekst" })
	for _, f := range srv.got(2) {
		if f[0] == 'C' {
			t.Fatal("schowek trafił do osoby, która go nie włączyła")
		}
	}
	if c := h.lastCfg(); !strings.Contains(c, `"cursor":true`) && !strings.Contains(c, `"clipSync":true`) {
		t.Fatalf("ustawienia pomocnika: %s", c)
	}

	// Jan wychodzi: kursor już niepotrzebny w obrazie, pomocnik działa dalej
	srv.io.channels.remove(2).close()
	waitUntil(t, "kursor wyłączony po wyjściu Jana", func() bool { return strings.Contains(h.lastCfg(), `"cursor":false`) })
	if h.count("Q") != 0 {
		t.Fatal("pomocnik zamknięty, choć Anna wciąż ogląda")
	}

	// Anna wychodzi — koniec pomocnika; następne połączenie uruchamia nowy
	srv.io.channels.remove(1).close()
	waitUntil(t, "zamknięcie pomocnika", func() bool { return h.count("Q") == 1 })
	open(3, "Ola")
	if len(helpers) != 2 {
		t.Fatalf("po zamknięciu oczekiwano nowego pomocnika, jest %d", len(helpers))
	}
	// pomocnik się kończy (np. awaria) — kanał zamknięty z informacją dla serwera
	helpers[1].emit(msgLog, "przechwytywanie: błąd")
	helpers[1].exit()
	waitUntil(t, "channel.closed", func() bool {
		srv.mu.Lock()
		defer srv.mu.Unlock()
		return len(srv.events) == 1 && strings.Contains(srv.events[0], `"channel":3`)
	})
	if len(overlays) != 0 {
		t.Fatalf("ramka bez trybu z powiadomieniem: %v", overlays)
	}
}

func TestDesktopGroupOverlayNames(t *testing.T) {
	var overlays []string
	stopped := 0
	spawnHelperFn = func(...string) (helperProc, error) { return newFakeHelper(), nil }
	overlayFn = func(name string) interface{ stop() } { overlays = append(overlays, name); return stopFn(func() { stopped++ }) }
	t.Cleanup(func() { spawnHelperFn, overlayFn = spawnDesktopHelper, startSupportOverlay })

	srv := newFakeServer()
	ctx := withSession(context.Background(), srv.io)
	for ch, who := range map[uint32]string{1: "Paweł"} {
		b, _ := json.Marshal(desktopOpenReq{Channel: ch, Consent: "notify", Viewer: who})
		_, _ = handleDesktopOpen(ctx, b)
	}
	b, _ := json.Marshal(desktopOpenReq{Channel: 2, Consent: "notify", Viewer: "Anna"})
	_, _ = handleDesktopOpen(ctx, b)
	if strings.Join(overlays, " | ") != "Paweł | Anna, Paweł" || stopped != 1 {
		t.Fatalf("ramka: %v, zatrzymane %d", overlays, stopped)
	}
	srv.io.channels.remove(1).close()
	if overlays[len(overlays)-1] != "Anna" {
		t.Fatalf("po wyjściu Pawła ramka: %v", overlays)
	}
	srv.io.channels.remove(2).close()
	if stopped != 3 {
		t.Fatalf("ramka nie zniknęła po wyjściu wszystkich (zatrzymane %d)", stopped)
	}
}

type stopFn func()

func (f stopFn) stop() { f() }
