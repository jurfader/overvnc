//go:build !windows && !darwin && !linux

package main

import (
	"context"
	"errors"
)

func listServices(context.Context) ([]ServiceInfo, error) {
	return nil, errors.New("nieobsługiwany system")
}

func controlService(context.Context, string, string) error {
	return protoErr("unsupported", "nieobsługiwany system")
}
