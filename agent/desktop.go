package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// helperProc — uruchomiony proces pomocniczy pulpitu (Windows: w sesji użytkownika jako SYSTEM).
type helperProc interface {
	stdin() io.Writer
	stdout() io.Reader
	wait() int // kod wyjścia procesu
	kill()
}

// captureGDIOnly — pomocnik pulpitu padł w trybie DXGI (np. błąd sterownika karty graficznej):
// kolejne sesje przechwytują ekran przez GDI, aż do restartu agenta.
var captureGDIOnly atomic.Bool

// helperCrashed: panika Go (2) albo wyjątek Windows (kody NTSTATUS 0xC0000000+, np. naruszenie dostępu).
func helperCrashed(code int) bool { return code == 2 || (code > 0 && uint32(code) >= 0xC0000000) }

type desktopOpenReq struct {
	Channel  uint32 `json:"channel"`
	Monitor  *int   `json:"monitor"`
	Quality  string `json:"quality"`
	Consent  string `json:"consent"` // none | notify | ask
	Viewer   string `json:"viewer"`
	ViewOnly bool   `json:"viewOnly"`
}

// ---------- jedno przechwytywanie dla wszystkich oglądających ----------
//
// Kilka osób na pulpicie tego samego komputera dzieli jeden proces pomocnika: ekran jest
// przechwytywany i kodowany raz, a klatki trafiają do każdego kanału. Tempo wyznacza najwolniejszy
// oglądający (pomocnik dostaje zgodę na klatkę, gdy potwierdzą ją wszyscy). Monitor i jakość są
// wspólne; kursor jest dorysowywany, gdy chce go ktokolwiek (np. podgląd), a schowek komputera trafia
// tylko do tych, którzy go włączyli.

var desktopGroups struct {
	mu sync.Mutex
	g  *desktopGroup
}

// spawnHelperFn — uruchomienie pomocnika (w testach zastępowane procesem w pamięci).
var spawnHelperFn = spawnDesktopHelper

// overlayFn — ramka „Aktywne Wsparcie Techniczne” (w testach zastępowana).
var overlayFn = startSupportOverlay

type desktopGroup struct {
	proc    helperProc
	inMu    sync.Mutex // zapis do stdin pomocnika
	mu      sync.Mutex // poniższe pola
	viewers map[uint32]*desktopViewer
	sent    uint64 // klatki rozesłane oglądającym
	granted uint64 // zgody na klatki wysłane pomocnikowi
	info    []byte // ostatnia informacja o monitorach — dla dołączających
	cursor  *bool  // ostatnio wysłane ustawienie kursora
	clip    *bool  // ostatnio wysłane ustawienie schowka
	closing atomic.Bool

	overlay      interface{ stop() }
	overlayNames string

	// sterowanie ma jedna osoba naraz; pozostali (w trybie sterowania) mogą je przejąć przyciskiem
	controller uint32 // kanał sterującego (0 = nikt)
	joins      uint64 // kolejność dołączania — sterowanie po wyjściu sterującego dostaje najdawniejszy
}

type desktopViewer struct {
	g       *desktopGroup
	ch      uint32
	sess    *sessionIO
	name    string
	overlay bool // tryb zgody z ramką (notify / ask)
	acked   uint64
	cursor  bool // chce kursora w obrazie (domyślnie tak — dopóki panel nie powie inaczej)
	clip    bool
	once    sync.Once

	viewOnly bool // podgląd — nigdy nie steruje
	seq      uint64
}

// presence — kto jest połączony i kto steruje; każdy oglądający dostaje własną wersję („you”).
type presence struct {
	Viewers []presenceViewer `json:"viewers"`
}

type presenceViewer struct {
	Name     string `json:"name"`
	ViewOnly bool   `json:"viewOnly,omitempty"`
	Control  bool   `json:"control,omitempty"`
	You      bool   `json:"you,omitempty"`
}

// sendPresenceLocked — 'P' do każdego oglądającego po dołączeniu, wyjściu albo przejęciu sterowania.
func (g *desktopGroup) sendPresenceLocked() {
	list := make([]*desktopViewer, 0, len(g.viewers))
	for _, v := range g.viewers {
		list = append(list, v)
	}
	slices.SortFunc(list, func(a, b *desktopViewer) int { return int(a.seq) - int(b.seq) })
	for _, to := range list {
		var p presence
		for _, v := range list {
			p.Viewers = append(p.Viewers, presenceViewer{Name: v.name, ViewOnly: v.viewOnly, Control: v.ch == g.controller, You: v == to})
		}
		b, _ := json.Marshal(p)
		_ = to.sess.writeBinary(encodeFrame(frameData, to.ch, append([]byte{msgPresence}, b...)))
	}
}

// setControllerLocked — nowy sterujący; to, co poprzedni trzymał wciśnięte, zostaje zwolnione.
func (g *desktopGroup) setControllerLocked(ch uint32) {
	if g.controller == ch {
		return
	}
	if g.controller != 0 {
		_ = g.toHelper(msgEvent, []byte(`{"t":"rel"}`))
	}
	g.controller = ch
}

// nextControllerLocked — po wyjściu sterującego: najdawniej połączona osoba w trybie sterowania.
func (g *desktopGroup) nextControllerLocked() uint32 {
	var best *desktopViewer
	for _, v := range g.viewers {
		if !v.viewOnly && (best == nil || v.seq < best.seq) {
			best = v
		}
	}
	if best == nil {
		return 0
	}
	return best.ch
}

func (g *desktopGroup) toHelper(typ byte, p []byte) error {
	g.inMu.Lock()
	defer g.inMu.Unlock()
	return writeMsg(g.proc.stdin(), typ, p)
}

// grantLocked — pomocnik może mieć najwyżej helperMaxCredits klatek ponad to, co potwierdził
// najwolniejszy oglądający.
func (g *desktopGroup) grantLocked() {
	if len(g.viewers) == 0 {
		return
	}
	minAcked := g.sent
	for _, v := range g.viewers {
		minAcked = min(minAcked, v.acked)
	}
	for target := minAcked + helperMaxCredits; g.granted < target; g.granted++ {
		_ = g.toHelper(msgNext, nil)
	}
}

// syncSettingsLocked — wspólne ustawienia pomocnika wynikające z wszystkich oglądających.
func (g *desktopGroup) syncSettingsLocked() {
	cursor, clip := false, false
	for _, v := range g.viewers {
		cursor = cursor || v.cursor
		clip = clip || v.clip
	}
	var ev InputEvent
	ev.T = "cfg"
	if g.cursor == nil || *g.cursor != cursor {
		ev.Cursor, g.cursor = &cursor, &cursor
	}
	if g.clip == nil || *g.clip != clip {
		ev.ClipSync, g.clip = &clip, &clip
	}
	if ev.Cursor != nil || ev.ClipSync != nil {
		b, _ := json.Marshal(ev)
		_ = g.toHelper(msgEvent, b)
	}
}

// syncOverlayLocked — ramka u użytkownika komputera pokazuje wszystkich połączonych (tryby z ramką).
func (g *desktopGroup) syncOverlayLocked() {
	var names []string
	for _, v := range g.viewers {
		if v.overlay && !slices.Contains(names, v.name) {
			names = append(names, v.name)
		}
	}
	slices.Sort(names)
	joined := strings.Join(names, ", ")
	if joined == g.overlayNames && (g.overlay != nil || joined == "") {
		return
	}
	if g.overlay != nil {
		g.overlay.stop()
		g.overlay = nil
	}
	g.overlayNames = joined
	if joined != "" {
		g.overlay = overlayFn(joined)
	}
}

// join dodaje oglądającego: dostaje bieżącą informację o monitorach i pełną klatkę.
func (g *desktopGroup) join(v *desktopViewer) {
	g.mu.Lock()
	defer g.mu.Unlock()
	v.acked = g.sent
	g.joins++
	v.seq = g.joins
	g.viewers[v.ch] = v
	if g.controller == 0 && !v.viewOnly {
		g.controller = v.ch // pierwszy sterujący dostaje sterowanie od razu
	}
	if g.info != nil {
		_ = v.sess.writeBinary(encodeFrame(frameData, v.ch, append([]byte{msgInfo}, g.info...)))
	}
	if len(g.viewers) > 1 {
		_ = g.toHelper(msgEvent, []byte(`{"t":"kf"}`))
	}
	g.syncSettingsLocked()
	g.syncOverlayLocked()
	g.grantLocked()
	g.sendPresenceLocked()
}

// leave usuwa oglądającego; ostatni zamyka pomocnika.
func (g *desktopGroup) leave(v *desktopViewer) {
	g.mu.Lock()
	if g.viewers[v.ch] != v {
		g.mu.Unlock()
		return
	}
	delete(g.viewers, v.ch)
	last := len(g.viewers) == 0
	g.syncOverlayLocked() // ostatni wychodzi -> ramka znika od razu
	if g.controller == v.ch {
		g.setControllerLocked(g.nextControllerLocked())
	}
	if !last {
		g.syncSettingsLocked()
		g.grantLocked()
		g.sendPresenceLocked()
	}
	g.mu.Unlock()
	if last {
		g.shutdown()
	}
}

func (g *desktopGroup) shutdown() {
	if g.closing.Swap(true) {
		return
	}
	desktopGroups.mu.Lock()
	if desktopGroups.g == g {
		desktopGroups.g = nil // następne połączenie uruchomi nowego pomocnika
	}
	desktopGroups.mu.Unlock()
	_ = g.toHelper(msgQuit, nil)
	go func() {
		time.Sleep(2 * time.Second)
		g.proc.kill()
	}()
}

// broadcast — wiadomość pomocnika do oglądających. Klatki do wszystkich, schowek tylko do chętnych.
func (g *desktopGroup) broadcast(typ byte, p []byte) {
	g.mu.Lock()
	defer g.mu.Unlock()
	switch typ {
	case msgFrame:
		g.sent++
	case msgInfo:
		g.info = p
	}
	msg := append([]byte{typ}, p...)
	for _, v := range g.viewers {
		if typ == msgClip && !v.clip {
			continue
		}
		// błąd zapisu = zerwane połączenie z serwerem; kanały zamknie wtedy closeAll
		_ = v.sess.writeBinary(encodeFrame(frameData, v.ch, msg))
	}
}

// run czyta wiadomości pomocnika do jego zakończenia; potem zamyka kanały wszystkich oglądających.
func (g *desktopGroup) run() {
	r := bufio.NewReaderSize(g.proc.stdout(), 256<<10)
	reason := ""
	for {
		typ, p, err := readMsg(r)
		if err != nil {
			break
		}
		switch typ {
		case msgFrame, msgInfo, msgClip:
			g.broadcast(typ, p)
		case msgLog:
			reason = string(p)
			logger.Infof("pulpit: %s", p)
		}
	}
	code := g.proc.wait()
	if helperCrashed(code) && !g.closing.Load() && !captureGDIOnly.Swap(true) {
		logger.Warningf("pulpit: pomocnik zakończył się awarią (kod %#x) — kolejne sesje przez GDI", uint32(code))
	}
	g.closing.Store(true)
	desktopGroups.mu.Lock()
	if desktopGroups.g == g {
		desktopGroups.g = nil
	}
	desktopGroups.mu.Unlock()

	g.mu.Lock()
	viewers := g.viewers
	g.viewers = map[uint32]*desktopViewer{}
	if g.overlay != nil {
		g.overlay.stop()
		g.overlay = nil
	}
	g.mu.Unlock()
	for _, v := range viewers {
		if v.sess.channels.remove(v.ch) != nil {
			ev := map[string]any{"channel": v.ch, "exitCode": 0}
			if reason != "" {
				ev["error"] = reason
			}
			_ = v.sess.event("channel.closed", ev)
		}
	}
}

// ---------- kanał jednego oglądającego ----------

// write — zdarzenie z przeglądarki (JSON). Ctrl+Alt+Del wysyła sama usługa (Windows przyjmuje je
// tylko od usługi działającej jako SYSTEM); ustawienia kursora i schowka są łączone dla wszystkich.
func (v *desktopViewer) write(p []byte) error {
	switch eventType(p) {
	case "take":
		// „Przejmij sterowanie” — od razu, bez czekania na zgodę sterującego (mógł odejść od komputera)
		if !v.viewOnly {
			g := v.g
			g.mu.Lock()
			if g.controller != v.ch {
				g.setControllerLocked(v.ch)
				g.sendPresenceLocked()
			}
			g.mu.Unlock()
		}
		return nil
	case "m", "b", "w", "k", "clip", "sas":
		g := v.g
		g.mu.Lock()
		allowed := g.controller == v.ch
		g.mu.Unlock()
		if !allowed {
			return nil // steruje ktoś inny
		}
	}
	if len(p) < 64 && bytes.Contains(p, []byte(`"sas"`)) {
		var ev struct {
			T string `json:"t"`
		}
		if json.Unmarshal(p, &ev) == nil && ev.T == "sas" {
			if err := sendSAS(); err != nil {
				logger.Warningf("Ctrl+Alt+Del: %v", err)
			}
			return nil
		}
	}
	if bytes.Contains(p, []byte(`"cfg"`)) {
		var ev InputEvent
		if json.Unmarshal(p, &ev) == nil && ev.T == "cfg" && (ev.Cursor != nil || ev.ClipSync != nil) {
			g := v.g
			g.mu.Lock()
			if ev.Cursor != nil {
				v.cursor = *ev.Cursor
			}
			if ev.ClipSync != nil {
				v.clip = *ev.ClipSync
			}
			g.syncSettingsLocked()
			g.mu.Unlock()
			ev.Cursor, ev.ClipSync = nil, nil
			if ev.Quality == "" && ev.Monitor == nil && ev.Yield == nil {
				return nil
			}
			p, _ = json.Marshal(ev)
		}
	}
	return v.g.toHelper(msgEvent, p)
}

// eventType — pole "t" zdarzenia. Serwer zawsze stawia je na początku ({"t":"m",…}), więc zwykle
// wystarczy odczyt prefiksu; inaczej pełne parsowanie.
func eventType(p []byte) string {
	const prefix = `{"t":"`
	if bytes.HasPrefix(p, []byte(prefix)) {
		if end := bytes.IndexByte(p[len(prefix):], '"'); end >= 0 {
			return string(p[len(prefix) : len(prefix)+end])
		}
	}
	var ev struct {
		T string `json:"t"`
	}
	_ = json.Unmarshal(p, &ev)
	return ev.T
}

// ack — przeglądarka narysowała klatkę.
func (v *desktopViewer) ack(n int) {
	g := v.g
	g.mu.Lock()
	defer g.mu.Unlock()
	v.acked = min(v.acked+uint64(max(n, 1)), g.sent)
	g.grantLocked()
}

func (v *desktopViewer) close() { v.once.Do(func() { v.g.leave(v) }) }

func handleDesktopOpen(ctx context.Context, data json.RawMessage) (any, error) {
	sess, err := sessionFrom(ctx)
	if err != nil {
		return nil, err
	}
	req, err := decode[desktopOpenReq](data)
	if err != nil || req.Channel == 0 {
		return nil, protoErr("bad_request", "nieprawidłowe żądanie pulpitu")
	}
	if ok, err := askDesktopConsent(req.Consent, req.Viewer); err != nil {
		return nil, err
	} else if !ok {
		return nil, protoErr("consent_denied", "użytkownik komputera nie zgodził się na połączenie")
	}

	desktopGroups.mu.Lock()
	g := desktopGroups.g
	fresh := g == nil || g.closing.Load()
	if fresh {
		var args []string
		if captureGDIOnly.Load() {
			args = append(args, "gdi")
		}
		proc, err := spawnHelperFn(args...)
		if err != nil {
			desktopGroups.mu.Unlock()
			return nil, protoErr("helper", "nie można uruchomić przechwytywania ekranu: %v", err)
		}
		g = &desktopGroup{proc: proc, viewers: map[uint32]*desktopViewer{}}
		desktopGroups.g = g
		// ustawienia początkowe od pierwszego oglądającego; kolejni dołączają do bieżącego obrazu
		cfg, _ := json.Marshal(InputEvent{T: "cfg", Quality: req.Quality, Monitor: req.Monitor})
		_ = g.toHelper(msgEvent, cfg)
		go g.run()
	}
	desktopGroups.mu.Unlock()

	// użytkownik ma wiedzieć, że ktoś jest połączony — ramka przez całą sesję (tryby „z powiadomieniem” i „z pytaniem”)
	v := &desktopViewer{g: g, ch: req.Channel, sess: sess, name: req.Viewer, overlay: req.Consent == "notify" || req.Consent == "ask", cursor: true, viewOnly: req.ViewOnly}
	if err := sess.channels.add(req.Channel, v); err != nil {
		if fresh {
			g.shutdown()
		}
		return nil, err
	}
	g.join(v)
	return map[string]any{"ok": true}, nil
}

func init() {
	if desktopSupported() {
		handlers["desktop.open"] = handleDesktopOpen
	}
}
