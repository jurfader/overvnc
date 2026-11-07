//go:build !windows

package main

import "context"

// Funkcje kiosku („Zdjęcia z telefonu”, tryb kiosku) są tylko na Windows.
func runPhoneWatcher(context.Context) {}

func setupPhoneApp(context.Context, bool) (string, string, error) {
	return "", "Aplikacja „Zdjęcia z telefonu” działa tylko na Windows.", nil
}
