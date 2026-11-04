//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func runScript(t *testing.T, ctx context.Context, req map[string]any) (scriptResult, error) {
	t.Helper()
	raw, _ := json.Marshal(req)
	out, err := handleScriptRun(ctx, raw)
	if err != nil {
		return scriptResult{}, err
	}
	return out.(scriptResult), nil
}

func TestScriptRunOutputAndExitCode(t *testing.T) {
	res, err := runScript(t, context.Background(), map[string]any{
		"runId": "test-run-0001", "shell": "sh", "script": "echo zażółć\necho błąd >&2\nexit 3",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 3 || !strings.Contains(res.Output, "zażółć") || !strings.Contains(res.Output, "błąd") || res.TimedOut {
		t.Fatalf("wynik: %+v", res)
	}
	// ten sam runId — wynik z pamięci, skrypt nie uruchamia się drugi raz
	raw, _ := json.Marshal(map[string]string{"runId": "test-run-0001"})
	again, err := handleScriptResult(context.Background(), raw)
	if err != nil || again.(scriptResult).ExitCode != 3 {
		t.Fatalf("script.result: %v %+v", err, again)
	}
}

func TestScriptRunTimeoutKillsTree(t *testing.T) {
	start := time.Now()
	res, err := runScript(t, context.Background(), map[string]any{
		"runId": "test-run-0002", "shell": "sh", "script": "echo start\nsleep 30 &\nsleep 30", "timeoutSec": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.TimedOut || time.Since(start) > 10*time.Second || !strings.Contains(res.Output, "start") {
		t.Fatalf("limit czasu nie zadziałał: %+v po %v", res, time.Since(start))
	}
}

func TestScriptSurvivesDisconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	_, err := runScript(t, ctx, map[string]any{"runId": "test-run-0003", "shell": "sh", "script": "sleep 0.5; echo koniec"})
	if err == nil {
		t.Fatal("oczekiwano przerwania oczekiwania")
	}
	// po „ponownym połączeniu” wynik jest dostępny
	raw, _ := json.Marshal(map[string]string{"runId": "test-run-0003"})
	out, err := handleScriptResult(context.Background(), raw)
	if err != nil || !strings.Contains(out.(scriptResult).Output, "koniec") {
		t.Fatalf("wynik po rozłączeniu: %v %+v", err, out)
	}
}

func TestScriptValidation(t *testing.T) {
	for _, req := range []map[string]any{
		{"runId": "x", "shell": "sh", "script": "echo"},
		{"runId": "test-run-0004", "shell": "sh", "script": "   "},
		{"runId": "test-run-0005", "shell": "nieistniejąca", "script": "echo"},
	} {
		if _, err := runScript(t, context.Background(), req); err == nil {
			t.Fatalf("oczekiwano błędu dla %v", req)
		}
	}
	raw, _ := json.Marshal(map[string]string{"runId": "nieznany-run-1"})
	if _, err := handleScriptResult(context.Background(), raw); err == nil {
		t.Fatal("nieznane uruchomienie powinno zwrócić błąd")
	}
}

func TestCappedOutput(t *testing.T) {
	c := &cappedOutput{head: 10, tail: 5}
	for range 10 {
		_, _ = c.Write([]byte("0123456789"))
	}
	s, truncated := c.String()
	if !truncated || !strings.HasPrefix(s, "0123456789") || !strings.HasSuffix(s, "56789") || !strings.Contains(s, "pominięto 85 B") {
		t.Fatalf("%q %v", s, truncated)
	}
}
