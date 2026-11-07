//go:build !windows

package main

import "context"

// Okienko z odliczaniem do restartu — na razie tylko Windows (panel pokazuje odliczanie na każdym systemie).
func runPowerNotice([]string) int           { return 0 }
func runPowerNoticeService(context.Context) {}
