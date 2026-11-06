package main

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// Odczyt schowka (schowek Maca -> przeglądarka): numer zmiany z NSPasteboard (bez odczytu treści),
// treść przez pbpaste tylko po zmianie.

var (
	pbOnce sync.Once
	pbOK   bool
)

func (b *macBackend) clipboardSeq() uint64 {
	pbOnce.Do(func() {
		_, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		pbOK = err == nil && objc.GetClass("NSPasteboard") != 0
	})
	if !pbOK {
		return 0
	}
	pb := objc.ID(objc.GetClass("NSPasteboard")).Send(objc.RegisterName("generalPasteboard"))
	if pb == 0 {
		return 0
	}
	return uint64(objc.Send[int64](pb, objc.RegisterName("changeCount")))
}

func (b *macBackend) getClipboard() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/pbpaste", "-Prefer", "txt")
	cmd.Env = append(os.Environ(), "LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8")
	out, err := cmd.Output()
	return string(out), err
}
