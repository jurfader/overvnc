package main

import (
	"errors"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Odczyt schowka komputera (schowek -> przeglądarka). Numer zmiany schowka jest tani — treść
// czytamy tylko wtedy, gdy się zmieni.

var (
	procGetClipboardSequenceNumber = user32.NewProc("GetClipboardSequenceNumber")
	procIsClipboardFormatAvailable = user32.NewProc("IsClipboardFormatAvailable")
	procGetClipboardData           = user32.NewProc("GetClipboardData")
	procGlobalSize                 = kernel32.NewProc("GlobalSize")
)

func (b *gdiBackend) clipboardSeq() uint64 {
	r, _, _ := procGetClipboardSequenceNumber.Call()
	return uint64(r)
}

func (b *gdiBackend) getClipboard() (string, error) {
	if r, _, _ := procIsClipboardFormatAvailable.Call(cfUnicodeText); r == 0 {
		return "", nil // nie tekst (np. obraz, pliki)
	}
	opened := false
	for range 5 {
		if r, _, _ := procOpenClipboard.Call(0); r != 0 {
			opened = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !opened {
		return "", errors.New("schowek jest zajęty przez inny program")
	}
	defer procCloseClipboard.Call()
	h, _, _ := procGetClipboardData.Call(cfUnicodeText)
	if h == 0 {
		return "", nil
	}
	size, _, _ := procGlobalSize.Call(h)
	p, _, _ := procGlobalLock.Call(h)
	if p == 0 || size < 2 {
		return "", nil
	}
	defer procGlobalUnlock.Call(h)
	n := min(int(size/2), clipMaxRunes*2) // UTF-16: do 2 jednostek na znak
	u := make([]uint16, n)
	procRtlMoveMemory.Call(uintptr(unsafe.Pointer(&u[0])), p, uintptr(n*2))
	return strings.ReplaceAll(windows.UTF16ToString(u), "\r\n", "\n"), nil
}
