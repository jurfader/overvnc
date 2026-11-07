//go:build !windows

package main

import "context"

// „Zakończ i usuń moje dane” — tylko na kioskach z Windows.
func runKioskSession(context.Context) {}

func runEndButton() int  { return 0 }
func runSessionEnd() int { return 0 }
