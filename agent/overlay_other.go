//go:build !windows && !darwin

package main

// startSupportOverlay — Linux: bez ramki (brak pulpitu zdalnego).
func startSupportOverlay(string) interface{ stop() } { return nil }

func runOverlayProcess(string) int { return 0 }
