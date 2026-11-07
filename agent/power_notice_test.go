package main

import (
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFormatCountdown(t *testing.T) {
	for d, want := range map[time.Duration]string{
		14*time.Minute + 32*time.Second: "14:32",
		65*time.Minute + 9*time.Second:  "1:05:09",
		500 * time.Millisecond:          "0:01",
		-time.Second:                    "0:00",
	} {
		if got := formatCountdown(d); got != want {
			t.Errorf("%v: %q, oczekiwano %q", d, got, want)
		}
	}
}

func TestPowerNoticeRender(t *testing.T) {
	msg := "Instalacja aktualizacji systemu i programu księgowego — po restarcie wszystko będzie działać jak wcześniej, prosimy o cierpliwość i zapisanie dokumentów."
	for _, sc := range []float64{1, 1.5} {
		L := powerNoticeLayout(sc, msg)
		if len(L.msgLines) != pnMsgMaxLines {
			t.Fatalf("komunikat: %d linii", len(L.msgLines))
		}
		img, btn := renderPowerNotice(L, powerNoticeState{Action: "reboot", Remaining: 14 * time.Minute, Message: msg})
		if img.Bounds().Dx() != L.w || img.Bounds().Dy() != L.h || btn != L.collapse {
			t.Fatalf("rozmiar/przycisk: %v %v", img.Bounds(), btn)
		}
		// zwinięta: tylko plakietka w prawym dolnym rogu, reszta przezroczysta (przeklikiwalna)
		img, pill := renderPowerNotice(L, powerNoticeState{Action: "reboot", Remaining: 14 * time.Minute, Collapsed: true})
		if pill.Max != img.Bounds().Max || img.RGBAAt(2, 2).A != 0 {
			t.Fatalf("plakietka %v, róg %v", pill, img.RGBAAt(2, 2))
		}
		// ostatnia minuta: rozwinięta mimo zwinięcia, bez przycisku
		_, none := renderPowerNotice(L, powerNoticeState{Action: "shutdown", Remaining: 30 * time.Second, Collapsed: true})
		if !none.Empty() {
			t.Fatalf("w ostatniej minucie bez zwijania: %v", none)
		}
	}
	if dir := os.Getenv("OVERLAY_PREVIEW"); dir != "" {
		L := powerNoticeLayout(1.5, "Instalacja aktualizacji — zapisz dokumenty.")
		states := []powerNoticeState{
			{Action: "reboot", Remaining: 14*time.Minute + 32*time.Second, Message: "x"},
			{Action: "reboot", Remaining: 9*time.Minute + 5*time.Second, Collapsed: true, Hover: true},
			{Action: "shutdown", Remaining: 42 * time.Second},
		}
		bg := image.NewRGBA(image.Rect(0, 0, len(states)*(L.w+30)+30, L.h+60))
		draw.Draw(bg, bg.Bounds(), image.NewUniform(color.RGBA{70, 110, 160, 255}), image.Point{}, draw.Src)
		for i, st := range states {
			img, _ := renderPowerNotice(L, st)
			draw.Draw(bg, img.Bounds().Add(image.Pt(30+i*(L.w+30), 30)), img, image.Point{}, draw.Over)
		}
		f, _ := os.Create(filepath.Join(dir, "power-notice.png"))
		_ = png.Encode(f, bg)
		f.Close()
	}
}

func TestPowerPendingLifecycle(t *testing.T) {
	old := kioskDir
	kioskDir = t.TempDir()
	reset := func() {
		powerState.mu.Lock()
		powerState.loaded, powerState.pending = false, nil
		powerState.mu.Unlock()
	}
	reset()
	t.Cleanup(func() { kioskDir = old; reset() })

	powerScheduled(powerReq{Action: "reboot", DelayMinutes: 15, Message: "Aktualizacja"})
	p := currentPowerPending()
	if p == nil || p.Action != "reboot" || p.Message != "Aktualizacja" {
		t.Fatalf("plan: %+v", p)
	}
	if left := time.Until(time.UnixMilli(p.At)); left < 14*time.Minute || left > 15*time.Minute {
		t.Fatalf("termin za %v", left)
	}
	if v := p.view(); v["remainingSec"].(int64) < 14*60 {
		t.Fatalf("pozostało %v", v["remainingSec"])
	}
	// plan przetrwa restart usługi (plik)
	reset()
	if q := currentPowerPending(); q == nil || q.At != p.At {
		t.Fatalf("po wczytaniu: %+v", q)
	}
	// anulowanie i restart natychmiastowy czyszczą plan
	powerScheduled(powerReq{Action: "cancel"})
	if currentPowerPending() != nil {
		t.Fatal("plan po anulowaniu")
	}
	powerScheduled(powerReq{Action: "shutdown", DelayMinutes: 5})
	powerScheduled(powerReq{Action: "reboot"})
	if currentPowerPending() != nil {
		t.Fatal("plan po restarcie natychmiastowym")
	}
	// przeterminowany (restart się odbył) — znika
	setPowerPending(&PowerPending{Action: "reboot", At: time.Now().Add(-powerPendingGrace - time.Second).UnixMilli()})
	if currentPowerPending() != nil {
		t.Fatal("przeterminowany plan")
	}
	var nilP *PowerPending
	if nilP.view() != nil {
		t.Fatal("brak planu = null")
	}
}
