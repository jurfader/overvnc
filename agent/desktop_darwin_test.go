//go:build darwin

package main

import (
	"os"
	"testing"
	"time"
)

// Test na prawdziwym Macu (OVERVNC_MAC_SMOKE=1): monitory przez purego (struktury CGRect), zgody,
// a gdy proces ma zgodę na nagrywanie — format obrazu. Bez wstrzykiwania wejścia.
func TestMacDesktopSmoke(t *testing.T) {
	if os.Getenv("OVERVNC_MAC_SMOKE") != "1" {
		t.Skip("tylko ręcznie: OVERVNC_MAC_SMOKE=1")
	}
	if err := loadCG(); err != nil {
		t.Fatal(err)
	}
	b := &macBackend{}
	mons, _ := b.monitors()
	if len(mons) == 0 {
		t.Fatal("brak monitorów")
	}
	for _, m := range mons {
		t.Logf("monitor %d %q: %d,%d %dx%d główny=%v", m.Index, m.Name, m.X, m.Y, m.W, m.H, m.Primary)
	}
	screen, input := cgPreflightScreenCaptureAccess(), axIsProcessTrusted()
	t.Logf("zgody: nagrywanie ekranu=%v, dostępność=%v, notice=%q", screen, input, b.notice())
	if !screen {
		t.Log("bez zgody na nagrywanie — pomijam przechwytywanie (bez okna z prośbą)")
		return
	}
	buf, w, h, err := b.capture(mons[0])
	if err != nil {
		t.Fatal(err)
	}
	var sum, alpha int
	for i := 0; i < len(buf); i += 4 * 97 {
		sum += int(buf[i]) + int(buf[i+1]) + int(buf[i+2])
		alpha += int(buf[i+3])
	}
	t.Logf("obraz %dx%d, bajtów %d, niezerowy=%v, alfa≈%d", w, h, len(buf), sum > 0, alpha/(len(buf)/(4*97)))
	if w != mons[0].W || h != mons[0].H || len(buf) != w*h*4 || sum == 0 {
		t.Fatal("nieprawidłowy obraz")
	}
}

func TestMacCaptureSpeed(t *testing.T) {
	if os.Getenv("OVERVNC_MAC_SMOKE") != "1" || loadCG() != nil || !cgPreflightScreenCaptureAccess() {
		t.Skip("tylko ręcznie: OVERVNC_MAC_SMOKE=1 i zgoda na nagrywanie")
	}
	b := &macBackend{}
	mons, _ := b.monitors()
	start := time.Now()
	const n = 20
	for range n {
		if _, _, _, err := b.capture(mons[0]); err != nil {
			t.Fatal(err)
		}
	}
	per := time.Since(start) / n
	t.Logf("przechwycenie %dx%d: %v na klatkę (maks. %.0f kl./s)", mons[0].W, mons[0].H, per, float64(time.Second)/float64(per))
}
