//go:build !windows && !darwin

package main

import (
	"fmt"
)

// Linux: pulpit zdalny nie przechwytuje prawdziwego ekranu (X11/Wayland — poza planem);
// dostępny jest tylko syntetyczny ekran testowy (OVERVNC_DESKTOP_TEST=1).
func desktopSupported() bool { return desktopTestMode() }

func askDesktopConsent(mode, viewer string) (bool, error) { return true, nil }

func spawnDesktopHelper(args ...string) (helperProc, error) { return spawnPlainHelper(args...) }

func newDesktopBackend(_ bool) (desktopBackend, error) {
	if !desktopSupported() {
		return nil, fmt.Errorf("pulpit zdalny na tym systemie nie jest obsługiwany")
	}
	return newSyntheticBackend(), nil
}

// showScreenMessage — tryb testowy: komunikat trafia do logu agenta (testy e2e sprawdzają, że dotarł).
func showScreenMessage(title, text string, seconds int) error {
	logger.Infof("komunikat na ekranie (%d s): %s — %s", seconds, title, text)
	return nil
}
