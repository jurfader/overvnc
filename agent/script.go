package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Jednorazowe skrypty (zadania z panelu, także grupowe).
//
// Skrypt działa niezależnie od połączenia z serwerem: chwilowe rozłączenie go nie przerywa,
// a serwer po ponownym połączeniu odbiera wynik poleceniem script.result (wyniki trzymamy godzinę).

const (
	maxScriptBytes     = 256 << 10
	maxScriptTimeout   = 4 * time.Hour
	defaultScriptLimit = 10 * time.Minute
	scriptOutputHead   = 48 << 10
	scriptOutputTail   = 16 << 10
	scriptResultKeep   = time.Hour
)

type scriptReq struct {
	RunID      string `json:"runId"`
	Shell      string `json:"shell"`
	Script     string `json:"script"`
	TimeoutSec int    `json:"timeoutSec"`
	// AsUser — w sesji zalogowanego użytkownika (z jego uprawnieniami) zamiast jako usługa
	AsUser bool `json:"asUser"`
}

type scriptResult struct {
	ExitCode   int    `json:"exitCode"`
	Output     string `json:"output"`
	Truncated  bool   `json:"truncated"`
	TimedOut   bool   `json:"timedOut"`
	DurationMs int64  `json:"durationMs"`
	User       string `json:"user,omitempty"`
}

type scriptRun struct {
	done   chan struct{}
	result scriptResult
	err    error
	ended  time.Time
}

var (
	runsMu sync.Mutex
	runs   = map[string]*scriptRun{}
)

var runIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

func handleScriptRun(ctx context.Context, data json.RawMessage) (any, error) {
	req, err := decode[scriptReq](data)
	if err != nil {
		return nil, err
	}
	if !runIDRe.MatchString(req.RunID) {
		return nil, protoErr("bad_request", "nieprawidłowy identyfikator uruchomienia")
	}
	if strings.TrimSpace(req.Script) == "" || len(req.Script) > maxScriptBytes || !utf8.ValidString(req.Script) {
		return nil, protoErr("bad_request", "treść skryptu: 1 B – 256 KB tekstu")
	}
	limit := defaultScriptLimit
	if req.TimeoutSec > 0 {
		limit = min(time.Duration(req.TimeoutSec)*time.Second, maxScriptTimeout)
	}
	sh, ok := findShell(req.Shell)
	if !ok {
		return nil, protoErr("no_shell", "powłoka %q nie jest dostępna na tym komputerze", req.Shell)
	}
	if req.AsUser && !userScriptsSupported() {
		return nil, protoErr("unsupported", "uruchamianie jako zalogowany użytkownik nie jest obsługiwane na tym systemie")
	}

	return startRun(ctx, req.RunID, limit, func(rctx context.Context) (scriptResult, error) {
		return executeScript(rctx, sh, req)
	})
}

// startRun uruchamia pracę (skrypt, wdrożenie) niezależnie od połączenia z serwerem i czeka na wynik.
// Ten sam runId nie uruchamia jej drugi raz — tylko czeka na wynik (np. po ponownym połączeniu).
func startRun(ctx context.Context, runID string, limit time.Duration, fn func(context.Context) (scriptResult, error)) (any, error) {
	runsMu.Lock()
	pruneRuns()
	r, exists := runs[runID]
	if !exists {
		r = &scriptRun{done: make(chan struct{})}
		runs[runID] = r
	}
	runsMu.Unlock()

	if !exists {
		// kontekst niezależny od połączenia — praca kończy się sama albo po przekroczeniu limitu
		go func() {
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), limit)
			defer cancel()
			res, err := fn(rctx)
			runsMu.Lock()
			r.result, r.err, r.ended = res, err, time.Now()
			runsMu.Unlock()
			close(r.done)
		}()
	}
	return awaitRun(ctx, r)
}

// handleScriptResult — wynik uruchomienia rozpoczętego wcześniej (np. przed zerwaniem połączenia); czeka, jeśli trwa.
func handleScriptResult(ctx context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		RunID string `json:"runId"`
	}](data)
	if err != nil {
		return nil, err
	}
	runsMu.Lock()
	r := runs[req.RunID]
	runsMu.Unlock()
	if r == nil {
		return nil, protoErr("unknown_run", "agent nie zna tego uruchomienia (np. po restarcie komputera)")
	}
	return awaitRun(ctx, r)
}

func awaitRun(ctx context.Context, r *scriptRun) (any, error) {
	select {
	case <-r.done:
		if r.err != nil {
			return nil, r.err
		}
		return r.result, nil
	case <-ctx.Done():
		return nil, protoErr("disconnected", "przerwano oczekiwanie na wynik")
	}
}

func pruneRuns() {
	for id, r := range runs {
		if !r.ended.IsZero() && time.Since(r.ended) > scriptResultKeep {
			delete(runs, id)
		}
	}
}

func executeScript(ctx context.Context, sh shellSpec, req scriptReq) (scriptResult, error) {
	return executeScriptOut(ctx, sh, req, &cappedOutput{head: scriptOutputHead, tail: scriptOutputTail})
}

func executeScriptOut(ctx context.Context, sh shellSpec, req scriptReq, out *cappedOutput) (scriptResult, error) {
	var res scriptResult
	start := time.Now()
	var code int
	var err error
	if req.AsUser {
		code, res.User, err = runScriptAsUser(ctx, sh, req.Script, out)
	} else {
		code, err = runScriptAsService(ctx, sh, req.Script, out)
	}
	res.DurationMs = time.Since(start).Milliseconds()
	if err != nil {
		return res, err
	}
	res.ExitCode = code
	res.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
	res.Output, res.Truncated = out.String()
	return res, nil
}

// withEnvVar dopisuje na początku skryptu zmienną środowiskową w składni danej powłoki
// (działa tak samo jako usługa i jako użytkownik, bez modyfikowania bloku środowiska procesu).
func withEnvVar(sh shellSpec, name, value, script string) string {
	switch sh.name {
	case "powershell", "pwsh":
		return "$env:" + name + " = '" + strings.ReplaceAll(value, "'", "''") + "'\n" + script
	case "cmd":
		return `set "` + name + "=" + value + `"` + "\n" + script
	default:
		return name + "='" + strings.ReplaceAll(value, "'", `'\''`) + "'; export " + name + "\n" + script
	}
}

// scriptFile — treść pliku skryptu i polecenie uruchamiające go w danej powłoce.
func scriptFile(sh shellSpec, script string) (ext string, body []byte, argv func(path string) []string) {
	switch sh.name {
	case "powershell", "pwsh":
		// BOM: Windows PowerShell 5.1 bez niego czyta plik w stronie kodowej ANSI (polskie znaki)
		head := "\ufeff[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\r\n$ProgressPreference = 'SilentlyContinue'\r\n"
		return ".ps1", []byte(head + crlf(script)), func(p string) []string {
			return []string{sh.path, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", p}
		}
	case "cmd":
		return ".cmd", []byte("@echo off\r\nchcp 65001 >nul\r\n" + crlf(script) + "\r\n"), func(p string) []string {
			return []string{sh.path, "/d", "/c", p}
		}
	default:
		return ".sh", []byte(strings.ReplaceAll(script, "\r\n", "\n")), func(p string) []string {
			return []string{sh.path, p}
		}
	}
}

func crlf(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")
}

func runScriptAsService(ctx context.Context, sh shellSpec, script string, out *cappedOutput) (int, error) {
	ext, body, argv := scriptFile(sh, script)
	f, err := os.CreateTemp("", "overvnc-script-*"+ext)
	if err != nil {
		return 0, protoErr("failed", "plik tymczasowy: %v", err)
	}
	path := f.Name()
	defer os.Remove(path)
	_, err = f.Write(body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, protoErr("failed", "zapis skryptu: %v", err)
	}
	args := argv(path)
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = shellEnv()
	cmd.Dir = shellDir()
	cmd.Stdout, cmd.Stderr = out, out
	return runKillable(ctx, cmd)
}

// runKillable uruchamia proces i po przekroczeniu limitu zabija całe drzewo (skrypty uruchamiają podprocesy).
func runKillable(ctx context.Context, cmd *exec.Cmd) (int, error) {
	prepareProcessTree(cmd)
	// program uruchomiony w tle przez skrypt może trzymać potoki wyjścia — nie czekamy na niego
	cmd.WaitDelay = 3 * time.Second
	if err := cmd.Start(); err != nil {
		return 0, protoErr("start_failed", "nie udało się uruchomić: %v", err)
	}
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	select {
	case err := <-waited:
		return exitCodeOf(cmd, err), nil
	case <-ctx.Done():
		killProcessTree(cmd)
		err := <-waited
		return exitCodeOf(cmd, err), nil
	}
}

func exitCodeOf(cmd *exec.Cmd, err error) int {
	if cmd.ProcessState != nil {
		return cmd.ProcessState.ExitCode()
	}
	if err != nil {
		return -1
	}
	return 0
}

// cappedOutput — początek i koniec wyjścia (środek pomijamy przy bardzo długich wynikach).
type cappedOutput struct {
	mu         sync.Mutex
	head, tail int
	first      []byte
	last       []byte
	dropped    int64
}

func (c *cappedOutput) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := len(p)
	if room := c.head - len(c.first); room > 0 {
		k := min(room, len(p))
		c.first = append(c.first, p[:k]...)
		p = p[k:]
	}
	if len(p) > 0 {
		c.last = append(c.last, p...)
		if over := len(c.last) - c.tail; over > 0 {
			c.dropped += int64(over)
			c.last = append(c.last[:0], c.last[over:]...)
		}
	}
	return n, nil
}

func (c *cappedOutput) String() (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := string(c.first)
	if c.dropped > 0 {
		s += "\n… (pominięto " + humanBytes(c.dropped) + " wyjścia) …\n"
	}
	s += string(c.last)
	return strings.ToValidUTF8(s, "�"), c.dropped > 0
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

func init() {
	handlers["script.run"] = handleScriptRun
	handlers["script.result"] = handleScriptResult
	handlerTimeouts["script.run"] = maxScriptTimeout + time.Minute
	handlerTimeouts["script.result"] = maxScriptTimeout + time.Minute
}
