package main

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// Zaplanowany restart / wyłączenie (power.action z opóźnieniem): agent pamięta termin (plik — przetrwa
// restart usługi), zgłasza go serwerowi (panel pokazuje odliczanie) i pokazuje użytkownikowi komputera
// okienko z odliczaniem i prośbą o zapisanie pracy.

type PowerPending struct {
	Action  string `json:"action"` // reboot | shutdown
	At      int64  `json:"at"`     // termin (ms, zegar komputera)
	Message string `json:"message,omitempty"`
}

// powerPendingView — dla serwera: także pozostały czas (serwer liczy termin swoim zegarem).
func (p *PowerPending) view() map[string]any {
	if p == nil {
		return nil
	}
	return map[string]any{"action": p.Action, "at": p.At, "message": p.Message, "remainingSec": max(0, (p.At-time.Now().UnixMilli())/1000)}
}

// po terminie (z zapasem na zamykanie systemu) plan jest nieaktualny — restart się odbył albo ktoś go
// anulował na komputerze (shutdown /a)
const powerPendingGrace = 2 * time.Minute

var powerState struct {
	mu      sync.Mutex
	loaded  bool
	pending *PowerPending
}

// powerNow — zmiana planu (zgłoszenie do serwera); powerNoticeNow — okienko na ekranie.
var (
	powerNow       = make(chan struct{}, 1)
	powerNoticeNow = make(chan struct{}, 1)
)

func powerFile() string { return kioskFile("power-pending.json") }

func kick(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

func currentPowerPending() *PowerPending {
	powerState.mu.Lock()
	defer powerState.mu.Unlock()
	if !powerState.loaded {
		powerState.loaded = true
		var p PowerPending
		if b, err := os.ReadFile(powerFile()); err == nil && json.Unmarshal(b, &p) == nil && p.At > 0 {
			powerState.pending = &p
		}
	}
	if p := powerState.pending; p != nil && time.Now().After(time.UnixMilli(p.At).Add(powerPendingGrace)) {
		powerState.pending = nil
		_ = os.Remove(powerFile())
	}
	if powerState.pending == nil {
		return nil
	}
	c := *powerState.pending
	return &c
}

func setPowerPending(p *PowerPending) {
	currentPowerPending() // wczytanie stanu z pliku
	powerState.mu.Lock()
	powerState.pending = p
	if p == nil {
		_ = os.Remove(powerFile())
	} else if b, err := json.Marshal(p); err == nil {
		_ = os.WriteFile(powerFile(), b, 0o644)
	}
	powerState.mu.Unlock()
	kick(powerNow)
	kick(powerNoticeNow)
}

// powerScheduled — po udanym power.action: zapamiętaj plan (restart/wyłączenie z opóźnieniem) albo go usuń.
func powerScheduled(req powerReq) {
	switch req.Action {
	case "reboot", "shutdown":
		if req.DelayMinutes > 0 {
			setPowerPending(&PowerPending{Action: req.Action, At: time.Now().Add(time.Duration(req.DelayMinutes) * time.Minute).UnixMilli(), Message: req.Message})
		} else {
			setPowerPending(nil)
		}
	case "cancel":
		setPowerPending(nil)
	}
}
