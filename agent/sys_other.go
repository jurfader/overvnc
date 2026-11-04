//go:build !windows && !darwin && !linux

package main

import (
	"context"
	"errors"
)

func consoleUsers() []string { return nil }

func installedSoftware(ctx context.Context) ([]Software, error) {
	return nil, errors.New("inwentarz oprogramowania nieobsługiwany na tym systemie")
}
