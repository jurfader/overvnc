//go:build !windows

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func deployServer(t *testing.T, data []byte, cutFirst bool) (*httptest.Server, *atomic.Int32) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer agent-1.sekret" {
			w.WriteHeader(401)
			return
		}
		n := calls.Add(1)
		// pierwsze żądanie zrywa się w połowie — agent ma wznowić od miejsca przerwania
		if cutFirst && n == 1 {
			w.Header().Set("Content-Length", "999999999")
			w.WriteHeader(200)
			_, _ = w.Write(data[:len(data)/2])
			return
		}
		http.ServeContent(w, r, "f.bin", time.Now(), bytes.NewReader(data))
	}))
	t.Cleanup(srv.Close)
	setUpdateContext(&Config{ServerURL: srv.URL, AgentID: "agent-1", AgentSecret: "sekret"}, "")
	return srv, &calls
}

func deploy(t *testing.T, req map[string]any) (scriptResult, error) {
	t.Helper()
	raw, _ := json.Marshal(req)
	out, err := handleDeployRun(context.Background(), raw)
	if err != nil {
		return scriptResult{}, err
	}
	return out.(scriptResult), nil
}

func TestDeployDownloadResumeAndInstallScript(t *testing.T) {
	data := make([]byte, 300_000)
	_, _ = rand.Read(data)
	sum := sha256.Sum256(data)
	_, calls := deployServer(t, data, true)
	dir := filepath.Join(t.TempDir(), "kiosk", "pobrane")
	res, err := deploy(t, map[string]any{
		"runId": "deploy-run-0001", "url": "/api/agent/packages/7", "name": "instalator v2.msi", "size": len(data), "sha256": hex.EncodeToString(sum[:]),
		"dir": dir, "overwrite": true, "shell": "sh", "script": `echo "plik: $OVERVNC_FILE"; test -s "$OVERVNC_FILE"`, "timeoutSec": 30,
	})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "instalator v2.msi"))
	if !bytes.Equal(got, data) {
		t.Fatal("zapisany plik różni się od wysłanego")
	}
	if res.ExitCode != 0 || !strings.Contains(res.Output, "plik: "+filepath.Join(dir, "instalator v2.msi")) || !strings.Contains(res.Output, "Zapisano:") {
		t.Fatalf("wynik: %+v", res)
	}
	if calls.Load() < 2 {
		t.Fatal("oczekiwano wznowienia pobierania")
	}
	if _, err := os.Stat(filepath.Join(dir, "instalator v2.msi.overvnc-part")); !os.IsNotExist(err) {
		t.Fatal("plik tymczasowy nie został usunięty")
	}

	// ten sam plik już jest — bez ponownego pobierania
	before := calls.Load()
	if _, err := deploy(t, map[string]any{"runId": "deploy-run-0002", "url": "/api/agent/packages/7", "name": "instalator v2.msi", "size": len(data), "sha256": hex.EncodeToString(sum[:]), "dir": dir, "overwrite": true}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != before {
		t.Fatal("identyczny plik pobrany ponownie")
	}
	// bez nadpisywania — błąd
	if _, err := deploy(t, map[string]any{"runId": "deploy-run-0003", "url": "/api/agent/packages/7", "name": "instalator v2.msi", "size": len(data), "sha256": hex.EncodeToString(sum[:]), "dir": dir}); err == nil {
		t.Fatal("oczekiwano błędu: plik istnieje")
	}
}

func TestDeployRejectsBadChecksumAndNames(t *testing.T) {
	data := []byte("zawartość pliku konfiguracyjnego")
	deployServer(t, data, false)
	dir := t.TempDir()
	_, err := deploy(t, map[string]any{"runId": "deploy-run-0004", "url": "/api/agent/packages/8", "name": "config.json", "size": len(data), "sha256": strings.Repeat("0", 64), "dir": dir})
	if err == nil || !strings.Contains(err.Error(), "suma kontrolna") {
		t.Fatalf("oczekiwano odrzucenia przez sumę kontrolną: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.json")); !os.IsNotExist(err) {
		t.Fatal("plik ze złą sumą nie może zostać zapisany")
	}
	for _, name := range []string{"../evil.sh", "a/b", "", "..", "con:x"} {
		if _, err := deploy(t, map[string]any{"runId": "deploy-run-0005", "url": "/api/agent/packages/8", "name": name, "size": 1, "sha256": strings.Repeat("0", 64), "dir": dir}); err == nil {
			t.Fatalf("nazwa %q powinna zostać odrzucona", name)
		}
	}
	if _, err := deploy(t, map[string]any{"runId": "deploy-run-0006", "url": "/api/agent/packages/8", "name": "x", "size": 1, "sha256": strings.Repeat("0", 64), "dir": "względna/ścieżka"}); err == nil {
		t.Fatal("ścieżka względna powinna zostać odrzucona")
	}
	if _, err := deploy(t, map[string]any{"runId": "deploy-run-0007", "url": "https://zly.example/x", "name": "x", "size": 1, "sha256": strings.Repeat("0", 64), "dir": dir}); err == nil {
		t.Fatal("adres spoza serwera powinien zostać odrzucony")
	}
}
