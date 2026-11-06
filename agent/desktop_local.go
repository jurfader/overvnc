package main

import (
	"sync/atomic"
	"time"
)

// Pierwszeństwo dla osoby przy komputerze: gdy fizycznie rusza myszą albo pisze, zdalne sterowanie
// czeka (jak w AnyDesk/TeamViewer). Zdarzenia wstrzykiwane przez agenta nie liczą się jako „lokalne”:
// Windows oznacza je flagą LLMHF_INJECTED / LLKHF_INJECTED w hakach niskiego poziomu, a macOS podaje
// w zdarzeniu numer procesu, który je wysłał.

// localGrace — tyle po ostatnim ruchu/klawiszu osoby przy komputerze zdalne sterowanie jeszcze czeka.
const localGrace = 1500 * time.Millisecond

var localInputAt atomic.Int64 // UnixNano ostatniego fizycznego wejścia

func markLocalInput() { localInputAt.Store(time.Now().UnixNano()) }

// localActive — czy osoba przy komputerze używała myszy/klawiatury w ostatnich localGrace.
func localActive(now time.Time) bool {
	t := localInputAt.Load()
	return t != 0 && now.Sub(time.Unix(0, t)) < localGrace
}

// remoteGate — decyduje, które zdalne zdarzenia przepuścić, i pamięta, co zdalnie jest wciśnięte,
// żeby nie zostawić „zawieszonego” klawisza ani przycisku.
type remoteGate struct {
	yield bool            // pierwszeństwo dla osoby przy komputerze (włączone domyślnie)
	held  map[string]bool // zdalnie wciśnięte: "b0".."b2", "kKeyA"…
}

func newRemoteGate() *remoteGate { return &remoteGate{yield: true, held: map[string]bool{}} }

func heldKey(ev InputEvent) string {
	switch ev.T {
	case "b":
		return "b" + string(rune('0'+ev.B))
	case "k":
		return "k" + ev.Code
	}
	return ""
}

// allow — czy zdarzenie ma trafić do komputera. Zwolnienie przycisku/klawisza wciśniętego zdalnie
// przechodzi zawsze; zwolnienie czegoś, czego zdalnie nie wciśnięto, nigdy (nie psuje przeciągania
// osoby przy komputerze).
func (g *remoteGate) allow(ev InputEvent, blocked bool) bool {
	key := heldKey(ev)
	if key != "" && !ev.D {
		if !g.held[key] {
			return false
		}
		delete(g.held, key)
		return true
	}
	if blocked {
		return false
	}
	if key != "" {
		g.held[key] = true
	}
	return true
}

// releaseAll — zdarzenia zwalniające wszystko, co zdalnie wciśnięte (gdy osoba przy komputerze przejmuje).
func (g *remoteGate) releaseAll() []InputEvent {
	var out []InputEvent
	for k := range g.held {
		if k[0] == 'b' {
			out = append(out, InputEvent{T: "b", B: int(k[1] - '0'), X: -1})
		} else {
			out = append(out, InputEvent{T: "k", Code: k[1:]})
		}
	}
	clear(g.held)
	return out
}
