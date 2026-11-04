//go:build !windows

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"
)

// Na macOS/Linuksie pulpit zdalny jeszcze nie przechwytuje prawdziwego ekranu — dostępny jest
// syntetyczny ekran testowy (OVERVNC_DESKTOP_TEST=1) do testów całego potoku bez Windows.
func desktopSupported() bool { return os.Getenv("OVERVNC_DESKTOP_TEST") == "1" }

func askDesktopConsent(mode, viewer string) (bool, error) { return true, nil }

type execHelper struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	out io.ReadCloser
}

func (h *execHelper) stdin() io.Writer  { return h.in }
func (h *execHelper) stdout() io.Reader { return h.out }
func (h *execHelper) wait() int {
	_ = h.cmd.Wait()
	if h.cmd.ProcessState == nil {
		return -1
	}
	return h.cmd.ProcessState.ExitCode()
}
func (h *execHelper) kill() {
	_ = h.in.Close()
	if h.cmd.Process != nil {
		_ = h.cmd.Process.Kill()
	}
}

func spawnDesktopHelper(args ...string) (helperProc, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, append([]string{"desktop-helper"}, args...)...)
	cmd.Stderr = nil
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start pomocnika: %w", err)
	}
	return &execHelper{cmd: cmd, in: in, out: out}, nil
}

// ---------- syntetyczny ekran testowy ----------

type syntheticBackend struct {
	frame  int
	mouseX float64
	mouseY float64
	color  byte
}

func newDesktopBackend(_ bool) (desktopBackend, error) {
	if !desktopSupported() {
		return nil, fmt.Errorf("pulpit zdalny na tym systemie nie jest jeszcze obsługiwany")
	}
	return &syntheticBackend{color: 80}, nil
}

func (s *syntheticBackend) monitors() ([]MonitorInfo, string) {
	return []MonitorInfo{
		{Index: 0, X: 0, Y: 0, W: 1280, H: 720, Primary: true, Name: "Ekran testowy 1"},
		{Index: 1, X: 1280, Y: 0, W: 800, H: 600, Name: "Ekran testowy 2"},
	}, "Default"
}

// capture rysuje: tło w kolorze zależnym od ostatniego klawisza, przesuwający się pas (zmiana co klatkę)
// i znacznik w miejscu kursora myszy.
func (s *syntheticBackend) capture(m MonitorInfo) ([]byte, int, int, error) {
	s.frame++
	w, h := m.W, m.H
	buf := make([]byte, w*h*4)
	for i := 0; i < len(buf); i += 4 {
		buf[i], buf[i+1], buf[i+2], buf[i+3] = 40, 20, s.color, 255
	}
	bar := (s.frame * 8) % w
	fill := func(x0, y0, x1, y1 int, b, g, r byte) {
		for y := max(0, y0); y < min(h, y1); y++ {
			for x := max(0, x0); x < min(w, x1); x++ {
				o := (y*w + x) * 4
				buf[o], buf[o+1], buf[o+2] = b, g, r
			}
		}
	}
	fill(bar, 0, bar+40, h, 140, 30, 233) // różowy pas (kolor marki)
	mx, my := int(s.mouseX*float64(w)), int(s.mouseY*float64(h))
	fill(mx-6, my-6, mx+6, my+6, 255, 255, 255)
	return buf, w, h, nil
}

func (s *syntheticBackend) input(ev InputEvent, m MonitorInfo) error {
	switch ev.T {
	case "m":
		s.mouseX, s.mouseY = ev.X, ev.Y
	case "k":
		if ev.D {
			s.color += 40
		}
	}
	// zdarzenia trafiają do logu agenta — testy e2e sprawdzają, że wejście dotarło
	if ev.T != "m" {
		helperLogHook(fmt.Sprintf("wejście %s code=%s b=%d d=%v dy=%d", ev.T, ev.Code, ev.B, ev.D, ev.DY))
	}
	return nil
}

func (s *syntheticBackend) close() {}

// setClipboard — tryb testowy: długość tekstu trafia do logu agenta.
func (s *syntheticBackend) setClipboard(text string) error {
	helperLogHook(fmt.Sprintf("schowek: %d znaków", len([]rune(text))))
	return nil
}

func (s *syntheticBackend) setCursor(bool)          {}
func (s *syntheticBackend) interval() time.Duration { return 66 * time.Millisecond }

// showScreenMessage — tryb testowy: komunikat trafia do logu agenta (testy e2e sprawdzają, że dotarł).
func showScreenMessage(title, text string, seconds int) error {
	logger.Infof("komunikat na ekranie (%d s): %s — %s", seconds, title, text)
	return nil
}
