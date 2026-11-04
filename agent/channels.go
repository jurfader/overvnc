package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	pty "github.com/aymanbagabas/go-pty"
)

// Ramki binarne (strumienie: terminal, później pulpit i pliki):
//
//	[1 bajt: rodzaj][4 bajty: numer kanału, big-endian][dane]
const (
	frameData byte = 1

	maxTerminals = 8
	termReadBuf  = 32 * 1024
)

func encodeFrame(kind byte, ch uint32, payload []byte) []byte {
	b := make([]byte, 5+len(payload))
	b[0] = kind
	binary.BigEndian.PutUint32(b[1:5], ch)
	copy(b[5:], payload)
	return b
}

func decodeFrame(b []byte) (kind byte, ch uint32, payload []byte, err error) {
	if len(b) < 5 {
		return 0, 0, nil, errors.New("za krótka ramka")
	}
	return b[0], binary.BigEndian.Uint32(b[1:5]), b[5:], nil
}

// sessionIO — to, czego handlery strumieniowe potrzebują od połączenia z serwerem.
type sessionIO struct {
	writeBinary func([]byte) error
	event       func(typ string, data any) error
	channels    *channelManager
}

type sessionKey struct{}

func withSession(ctx context.Context, s *sessionIO) context.Context {
	return context.WithValue(ctx, sessionKey{}, s)
}

func sessionFrom(ctx context.Context) (*sessionIO, error) {
	s, ok := ctx.Value(sessionKey{}).(*sessionIO)
	if !ok || s == nil {
		return nil, protoErr("no_session", "brak sesji")
	}
	return s, nil
}

// ---------- menedżer kanałów ----------

type stream interface {
	write(p []byte) error
	resize(cols, rows int) error
	close()
}

type channelManager struct {
	mu sync.Mutex
	m  map[uint32]stream
}

func newChannelManager() *channelManager { return &channelManager{m: map[uint32]stream{}} }

func (c *channelManager) add(id uint32, s stream) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.m[id]; exists {
		return protoErr("channel_exists", "kanał %d jest już otwarty", id)
	}
	if len(c.m) >= maxTerminals {
		return protoErr("too_many_channels", "otwartych jest już %d sesji na tym komputerze", maxTerminals)
	}
	c.m[id] = s
	return nil
}

func (c *channelManager) get(id uint32) stream {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.m[id]
}

func (c *channelManager) remove(id uint32) stream {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.m[id]
	delete(c.m, id)
	return s
}

// closeAll — przy zerwaniu połączenia z serwerem wszystkie powłoki są kończone.
func (c *channelManager) closeAll() {
	c.mu.Lock()
	all := c.m
	c.m = map[uint32]stream{}
	c.mu.Unlock()
	for _, s := range all {
		s.close()
	}
}

// handleFrame — dane od serwera (np. naciśnięte klawisze) do kanału.
func (c *channelManager) handleFrame(b []byte) {
	kind, ch, payload, err := decodeFrame(b)
	if err != nil || kind != frameData {
		return
	}
	if s := c.get(ch); s != nil {
		_ = s.write(payload)
	}
}

// ---------- terminal ----------

type termOpenReq struct {
	Channel uint32 `json:"channel"`
	Cols    int    `json:"cols"`
	Rows    int    `json:"rows"`
	Shell   string `json:"shell"`
}

type termSession struct {
	p    pty.Pty
	cmd  *pty.Cmd
	in   chan []byte // kolejka wejścia — zapis do PTY nie może blokować odczytu z WebSocketu
	done chan struct{}
	once sync.Once
}

const termInputQueue = 1024

func newTermSession(p pty.Pty, cmd *pty.Cmd) *termSession {
	t := &termSession{p: p, cmd: cmd, in: make(chan []byte, termInputQueue), done: make(chan struct{})}
	go func() {
		for {
			select {
			case <-t.done:
				return
			case b := <-t.in:
				if _, err := t.p.Write(b); err != nil {
					return
				}
			}
		}
	}()
	return t
}

func (t *termSession) write(p []byte) error {
	select {
	case t.in <- p:
		return nil
	case <-t.done:
		return io.ErrClosedPipe
	default:
		// powłoka nie nadąża z odczytem (np. wklejono ogromny tekst) — lepiej przerwać niż blokować połączenie
		go t.close()
		return errors.New("przepełniona kolejka wejścia terminala")
	}
}
func (t *termSession) resize(cols, rows int) error {
	return t.p.Resize(cols, rows)
}
func (t *termSession) close() {
	t.once.Do(func() {
		close(t.done)
		if t.cmd.Process != nil {
			_ = t.cmd.Process.Kill()
		}
		_ = t.p.Close()
	})
}

func clampSize(cols, rows int) (int, int) {
	return min(max(cols, 10), 500), min(max(rows, 5), 300)
}

func handleTermOpen(ctx context.Context, data json.RawMessage) (any, error) {
	sess, err := sessionFrom(ctx)
	if err != nil {
		return nil, err
	}
	var req termOpenReq
	if err := json.Unmarshal(data, &req); err != nil || req.Channel == 0 {
		return nil, protoErr("bad_request", "nieprawidłowe żądanie terminala")
	}
	shell, ok := findShell(req.Shell)
	if !ok {
		return nil, protoErr("bad_shell", "powłoka %q jest niedostępna", req.Shell)
	}

	p, err := pty.New()
	if err != nil {
		return nil, protoErr("pty", "nie można utworzyć terminala: %v", err)
	}
	cols, rows := clampSize(req.Cols, req.Rows)
	_ = p.Resize(cols, rows)

	cmd := p.Command(shell.path, shell.args...)
	cmd.Env = shellEnv()
	cmd.Dir = shellDir()
	if err := cmd.Start(); err != nil {
		_ = p.Close()
		return nil, protoErr("spawn", "nie można uruchomić %s: %v", shell.name, err)
	}
	t := newTermSession(p, cmd)
	if err := sess.channels.add(req.Channel, t); err != nil {
		t.close()
		return nil, err
	}

	// wyjście powłoki -> serwer; koniec procesu -> zdarzenie channel.closed
	go func() {
		buf := make([]byte, termReadBuf)
		for {
			n, err := p.Read(buf)
			if n > 0 {
				if werr := sess.writeBinary(encodeFrame(frameData, req.Channel, buf[:n])); werr != nil {
					break
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					logger.Infof("terminal %d: %v", req.Channel, err)
				}
				break
			}
		}
		exit := -1
		done := make(chan struct{})
		go func() {
			if cmd.Wait() == nil || cmd.ProcessState != nil {
				exit = cmd.ProcessState.ExitCode()
			}
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
		}
		sess.channels.remove(req.Channel)
		t.close()
		_ = sess.event("channel.closed", map[string]any{"channel": req.Channel, "exitCode": exit})
	}()

	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
	}
	return map[string]any{"pid": pid, "shell": shell.name}, nil
}

func handleTermResize(ctx context.Context, data json.RawMessage) (any, error) {
	sess, err := sessionFrom(ctx)
	if err != nil {
		return nil, err
	}
	var req struct {
		Channel uint32 `json:"channel"`
		Cols    int    `json:"cols"`
		Rows    int    `json:"rows"`
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, protoErr("bad_request", "nieprawidłowe żądanie")
	}
	s := sess.channels.get(req.Channel)
	if s == nil {
		return nil, protoErr("no_channel", "kanał nie istnieje")
	}
	cols, rows := clampSize(req.Cols, req.Rows)
	return map[string]bool{"ok": true}, s.resize(cols, rows)
}

func handleChannelClose(ctx context.Context, data json.RawMessage) (any, error) {
	sess, err := sessionFrom(ctx)
	if err != nil {
		return nil, err
	}
	var req struct {
		Channel uint32 `json:"channel"`
	}
	_ = json.Unmarshal(data, &req)
	if s := sess.channels.remove(req.Channel); s != nil {
		s.close()
	}
	return map[string]bool{"ok": true}, nil
}

func init() {
	handlers["term.open"] = handleTermOpen
	handlers["term.resize"] = handleTermResize
	handlers["channel.close"] = handleChannelClose
}
