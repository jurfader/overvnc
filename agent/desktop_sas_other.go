//go:build !windows

package main

import "errors"

// Ctrl+Alt+Del istnieje tylko na Windows.
const sasSupported = false

func sendSAS() error { return errors.New("Ctrl+Alt+Del jest dostępne tylko na Windows") }
