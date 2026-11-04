package main

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

type shellSpec struct {
	name string // identyfikator widoczny w panelu
	path string
	args []string
}

// shellCandidates — powłoki w kolejności preferencji (pierwsza dostępna = domyślna).
func shellCandidates() []shellSpec {
	if runtime.GOOS == "windows" {
		return []shellSpec{
			{"powershell", "powershell.exe", []string{"-NoLogo"}},
			{"pwsh", "pwsh.exe", []string{"-NoLogo"}},
			{"cmd", "cmd.exe", nil},
		}
	}
	list := []shellSpec{
		{"bash", "/bin/bash", []string{"-l"}},
		{"zsh", "/bin/zsh", []string{"-l"}},
		{"sh", "/bin/sh", []string{"-l"}},
	}
	if runtime.GOOS == "darwin" {
		// na macOS domyślną powłoką jest zsh
		list[0], list[1] = list[1], list[0]
	}
	return list
}

func availableShells() []string {
	var out []string
	for _, s := range shellCandidates() {
		if _, err := exec.LookPath(s.path); err == nil {
			out = append(out, s.name)
		}
	}
	return out
}

// findShell — "" oznacza powłokę domyślną.
func findShell(name string) (shellSpec, bool) {
	for _, s := range shellCandidates() {
		if name != "" && s.name != name {
			continue
		}
		if p, err := exec.LookPath(s.path); err == nil {
			s.path = p
			return s, true
		}
		if name != "" {
			return shellSpec{}, false
		}
	}
	return shellSpec{}, false
}

// shellEnv — środowisko usługi jest ubogie; uzupełniamy to, czego oczekują programy w terminalu.
func shellEnv() []string {
	env := os.Environ()
	set := func(k, v string) {
		for _, e := range env {
			if strings.HasPrefix(e, k+"=") {
				return
			}
		}
		env = append(env, k+"="+v)
	}
	set("TERM", "xterm-256color")
	set("COLORTERM", "truecolor")
	switch runtime.GOOS {
	case "linux":
		set("LANG", "C.UTF-8")
		set("HOME", "/root")
		set("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	case "darwin":
		set("LANG", "en_US.UTF-8")
		set("HOME", "/var/root")
		set("PATH", "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
	}
	return env
}

func shellDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		if fi, err := os.Stat(h); err == nil && fi.IsDir() {
			return h
		}
	}
	if runtime.GOOS == "windows" {
		return os.Getenv("SystemDrive") + `\`
	}
	return "/"
}
