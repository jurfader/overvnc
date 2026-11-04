//go:build !windows && !darwin && !linux

package main

import "context"

func supportedPowerActions() []string { return nil }

func doPower(context.Context, powerReq) error {
	return protoErr("unsupported", "nieobsługiwany system")
}
