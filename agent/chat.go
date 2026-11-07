package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Czat użytkownika komputera ze wsparciem (usługa agenta). Ikona w zasobniku (proces w sesji użytkownika)
// łączy się z usługą lokalnym kanałem; usługa przekazuje wiadomości na serwer i z serwera, trzyma ostatnie
// wiadomości (okno czatu pokazuje historię) i kolejkę wiadomości napisanych bez połączenia z serwerem.

type chatMsg struct {
	ID     int64  `json:"id,omitempty"` // id na serwerze (wiadomości od wsparcia)
	TS     int64  `json:"ts"`
	From   string `json:"from"` // user | operator
	Author string `json:"author"`
	Text   string `json:"text"`
}

const (
	chatHistoryMax = 100
	chatTextMax    = 4000
)

// trayPeer — połączony proces ikony w zasobniku (jedna sesja użytkownika).
type trayPeer interface {
	send(v any) error
}

var chat struct {
	mu      sync.Mutex
	loaded  bool
	history []chatMsg
	outbox  []chatMsg // do wysłania na serwer
	peers   map[trayPeer]bool
	remote  []string // kto jest połączony z pulpitem
}

// serverOnline — agent ma połączenie z serwerem (okno czatu pokazuje stan).
var serverOnline atomic.Bool

// chatNow — są wiadomości do wysłania (pętla połączenia z serwerem).
var chatNow = make(chan struct{}, 1)

func chatFile() string { return kioskFile("chat.json") }

func chatLoadLocked() {
	if chat.loaded {
		return
	}
	chat.loaded = true
	if chat.peers == nil {
		chat.peers = map[trayPeer]bool{}
	}
	var st struct {
		History []chatMsg `json:"history"`
		Outbox  []chatMsg `json:"outbox"`
	}
	if b, err := os.ReadFile(chatFile()); err == nil && json.Unmarshal(b, &st) == nil {
		chat.history, chat.outbox = st.History, st.Outbox
	}
}

func chatSaveLocked() {
	b, _ := json.Marshal(map[string]any{"history": chat.history, "outbox": chat.outbox})
	_ = os.WriteFile(chatFile(), b, 0o600)
}

func chatAppendLocked(m chatMsg) {
	chat.history = append(chat.history, m)
	if n := len(chat.history); n > chatHistoryMax {
		chat.history = chat.history[n-chatHistoryMax:]
	}
}

func chatBroadcastLocked(v any) int {
	n := 0
	for p := range chat.peers {
		if p.send(v) == nil {
			n++
		} else {
			delete(chat.peers, p)
		}
	}
	return n
}

// chatFromUser — wiadomość napisana w oknie czatu: do historii i do kolejki na serwer.
func chatFromUser(author, text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if r := []rune(text); len(r) > chatTextMax {
		text = string(r[:chatTextMax])
	}
	m := chatMsg{TS: time.Now().UnixMilli(), From: "user", Author: author, Text: text}
	chat.mu.Lock()
	chatLoadLocked()
	chatAppendLocked(m)
	chat.outbox = append(chat.outbox, m)
	chatSaveLocked()
	chatBroadcastLocked(map[string]any{"t": "chat", "msg": m})
	chat.mu.Unlock()
	select {
	case chatNow <- struct{}{}:
	default:
	}
}

// flushChat — wysyła zaległe wiadomości (po połączeniu i po nowej wiadomości).
func flushChat(send func(string, any) error) error {
	chat.mu.Lock()
	chatLoadLocked()
	out := append([]chatMsg(nil), chat.outbox...)
	chat.mu.Unlock()
	for i, m := range out {
		if err := send("chat", m); err != nil {
			chat.mu.Lock()
			chat.outbox = chat.outbox[i:]
			chatSaveLocked()
			chat.mu.Unlock()
			return err
		}
	}
	chat.mu.Lock()
	chat.outbox = chat.outbox[len(out):]
	chatSaveLocked()
	chat.mu.Unlock()
	return nil
}

// handleChatSend — wiadomość od wsparcia (panel) do użytkownika komputera.
func handleChatSend(_ context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		ID     int64  `json:"id"`
		TS     int64  `json:"ts"`
		Author string `json:"author"`
		Text   string `json:"text"`
	}](data)
	if err != nil || strings.TrimSpace(req.Text) == "" {
		return nil, protoErr("bad_request", "pusta wiadomość")
	}
	m := chatMsg{ID: req.ID, TS: req.TS, From: "operator", Author: req.Author, Text: req.Text}
	if m.TS == 0 {
		m.TS = time.Now().UnixMilli()
	}
	chat.mu.Lock()
	defer chat.mu.Unlock()
	chatLoadLocked()
	for _, h := range chat.history {
		if m.ID != 0 && h.ID == m.ID {
			return map[string]any{"delivered": len(chat.peers) > 0}, nil // ponowne doręczenie
		}
	}
	chatAppendLocked(m)
	chatSaveLocked()
	n := chatBroadcastLocked(map[string]any{"t": "chat", "msg": m})
	return map[string]any{"delivered": n > 0}, nil
}

// chatAddPeer — nowe okno/ikona: historia i stan na start.
func chatAddPeer(p trayPeer) {
	chat.mu.Lock()
	defer chat.mu.Unlock()
	chatLoadLocked()
	chat.peers[p] = true
	_ = p.send(map[string]any{"t": "history", "items": chat.history})
	_ = p.send(trayStatusLocked())
}

func chatRemovePeer(p trayPeer) {
	chat.mu.Lock()
	delete(chat.peers, p)
	chat.mu.Unlock()
}

func trayStatusLocked() map[string]any {
	return map[string]any{"t": "status", "online": serverOnline.Load(), "remote": chat.remote, "computer": hostnameOr("")}
}

// trayStatusChanged — zmiana połączenia z serwerem albo listy osób na pulpicie.
func trayStatusChanged() {
	chat.mu.Lock()
	defer chat.mu.Unlock()
	chatLoadLocked()
	chatBroadcastLocked(trayStatusLocked())
}

// setRemoteViewers — kto ogląda pulpit (z grupy pulpitu).
func setRemoteViewers(names []string) {
	chat.mu.Lock()
	chat.remote = names
	chat.mu.Unlock()
	trayStatusChanged()
}

func hostnameOr(def string) string {
	if h, err := os.Hostname(); err == nil {
		return h
	}
	return def
}

func init() {
	handlers["chat.send"] = handleChatSend
}
