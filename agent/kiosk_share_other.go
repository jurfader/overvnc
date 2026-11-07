//go:build !windows

package main

import (
	"context"
	"errors"
)

// Udział Pobrane — tylko na kioskach z Windows.
type ShareStatus struct{}

func setupShare(context.Context, string, string) error { return nil }
func pendingSharePassword() bool                       { return false }
func storeSharePassword(string) error {
	return errors.New("udział Pobrane działa tylko na Windows")
}
