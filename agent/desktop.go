package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
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

// desktopSession — kanał pulpitu: wejście od serwera -> pomocnik, klatki pomocnika -> serwer.
type desktopSession struct {
	proc    helperProc
	mu      sync.Mutex
	once    sync.Once
	closing atomic.Bool // zamknięcie zlecone przez nas (kod wyjścia pomocnika nie świadczy o awarii)
}

func (d *desktopSession) toHelper(typ byte, p []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return writeMsg(d.proc.stdin(), typ, p)
}

// write — zdarzenie wejścia z przeglądarki (JSON) do pomocnika. Ctrl+Alt+Del wysyła sama usługa
// (Windows przyjmuje je tylko od usługi działającej jako SYSTEM).
func (d *desktopSession) write(p []byte) error {
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
	return d.toHelper(msgEvent, p)
}

// ack — przeglądarka narysowała klatkę: pozwól pomocnikowi wysłać kolejną.
func (d *desktopSession) ack(int) { _ = d.toHelper(msgNext, nil) }

func (d *desktopSession) close() {
	d.once.Do(func() {
		d.closing.Store(true)
		_ = d.toHelper(msgQuit, nil)
		go func() {
			time.Sleep(2 * time.Second)
			d.proc.kill()
		}()
	})
}

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
	var args []string
	if captureGDIOnly.Load() {
		args = append(args, "gdi")
	}

	proc, err := spawnDesktopHelper(args...)
	if err != nil {
		return nil, protoErr("helper", "nie można uruchomić przechwytywania ekranu: %v", err)
	}
	d := &desktopSession{proc: proc}
	// użytkownik ma wiedzieć, że ktoś jest połączony — ramka przez całą sesję (tryby „z powiadomieniem” i „z pytaniem”)
	var overlay interface{ stop() }
	if req.Consent == "notify" || req.Consent == "ask" {
		overlay = startSupportOverlay(req.Viewer)
	}
	if err := sess.channels.add(req.Channel, d); err != nil {
		proc.kill()
		if overlay != nil {
			overlay.stop()
		}
		return nil, err
	}
	// ustawienia początkowe i zgoda na 2 klatki „w drodze”
	cfg, _ := json.Marshal(InputEvent{T: "cfg", Quality: req.Quality, Monitor: req.Monitor})
	_ = d.toHelper(msgEvent, cfg)
	for range helperMaxCredits {
		_ = d.toHelper(msgNext, nil)
	}

	go func() {
		r := bufio.NewReaderSize(proc.stdout(), 256<<10)
		reason := ""
		for {
			typ, p, err := readMsg(r)
			if err != nil {
				break
			}
			switch typ {
			case msgFrame, msgInfo, msgClip:
				// do serwera bez dzielenia na kawałki — przeglądarka dostaje całą klatkę jednym komunikatem
				if sess.writeBinary(encodeFrame(frameData, req.Channel, append([]byte{typ}, p...))) != nil {
					reason = "connection"
				}
			case msgLog:
				reason = string(p)
				logger.Infof("pulpit %d: %s", req.Channel, p)
			}
			if reason == "connection" {
				break
			}
		}
		code := proc.wait()
		if overlay != nil {
			overlay.stop()
		}
		if helperCrashed(code) && !d.closing.Load() && !captureGDIOnly.Swap(true) {
			logger.Warningf("pulpit %d: pomocnik zakończył się awarią (kod %#x) — kolejne sesje przez GDI", req.Channel, uint32(code))
		}
		if sess.channels.remove(req.Channel) != nil {
			ev := map[string]any{"channel": req.Channel, "exitCode": 0}
			if reason != "" && reason != "connection" {
				ev["error"] = reason
			}
			_ = sess.event("channel.closed", ev)
		}
	}()
	return map[string]any{"ok": true}, nil
}

func init() {
	if desktopSupported() {
		handlers["desktop.open"] = handleDesktopOpen
	}
}
