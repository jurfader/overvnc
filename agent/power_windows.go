//go:build windows

package main

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	wtsapi           = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSLogoff    = wtsapi.NewProc("WTSLogoffSession")
	procWTSDisconect = wtsapi.NewProc("WTSDisconnectSession")
)

func supportedPowerActions() []string {
	return []string{"reboot", "shutdown", "cancel", "logoff", "lock"}
}

func shutdownExe(ctx context.Context, args ...string) error {
	out, err := exec.CommandContext(ctx, "shutdown.exe", args...).CombinedOutput()
	if err != nil {
		return protoErr("power_failed", "shutdown %s: %s", strings.Join(args, " "), strings.TrimSpace(firstNonEmpty(string(out), err.Error())))
	}
	return nil
}

func doPower(ctx context.Context, req powerReq) error {
	secs := strconv.Itoa(req.DelayMinutes * 60)
	switch req.Action {
	case "reboot":
		return shutdownExe(ctx, "/r", "/t", secs, "/d", "p:0:0", "/c", firstNonEmpty(req.Message, "Komputer zostanie uruchomiony ponownie przez administratora (OVERVNC)."))
	case "shutdown":
		return shutdownExe(ctx, "/s", "/t", secs, "/d", "p:0:0", "/c", firstNonEmpty(req.Message, "Komputer zostanie wyłączony przez administratora (OVERVNC)."))
	case "cancel":
		return shutdownExe(ctx, "/a")
	case "logoff":
		return forActiveSessions(procWTSLogoff, 1)
	case "lock":
		// rozłączenie sesji konsoli pokazuje ekran blokady — działa z konta SYSTEM, bez pomocnika w sesji
		return forActiveSessions(procWTSDisconect, 0)
	}
	return protoErr("unsupported", "nieobsługiwana akcja")
}

// forActiveSessions wywołuje WTSLogoffSession / WTSDisconnectSession dla każdej aktywnej sesji użytkownika.
func forActiveSessions(proc *windows.LazyProc, wait uintptr) error {
	var sessions *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &sessions, &count); err != nil {
		return protoErr("power_failed", "lista sesji: %v", err)
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(sessions)))
	n := 0
	for _, s := range unsafe.Slice(sessions, count) {
		if s.State != windows.WTSActive || s.SessionID == 0 {
			continue
		}
		if r, _, _ := proc.Call(0, uintptr(s.SessionID), wait); r != 0 {
			n++
		}
	}
	if n == 0 {
		return protoErr("no_user", "nikt nie jest zalogowany")
	}
	return nil
}
