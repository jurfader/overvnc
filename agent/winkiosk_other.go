//go:build !windows

package main

import "context"

// Licencja Windows i ochrona przed zapisem (UWF) dotyczą tylko Windows.
func collectWinStatus(context.Context) *WinStatus { return nil }

func resumeKioskTask(context.Context) {}
