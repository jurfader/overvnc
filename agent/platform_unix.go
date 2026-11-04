//go:build !windows

package main

import (
	"fmt"
	"os"
)

func restrictDir(dir string) {} // na Unixie wystarcza chmod 0700/0600

func requireAdmin() {
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "Wymagane uprawnienia roota (uruchom przez sudo).")
		os.Exit(1)
	}
}
