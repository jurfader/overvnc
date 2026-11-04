//go:build windows

package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func prepareProcessTree(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

func killProcessTree(cmd *exec.Cmd) {
	if cmd.Process != nil {
		killTreeByPid(uint32(cmd.Process.Pid))
	}
}

func killTreeByPid(pid uint32) {
	k := exec.Command("taskkill.exe", "/T", "/F", "/PID", strconv.FormatUint(uint64(pid), 10))
	k.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = k.Run()
}

func userScriptsSupported() bool { return true }

func tokenUserName(tok windows.Token) string {
	tu, err := tok.GetTokenUser()
	if err != nil {
		return ""
	}
	account, domain, _, err := tu.User.Sid.LookupAccount("")
	if err != nil {
		return ""
	}
	if domain != "" {
		return domain + `\` + account
	}
	return account
}

// runScriptAsUser — skrypt w sesji zalogowanego użytkownika, z jego tokenem i środowiskiem
// (np. dostęp do jego HKCU, dysków sieciowych, uruchamianie programów na jego pulpicie).
func runScriptAsUser(ctx context.Context, sh shellSpec, script string, out *cappedOutput) (int, string, error) {
	sid, err := targetSession()
	if err != nil {
		return 0, "", protoErr("no_user", "nikt nie jest zalogowany na tym komputerze")
	}
	var tok windows.Token
	if err := windows.WTSQueryUserToken(sid, &tok); err != nil {
		return 0, "", protoErr("no_user", "nikt nie jest zalogowany na tym komputerze (%v)", err)
	}
	defer tok.Close()
	name := tokenUserName(tok)

	profile, err := tok.GetUserProfileDirectory()
	if err != nil {
		return 0, name, protoErr("failed", "profil użytkownika: %v", err)
	}
	dir := filepath.Join(profile, "AppData", "Local", "Temp")
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		dir = profile
	}
	ext, body, argv := scriptFile(sh, script)
	f, err := os.CreateTemp(dir, "overvnc-script-*"+ext)
	if err != nil {
		return 0, name, protoErr("failed", "plik tymczasowy: %v", err)
	}
	path := f.Name()
	defer os.Remove(path)
	_, err = f.Write(body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, name, protoErr("failed", "zapis skryptu: %v", err)
	}

	args := argv(path)
	line := windows.EscapeArg(args[0])
	for _, a := range args[1:] {
		line += " " + windows.EscapeArg(a)
	}

	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, tok, false); err != nil {
		return 0, name, protoErr("failed", "środowisko użytkownika: %v", err)
	}
	defer windows.DestroyEnvironmentBlock(env)

	sa := &windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	var outR, outW windows.Handle
	if err := windows.CreatePipe(&outR, &outW, sa, 0); err != nil {
		return 0, name, protoErr("failed", "potok: %v", err)
	}
	_ = windows.SetHandleInformation(outR, windows.HANDLE_FLAG_INHERIT, 0)
	nulName, _ := windows.UTF16PtrFromString("NUL")
	nul, _ := windows.CreateFile(nulName, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, sa, windows.OPEN_EXISTING, 0, 0)

	desk, _ := windows.UTF16PtrFromString(`winsta0\default`)
	si := windows.StartupInfo{
		Desktop:    desk,
		Flags:      windows.STARTF_USESTDHANDLES | windows.STARTF_USESHOWWINDOW,
		ShowWindow: windows.SW_HIDE,
		StdInput:   nul,
		StdOutput:  outW,
		StdErr:     outW,
	}
	si.Cb = uint32(unsafe.Sizeof(si))
	cmdLine, _ := windows.UTF16PtrFromString(line)
	cwd, _ := windows.UTF16PtrFromString(profile)
	var pi windows.ProcessInformation
	syscall.ForkLock.Lock()
	err = windows.CreateProcessAsUser(tok, nil, cmdLine, nil, nil, true, windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT, env, cwd, &si, &pi)
	syscall.ForkLock.Unlock()
	windows.CloseHandle(outW)
	if nul != 0 && nul != windows.InvalidHandle {
		windows.CloseHandle(nul)
	}
	if err != nil {
		windows.CloseHandle(outR)
		return 0, name, protoErr("start_failed", "CreateProcessAsUser: %v", err)
	}
	windows.CloseHandle(pi.Thread)
	defer windows.CloseHandle(pi.Process)

	reader := os.NewFile(uintptr(outR), "script-out")
	copied := make(chan struct{})
	go func() {
		_, _ = io.Copy(out, reader)
		close(copied)
	}()
	exited := make(chan struct{})
	go func() {
		_, _ = windows.WaitForSingleObject(pi.Process, windows.INFINITE)
		close(exited)
	}()
	select {
	case <-exited:
	case <-ctx.Done():
		killTreeByPid(pi.ProcessId)
		<-exited
	}
	// program uruchomiony w tle przez skrypt może trzymać potok — nie czekamy na niego w nieskończoność
	select {
	case <-copied:
	case <-time.After(3 * time.Second):
	}
	reader.Close()
	var code uint32
	if err := windows.GetExitCodeProcess(pi.Process, &code); err != nil {
		return -1, name, nil
	}
	return int(int32(code)), name, nil
}
