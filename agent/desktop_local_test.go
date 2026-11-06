package main

import (
	"testing"
	"time"
)

func TestRemoteGate(t *testing.T) {
	g := newRemoteGate()
	down := func(code string) InputEvent { return InputEvent{T: "k", Code: code, D: true} }
	up := func(code string) InputEvent { return InputEvent{T: "k", Code: code} }

	// bez osoby przy komputerze — wszystko przechodzi
	if !g.allow(InputEvent{T: "m", X: .5}, false) || !g.allow(down("ShiftLeft"), false) {
		t.Fatal("zdarzenia zablokowane bez powodu")
	}
	// osoba przy komputerze aktywna: ruch i nowe klawisze czekają
	if g.allow(InputEvent{T: "m", X: .5}, true) || g.allow(down("KeyA"), true) || g.allow(InputEvent{T: "w", DY: 120}, true) {
		t.Fatal("zdalne wejście przeszło mimo aktywnej osoby przy komputerze")
	}
	// zwolnienie klawisza zablokowanego przy wciśnięciu nie trafia do komputera (nie psuje lokalnego pisania)
	if g.allow(up("KeyA"), true) || g.allow(up("KeyA"), false) {
		t.Fatal("zwolnienie niewciśniętego zdalnie klawisza przeszło")
	}
	// przejęcie: zwalniamy to, co zdalnie wciśnięte (Shift)
	rel := g.releaseAll()
	if len(rel) != 1 || rel[0].Code != "ShiftLeft" || rel[0].D {
		t.Fatalf("releaseAll = %+v", rel)
	}
	// potem zwolnienie Shift z przeglądarki już nic nie robi
	if g.allow(up("ShiftLeft"), false) {
		t.Fatal("podwójne zwolnienie")
	}
	// przycisk myszy wciśnięty zdalnie: zwolnienie przechodzi nawet w trakcie blokady
	if !g.allow(InputEvent{T: "b", B: 0, D: true}, false) || !g.allow(InputEvent{T: "b", B: 0}, true) {
		t.Fatal("zwolnienie przycisku zablokowane")
	}
	// przycisk do zwolnienia „w miejscu”
	g.allow(InputEvent{T: "b", B: 2, D: true}, false)
	if rel := g.releaseAll(); len(rel) != 1 || rel[0].B != 2 || rel[0].X >= 0 {
		t.Fatalf("releaseAll przycisku = %+v", rel)
	}
}

func TestLocalActive(t *testing.T) {
	localInputAt.Store(0)
	now := time.Now()
	if localActive(now) {
		t.Fatal("aktywny bez wejścia")
	}
	markLocalInput()
	if !localActive(time.Now()) || localActive(time.Now().Add(localGrace+time.Millisecond)) {
		t.Fatal("zły czas pierwszeństwa")
	}
	localInputAt.Store(0)
}
