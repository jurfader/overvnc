//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
)

// Poza Windows aplikacja działa tylko na folderze testowym (OVERVNC_PHONE_TEST_DIR) — do pracy nad
// interfejsem i testów; kioski są na Windows.
func newPhoneSource() (phoneSource, error) {
	if d := os.Getenv("OVERVNC_PHONE_TEST_DIR"); d != "" {
		return newPhoneDirSource(d), nil
	}
	return nil, errors.New("zdjęcia z telefonu działają na Windows (do testów: OVERVNC_PHONE_TEST_DIR)")
}

func openURL(target string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", target).Start()
	}
	return exec.Command("xdg-open", target).Start()
}

func phoneOpenWindow(url string) error { return openURL(url) }
func phoneOpenFolder(dir string) error { return openURL(dir) }

// phoneSingleInstance — blokada pliku: druga kopia aplikacji kończy się od razu.
func phoneSingleInstance() (func(), bool) {
	f, err := os.OpenFile(filepath.Join(os.TempDir(), "overvnc-phone.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return func() {}, true
	}
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		f.Close()
		return nil, false
	}
	return func() { f.Close() }, true
}
