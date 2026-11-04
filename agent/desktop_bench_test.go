package main

import (
	"math/rand/v2"
	"testing"
)

// syntheticScreen — 1920×1080 BGRA z gradientem, „tekstem” (ostre krawędzie) i lekkim szumem — jak zwykły pulpit.
func syntheticScreen(w, h int, seed uint64) []byte {
	r := rand.New(rand.NewPCG(seed, 1))
	b := make([]byte, w*h*4)
	for y := range h {
		for x := range w {
			i := (y*w + x) * 4
			v := byte((x + y) / 12)
			if (x/7+y/11)%5 == 0 && y%16 < 10 {
				v = 20 // „litery”
			}
			b[i], b[i+1], b[i+2], b[i+3] = v+byte(r.IntN(6)), v/2+byte(r.IntN(6)), 255-v, 255
		}
	}
	return b
}

// Najgorszy przypadek: zmienia się cały ekran (przewijanie, animacja, zmiana okna).
func BenchmarkEncodeFullFrame1080(b *testing.B) {
	frames := [][]byte{syntheticScreen(1920, 1080, 1), syntheticScreen(1920, 1080, 2)}
	var e frameEncoder
	b.SetBytes(int64(len(frames[0])))
	b.ResetTimer()
	for i := range b.N {
		if _, err := e.encode(frames[i%2], 1920, 1080, "medium"); err != nil {
			b.Fatal(err)
		}
	}
}

// Typowy przypadek: zmienia się mały fragment (kursor, zegar, wpisywany tekst).
func BenchmarkEncodeSmallChange1080(b *testing.B) {
	base := syntheticScreen(1920, 1080, 1)
	cur := append([]byte(nil), base...)
	var e frameEncoder
	_, _ = e.encode(base, 1920, 1080, "medium")
	b.ResetTimer()
	for i := range b.N {
		cur[(500*1920+900)*4] = byte(i) // jeden piksel = jeden kafelek
		if _, err := e.encode(cur, 1920, 1080, "medium"); err != nil {
			b.Fatal(err)
		}
	}
}

// Jak na kiosku z 4-rdzeniowym procesorem (3 wątki kodujące, jeden wolny dla programu kiosku).
func BenchmarkEncodeFullFrame1080ThreeWorkers(b *testing.B) {
	old := encodeWorkers
	encodeWorkers = 3
	defer func() { encodeWorkers = old }()
	BenchmarkEncodeFullFrame1080(b)
}
