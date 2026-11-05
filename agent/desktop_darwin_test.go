//go:build darwin

package main

import (
	"os"
	"os/exec"
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
	defer b.close()
	// strumień startuje asynchronicznie — pierwsza klatka po chwili
	var buf []byte
	var w, h int
	var err error
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if buf, w, h, err = b.capture(mons[0]); err != errNoChange || time.Now().After(deadline) {
			break
		}
	}
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

// ScreenCaptureKit: strumień, pierwsza klatka, klatki tylko przy zmianach, pełna klatka na żądanie.
func TestMacSCKStream(t *testing.T) {
	if os.Getenv("OVERVNC_MAC_SMOKE") != "1" || loadCG() != nil || !cgPreflightScreenCaptureAccess() {
		t.Skip("tylko ręcznie: OVERVNC_MAC_SMOKE=1 i zgoda na nagrywanie")
	}
	b := &macBackend{}
	defer b.close()
	mons, _ := b.monitors()
	m := mons[0]
	var frames, nochange int
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		buf, w, h, err := b.capture(m)
		switch {
		case err == errNoChange:
			nochange++
		case err != nil:
			t.Fatal(err)
		default:
			frames++
			if w != m.W || h != m.H || len(buf) != w*h*4 {
				t.Fatalf("zły rozmiar %dx%d", w, h)
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Logf("metoda: sck=%v, klatek z obrazem: %d, bez zmian: %d", b.sck != nil, frames, nochange)
	if b.sck == nil || frames == 0 {
		t.Fatal("ScreenCaptureKit nie dostarczył obrazu")
	}
	b.invalidate()
	if _, _, _, err := b.capture(m); err != nil {
		t.Fatalf("pełna klatka na żądanie: %v", err)
	}
}

// prośba o zgodę „Dostępność” — budowanie słownika opcji przez purego/objc nie może się wysypać.
// Gdy proces ma już zgodę, macOS nie pokazuje żadnego okna.
func TestMacAccessibilityPromptCall(t *testing.T) {
	if os.Getenv("OVERVNC_MAC_SMOKE") != "1" || loadCG() != nil || !axIsProcessTrusted() {
		t.Skip("tylko ręcznie: OVERVNC_MAC_SMOKE=1, proces ze zgodą Dostępność (bez okna)")
	}
	requestAccessibilityPrompt()
	if !axIsProcessTrusted() {
		t.Fatal("zgoda zniknęła po wywołaniu")
	}
}

// Ramka wsparcia: proces desktop-overlay tworzy okna, a filtr ScreenCaptureKit je wyklucza z obrazu.
func TestMacOverlayExcludedFromCapture(t *testing.T) {
	exe := os.Getenv("OVERVNC_OVERLAY_EXE")
	if os.Getenv("OVERVNC_MAC_SMOKE") != "1" || exe == "" || loadCG() != nil || !cgPreflightScreenCaptureAccess() {
		t.Skip("tylko ręcznie: OVERVNC_MAC_SMOKE=1 OVERVNC_OVERLAY_EXE=<agent>")
	}
	cmd := exec.Command(exe, "desktop-overlay", "Test OVERVNC")
	in, _ := cmd.StdinPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = in.Close(); _ = cmd.Wait() }()
	time.Sleep(1500 * time.Millisecond)
	b := &macBackend{}
	defer b.close()
	mons, _ := b.monitors()
	for deadline := time.Now().Add(4 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		_, _, _, _ = b.capture(mons[0])
		if b.sck != nil && b.sck.excluded != "" {
			break
		}
	}
	if b.sck == nil || b.sck.excluded == "" {
		t.Fatal("okna ramki nie zostały wyłączone z obrazu")
	}
	t.Logf("wyłączone okna ramki: %s", b.sck.excluded)
	if cmd.ProcessState != nil {
		t.Fatal("proces ramki zakończył się przedwcześnie")
	}
}
