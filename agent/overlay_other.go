//go:build !windows

package main

// startSupportOverlay — na razie tylko Windows (macOS: razem z pulpitem zdalnym, z uwzględnieniem notcha ekranu).
func startSupportOverlay(string) interface{ stop() } { return nil }

func runOverlayProcess(string) int { return 0 }
