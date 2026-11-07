//go:build !windows

package main

import "context"

// Funkcje kiosku („Zdjęcia z telefonu”, tryb kiosku) są tylko na Windows.
func runPhoneWatcher(context.Context) {}

func setupKioskApps(context.Context, bool, bool) (string, string, error) {
	return "", "Funkcje kiosku działają tylko na Windows.", nil
}

func applyKioskSetup(ctx context.Context) (string, error) { return applyKioskSetupNow(ctx) }
