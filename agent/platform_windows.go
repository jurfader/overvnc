//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"

	"golang.org/x/sys/windows"
)

// restrictDir odbiera zwykłym użytkownikom dostęp do katalogu z sekretem agenta.
func restrictDir(dir string) {
	_ = exec.Command("icacls", dir, "/inheritance:r",
		"/grant:r", "*S-1-5-18:(OI)(CI)F", // SYSTEM
		"/grant:r", "*S-1-5-32-544:(OI)(CI)F", // Administratorzy
	).Run()
}

func requireAdmin() {
	if !windows.GetCurrentProcessToken().IsElevated() {
		fmt.Fprintln(os.Stderr, "Uruchom wiersz poleceń jako Administrator.")
		os.Exit(1)
	}
}
