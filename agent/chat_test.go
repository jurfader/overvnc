package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
)

type fakePeer struct {
	mu  sync.Mutex
	got []map[string]any
}

func (p *fakePeer) send(v any) error {
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	p.mu.Lock()
	p.got = append(p.got, m)
	p.mu.Unlock()
	return nil
}

func TestChatFlow(t *testing.T) {
	old := kioskDir
	kioskDir = t.TempDir()
	t.Cleanup(func() {
		kioskDir = old
		chat.loaded, chat.history, chat.outbox, chat.peers, chat.remote = false, nil, nil, nil, nil
	})
	p := &fakePeer{}
	chatAddPeer(p)
	// użytkownik pisze bez połączenia z serwerem — wiadomość czeka
	chatFromUser("anna", "  Nie działa drukarka  ")
	failing := func(string, any) error { return errors.New("brak połączenia") }
	if err := flushChat(failing); err == nil || len(chat.outbox) != 1 {
		t.Fatalf("wiadomość powinna czekać: %v, %d", err, len(chat.outbox))
	}
	var sent []chatMsg
	if err := flushChat(func(typ string, v any) error { sent = append(sent, v.(chatMsg)); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || sent[0].Text != "Nie działa drukarka" || sent[0].From != "user" || len(chat.outbox) != 0 {
		t.Fatalf("wysłane: %+v, kolejka %d", sent, len(chat.outbox))
	}
	// odpowiedź wsparcia: do okna; ponowne doręczenie tego samego id — bez dubla
	b, _ := json.Marshal(map[string]any{"id": 7, "author": "Paweł", "text": "Już sprawdzam"})
	r, err := handleChatSend(context.Background(), b)
	if err != nil || !r.(map[string]any)["delivered"].(bool) {
		t.Fatalf("doręczenie: %v %v", r, err)
	}
	_, _ = handleChatSend(context.Background(), b)
	n := 0
	for _, h := range chat.history {
		if h.ID == 7 {
			n++
		}
	}
	if n != 1 || len(chat.history) != 2 {
		t.Fatalf("historia: %+v", chat.history)
	}
	// historia przetrwa restart usługi (plik)
	chat.loaded, chat.history = false, nil
	chat.mu.Lock()
	chatLoadLocked()
	chat.mu.Unlock()
	if len(chat.history) != 2 {
		t.Fatalf("po wczytaniu: %d", len(chat.history))
	}
	if len(p.got) < 4 { // history, status, chat (user), chat (operator)
		t.Fatalf("okno dostało: %+v", p.got)
	}
}
