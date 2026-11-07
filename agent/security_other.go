//go:build !windows && !darwin

package main

import "context"

// Linux: stan zabezpieczeń nie jest (jeszcze) zbierany.
func collectSecurityFast(context.Context) *Security { return nil }

func updatesSupported() bool { return false }

func checkUpdates(context.Context) *UpdatesState { return &UpdatesState{} }
