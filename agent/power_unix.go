//go:build linux || darwin

package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
)

func supportedPowerActions() []string {
	if runtime.GOOS == "darwin" {
		// macOS: blokady ekranu nie da się wywołać spoza sesji użytkownika (przyjdzie z aplikacją w zasobniku)
		return []string{"reboot", "shutdown", "cancel", "logoff"}
	}
	return []string{"reboot", "shutdown", "cancel", "logoff", "lock"}
}

func run(ctx context.Context, name string, args ...string) error {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return protoErr("power_failed", "%s %s: %s", name, strings.Join(args, " "), strings.TrimSpace(firstNonEmpty(string(out), err.Error())))
	}
	return nil
}

func doPower(ctx context.Context, req powerReq) error {
	when := "now"
	if req.DelayMinutes > 0 {
		when = fmt.Sprintf("+%d", req.DelayMinutes)
	}
	msg := firstNonEmpty(req.Message, "Komputer zostanie uruchomiony ponownie przez administratora (OVERVNC).")
	switch req.Action {
	case "reboot":
		return run(ctx, "shutdown", "-r", when, msg)
	case "shutdown":
		if req.Message == "" {
			msg = "Komputer zostanie wyłączony przez administratora (OVERVNC)."
		}
		return run(ctx, "shutdown", "-h", when, msg)
	case "cancel":
		if runtime.GOOS == "darwin" {
			// zaplanowane wyłączenie na macOS to proces "shutdown" czekający na swój czas
			return run(ctx, "killall", "shutdown")
		}
		return run(ctx, "shutdown", "-c")
	case "lock":
		return run(ctx, "loginctl", "lock-sessions")
	case "logoff":
		return logoffAll(ctx)
	}
	return protoErr("unsupported", "nieobsługiwana akcja")
}

func logoffAll(ctx context.Context) error {
	if runtime.GOOS == "darwin" {
		fi, err := os.Stat("/dev/console")
		if err != nil {
			return protoErr("power_failed", "%v", err)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || st.Uid == 0 {
			return protoErr("no_user", "nikt nie jest zalogowany")
		}
		return run(ctx, "launchctl", "bootout", fmt.Sprintf("user/%d", st.Uid))
	}
	out, err := exec.CommandContext(ctx, "loginctl", "list-sessions", "--no-legend").Output()
	if err != nil {
		return protoErr("power_failed", "loginctl: %v", err)
	}
	n := 0
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		if f := strings.Fields(sc.Text()); len(f) > 0 {
			if run(ctx, "loginctl", "terminate-session", f[0]) == nil {
				n++
			}
		}
	}
	if n == 0 {
		return protoErr("no_user", "nikt nie jest zalogowany")
	}
	return nil
}
