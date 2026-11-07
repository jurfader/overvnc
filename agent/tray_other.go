//go:build !windows

package main

import "context"

// Ikona w zasobniku z czatem — na razie tylko Windows.
func runTray() int                   { return 0 }
func runTrayService(context.Context) {}
