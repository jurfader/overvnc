//go:build !windows

package main

import (
	"context"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strconv"
	"syscall"
)

// Grupa procesów: po przekroczeniu limitu zabijamy skrypt razem z jego podprocesami.
func prepareProcessTree(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessTree(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

func userScriptsSupported() bool { return runtime.GOOS == "darwin" || runtime.GOOS == "linux" }

// runScriptAsUser — skrypt jako użytkownik zalogowany przy ekranie (macOS: w jego sesji launchd, więc działa np. `open`).
func runScriptAsUser(ctx context.Context, sh shellSpec, script string, out *cappedOutput) (int, string, error) {
	users := consoleUsers()
	if len(users) == 0 {
		return 0, "", protoErr("no_user", "nikt nie jest zalogowany na tym komputerze")
	}
	u, err := user.Lookup(users[0])
	if err != nil {
		return 0, "", protoErr("no_user", "nieznany użytkownik %q", users[0])
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)

	ext, body, argv := scriptFile(sh, script)
	f, err := os.CreateTemp("", "overvnc-script-*"+ext)
	if err != nil {
		return 0, u.Username, protoErr("failed", "plik tymczasowy: %v", err)
	}
	path := f.Name()
	defer os.Remove(path)
	_, err = f.Write(body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		// plik należy do użytkownika — tylko on (i root) może go czytać
		err = os.Chown(path, uid, gid)
	}
	if err != nil {
		return 0, u.Username, protoErr("failed", "zapis skryptu: %v", err)
	}

	args := argv(path)
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		full := append([]string{"asuser", u.Uid, "sudo", "-u", u.Username, "-H", "--"}, args...)
		cmd = exec.Command("/bin/launchctl", full...)
	} else {
		full := append([]string{"-u", u.Username, "--"}, args...)
		cmd = exec.Command("runuser", full...)
	}
	cmd.Env = append(os.Environ(), "HOME="+u.HomeDir, "USER="+u.Username, "LOGNAME="+u.Username)
	cmd.Dir = u.HomeDir
	cmd.Stdout, cmd.Stderr = out, out
	code, err := runKillable(ctx, cmd)
	return code, u.Username, err
}
