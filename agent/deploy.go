package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// Wdrożenie pliku (zadania): agent pobiera plik z serwera (uwierzytelnienie kluczem agenta, wznawianie
// od miejsca przerwania), sprawdza rozmiar i SHA-256, zapisuje w folderze docelowym i opcjonalnie
// uruchamia skrypt instalacji (ścieżka pliku w zmiennej OVERVNC_FILE). Działa niezależnie od połączenia
// jak script.run — wynik odbierany poleceniem script.result.

const (
	maxDeploySize     = 4 << 30
	deployDownloadMax = 2 * time.Hour
)

type deployReq struct {
	RunID      string `json:"runId"`
	URL        string `json:"url"` // ścieżka na serwerze, np. /api/agent/packages/12
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256"`
	Dir        string `json:"dir"`
	Overwrite  bool   `json:"overwrite"`
	Shell      string `json:"shell"`
	Script     string `json:"script"`
	TimeoutSec int    `json:"timeoutSec"`
	AsUser     bool   `json:"asUser"`
}

// safeFileName — sama nazwa pliku (bez folderów i znaków niedozwolonych w Windows).
func safeFileName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." || len(name) > 200 || !utf8.ValidString(name) || strings.ContainsAny(name, `/\:*?"<>|`) {
		return "", false
	}
	for _, r := range name {
		if r < 32 {
			return "", false
		}
	}
	return name, true
}

func handleDeployRun(ctx context.Context, data json.RawMessage) (any, error) {
	req, err := decode[deployReq](data)
	if err != nil {
		return nil, err
	}
	if !runIDRe.MatchString(req.RunID) {
		return nil, protoErr("bad_request", "nieprawidłowy identyfikator uruchomienia")
	}
	name, ok := safeFileName(req.Name)
	if !ok {
		return nil, protoErr("bad_request", "nieprawidłowa nazwa pliku")
	}
	if !strings.HasPrefix(req.URL, "/api/agent/packages/") || req.Size <= 0 || req.Size > maxDeploySize || len(req.SHA256) != 64 {
		return nil, protoErr("bad_request", "nieprawidłowy opis pliku")
	}
	dir := filepath.Clean(req.Dir)
	if !filepath.IsAbs(dir) {
		return nil, protoErr("bad_request", "folder docelowy musi być pełną ścieżką")
	}
	var sh shellSpec
	if strings.TrimSpace(req.Script) != "" {
		if sh, ok = findShell(req.Shell); !ok {
			return nil, protoErr("no_shell", "powłoka %q nie jest dostępna na tym komputerze", req.Shell)
		}
		if req.AsUser && !userScriptsSupported() {
			return nil, protoErr("unsupported", "uruchamianie jako zalogowany użytkownik nie jest obsługiwane na tym systemie")
		}
	}
	limit := defaultScriptLimit
	if req.TimeoutSec > 0 {
		limit = min(time.Duration(req.TimeoutSec)*time.Second, maxScriptTimeout)
	}
	return startRun(ctx, req.RunID, deployDownloadMax+limit, func(rctx context.Context) (scriptResult, error) {
		start := time.Now()
		dest := filepath.Join(dir, name)
		if err := deployDownload(rctx, req, dir, dest); err != nil {
			return scriptResult{}, err
		}
		note := fmt.Sprintf("Zapisano: %s (%s)\n", dest, humanBytes(req.Size))
		if sh.name == "" {
			return scriptResult{Output: note, DurationMs: time.Since(start).Milliseconds()}, nil
		}
		out := &cappedOutput{head: scriptOutputHead, tail: scriptOutputTail}
		_, _ = out.Write([]byte(note))
		sctx, cancel := context.WithTimeout(rctx, limit)
		defer cancel()
		scriptStart := time.Now()
		res, err := executeScriptOut(sctx, sh, scriptReq{Script: withEnvVar(sh, "OVERVNC_FILE", dest, req.Script), AsUser: req.AsUser}, out)
		res.DurationMs = time.Since(start).Milliseconds()
		// instalacja mogła zmienić listę programów — od razu nowy inwentarz w panelu
		requestInventory()
		if err == nil {
			// instalatory uruchamiane po cichu zwykle nic nie wypisują — wynik polecenia ma być widoczny
			res.Output = strings.TrimRight(res.Output, "\n") + fmt.Sprintf("\nPolecenie po zapisaniu: kod zakończenia %d (%.1f s)\n", res.ExitCode, time.Since(scriptStart).Seconds())
		}
		return res, err
	})
}

// deployDownload pobiera plik do „.overvnc-part” (wznawiając), sprawdza i przenosi na miejsce.
func deployDownload(ctx context.Context, req deployReq, dir, dest string) error {
	if fi, err := os.Stat(dest); err == nil {
		if fi.IsDir() {
			return protoErr("exists", "w miejscu pliku jest folder: %s", dest)
		}
		if !req.Overwrite {
			return protoErr("exists", "plik już istnieje: %s (wdrożenie bez nadpisywania)", dest)
		}
		// ten sam plik już jest — nie pobieramy drugi raz
		if fi.Size() == req.Size {
			if sum, err := fileSHA256(dest); err == nil && sum == strings.ToLower(req.SHA256) {
				return nil
			}
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return protoErr("failed", "nie można utworzyć folderu %s: %v", dir, err)
	}
	updateCtxMu.Lock()
	cfg := updateCfg
	updateCtxMu.Unlock()
	if cfg == nil {
		return protoErr("failed", "agent nie jest połączony z serwerem")
	}
	part := dest + ".overvnc-part"
	// kilka prób — przerwane pobieranie wznawia od miejsca, w którym stanęło
	var lastErr error
	for attempt := range 4 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return protoErr("timeout", "przekroczono czas pobierania")
			case <-time.After(time.Duration(attempt*5) * time.Second):
			}
		}
		if lastErr = downloadPart(ctx, cfg, req, part); lastErr == nil {
			break
		}
		if pe, ok := lastErr.(*ProtoError); ok && pe.Code != "download" {
			break // błąd, którego ponowienie nie naprawi (np. brak uprawnień)
		}
	}
	if lastErr != nil {
		return lastErr
	}
	sum, err := fileSHA256(part)
	if err != nil {
		return protoErr("failed", "odczyt pobranego pliku: %v", err)
	}
	if sum != strings.ToLower(req.SHA256) {
		_ = os.Remove(part)
		return protoErr("checksum", "suma kontrolna pobranego pliku się nie zgadza — odrzucony")
	}
	if req.Overwrite {
		_ = os.Remove(dest)
	}
	if err := os.Rename(part, dest); err != nil {
		return protoErr("failed", "nie można zapisać %s (plik w użyciu?): %v", dest, err)
	}
	return nil
}

func downloadPart(ctx context.Context, cfg *Config, req deployReq, part string) error {
	var have int64
	if fi, err := os.Stat(part); err == nil {
		have = fi.Size()
	}
	if have > req.Size {
		_ = os.Remove(part)
		have = 0
	}
	if have == req.Size {
		return nil
	}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(cfg.ServerURL, "/")+req.URL, nil)
	if err != nil {
		return protoErr("failed", "%v", err)
	}
	hreq.Header.Set("Authorization", "Bearer "+cfg.AgentID+"."+cfg.AgentSecret)
	if have > 0 {
		hreq.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	resp, err := (&http.Client{}).Do(hreq)
	if err != nil {
		return protoErr("download", "pobieranie: %v", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusPartialContent && have > 0:
	case resp.StatusCode == http.StatusOK:
		have = 0 // serwer wysyła całość
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound:
		return protoErr("not_available", "serwer nie udostępnił pliku (HTTP %d) — zadanie anulowane albo plik usunięty", resp.StatusCode)
	default:
		return protoErr("download", "pobieranie: HTTP %d", resp.StatusCode)
	}
	flags := os.O_CREATE | os.O_WRONLY
	if have == 0 {
		flags |= os.O_TRUNC
	} else {
		flags |= os.O_APPEND
	}
	f, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return protoErr("failed", "zapis %s: %v", part, err)
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, req.Size-have))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return protoErr("download", "pobieranie przerwane: %v", err)
	}
	if fi, err := os.Stat(part); err != nil || fi.Size() != req.Size {
		return protoErr("download", "pobieranie przerwane przed końcem pliku")
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func init() {
	handlers["deploy.run"] = handleDeployRun
	handlerTimeouts["deploy.run"] = deployDownloadMax + maxScriptTimeout + time.Minute
}
