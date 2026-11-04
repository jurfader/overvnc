package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sync"
	"time"
)

// helperProc — uruchomiony proces pomocniczy pulpitu (Windows: w sesji użytkownika jako SYSTEM).
type helperProc interface {
	stdin() io.Writer
	stdout() io.Reader
	wait()
	kill()
}

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
	proc helperProc
	mu   sync.Mutex
	once sync.Once
}

func (d *desktopSession) toHelper(typ byte, p []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return writeMsg(d.proc.stdin(), typ, p)
}

// write — zdarzenie wejścia z przeglądarki (JSON) do pomocnika.
func (d *desktopSession) write(p []byte) error { return d.toHelper(msgEvent, p) }

// ack — przeglądarka narysowała klatkę: pozwól pomocnikowi wysłać kolejną.
func (d *desktopSession) ack(int) { _ = d.toHelper(msgNext, nil) }

func (d *desktopSession) close() {
	d.once.Do(func() {
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
	proc, err := spawnDesktopHelper()
	if err != nil {
		return nil, protoErr("helper", "nie można uruchomić przechwytywania ekranu: %v", err)
	}
	d := &desktopSession{proc: proc}
	if err := sess.channels.add(req.Channel, d); err != nil {
		proc.kill()
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
			case msgFrame, msgInfo:
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
		proc.wait()
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
