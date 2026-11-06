package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// Prawdziwe połączenie WebRTC (pion po obu stronach, adresy lokalne): sygnalizacja przez kanał
// pulpitu, duża klatka w kawałkach, wejście kanałem bezpośrednim sprawdzane przez agenta.
func TestDesktopRTC(t *testing.T) {
	var h *fakeHelper
	spawnHelperFn = func(...string) (helperProc, error) { h = newFakeHelper(); return h, nil }
	overlayFn = func(string) interface{ stop() } { return nil }
	t.Cleanup(func() { spawnHelperFn, overlayFn = spawnDesktopHelper, startSupportOverlay })

	srv := newFakeServer()
	ctx := withSession(context.Background(), srv.io)
	b, _ := json.Marshal(desktopOpenReq{Channel: 1, Consent: "none", Viewer: "Anna"})
	if _, err := handleDesktopOpen(ctx, b); err != nil {
		t.Fatal(err)
	}
	v := srv.io.channels.get(1)
	t.Cleanup(func() { srv.io.channels.remove(1).close() })

	// „przeglądarka”
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	dc, err := pc.CreateDataChannel("desk", nil)
	if err != nil {
		t.Fatal(err)
	}
	var (
		mu       sync.Mutex
		got      [][]byte // złożone wiadomości [typ][dane]
		partial  []byte
		opened   = make(chan struct{})
		openOnce sync.Once
	)
	dc.OnOpen(func() { openOnce.Do(func() { close(opened) }) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		mu.Lock()
		defer mu.Unlock()
		partial = append(partial, m.Data[1:]...)
		if m.Data[0] == 1 {
			got = append(got, partial)
			partial = nil
		}
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			b, _ := json.Marshal(map[string]any{"t": "rtc", "cand": c.ToJSON()})
			_ = v.write(b)
		}
	})
	offer, _ := pc.CreateOffer(nil)
	_ = pc.SetLocalDescription(offer)
	ob, _ := json.Marshal(map[string]any{"t": "rtc", "sdp": offer})
	_ = v.write(ob)

	// odpowiedź i kandydaci agenta przychodzą jako 'R' przez serwer
	seen := 0
	deadline := time.After(10 * time.Second)
	for done := false; !done; {
		select {
		case <-opened:
			done = true
		case <-deadline:
			t.Fatal("kanał bezpośredni się nie otworzył")
		case <-time.After(10 * time.Millisecond):
		}
		srv.mu.Lock()
		frames := srv.frames[1]
		var rs []string
		for _, f := range frames {
			if f[0] == msgRTC {
				rs = append(rs, f[1:])
			}
		}
		srv.mu.Unlock()
		for _, r := range rs[seen:] {
			var s rtcSignal
			_ = json.Unmarshal([]byte(r), &s)
			if s.SDP != nil {
				if err := pc.SetRemoteDescription(*s.SDP); err != nil {
					t.Fatal(err)
				}
			}
			if s.Cand != nil {
				_ = pc.AddICECandidate(*s.Cand)
			}
		}
		seen = len(rs)
	}

	// duża klatka (300 KB) dociera kanałem bezpośrednim w całości, nie przez serwer
	big := make([]byte, 300<<10)
	_, _ = rand.Read(big)
	time.Sleep(50 * time.Millisecond)
	viaServer := len(srv.got(1))
	h.emit(msgFrame, string(big))
	waitUntil(t, "klatka kanałem bezpośrednim", func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, m := range got {
			if m[0] == msgFrame && bytes.Equal(m[1:], big) {
				return true
			}
		}
		return false
	})
	if n := len(srv.got(1)); n != viaServer {
		t.Fatalf("klatka poszła też przez serwer (%d -> %d)", viaServer, n)
	}

	// wejście kanałem bezpośrednim: poprawne dociera, reszta jest odrzucana przez agenta
	for _, s := range []string{
		`{"t":"k","code":"KeyZ","d":true}`,
		`{"t":"k","code":"Key Z; rm -rf /","d":true}`,
		`{"t":"m","x":7,"y":0}`,
		`{"t":"sas"}`,
		`{"t":"take"}`,
		`{"t":"clip","text":"x"}`,
	} {
		_ = dc.SendText(s)
	}
	waitUntil(t, "klawisz z kanału bezpośredniego", func() bool { return h.countContaining(`"code":"KeyZ"`) == 1 })
	time.Sleep(100 * time.Millisecond)
	h.mu.Lock()
	for _, g := range h.got {
		if strings.Contains(g, "rm -rf") || strings.Contains(g, `"x":7`) || strings.Contains(g, `"t":"clip"`) || strings.Contains(g, `"t":"take"`) {
			t.Errorf("niedozwolone zdarzenie z kanału bezpośredniego dotarło: %s", g)
		}
	}
	h.mu.Unlock()

	// potwierdzenie klatki kanałem bezpośrednim daje pomocnikowi zgodę na kolejną
	before := h.count("N")
	_ = dc.SendText(`{"t":"ack"}`)
	waitUntil(t, "zgoda po potwierdzeniu kanałem bezpośrednim", func() bool { return h.count("N") > before })

	// zamknięcie kanału — dalej przez serwer
	_ = pc.Close()
	waitUntil(t, "powrót do drogi przez serwer", func() bool {
		h.emit(msgFrame, "po-zamknieciu")
		time.Sleep(20 * time.Millisecond)
		for _, f := range srv.got(1) {
			if f == "Fpo-zamknieciu" {
				return true
			}
		}
		return false
	})
}

// Podgląd nie steruje także kanałem bezpośrednim.
func TestDesktopRTCViewOnlyInput(t *testing.T) {
	var h *fakeHelper
	spawnHelperFn = func(...string) (helperProc, error) { h = newFakeHelper(); return h, nil }
	overlayFn = func(string) interface{ stop() } { return nil }
	t.Cleanup(func() { spawnHelperFn, overlayFn = spawnDesktopHelper, startSupportOverlay })
	srv := newFakeServer()
	ctx := withSession(context.Background(), srv.io)
	b, _ := json.Marshal(desktopOpenReq{Channel: 1, Consent: "none", Viewer: "Ola", ViewOnly: true})
	_, _ = handleDesktopOpen(ctx, b)
	v := srv.io.channels.get(1).(*desktopViewer)
	v.rtcInput([]byte(`{"t":"k","code":"KeyA","d":true}`))
	time.Sleep(50 * time.Millisecond)
	if h.countContaining(`"code":"KeyA"`) != 0 {
		t.Fatal("podgląd sterował kanałem bezpośrednim")
	}
	srv.io.channels.remove(1).close()
}
