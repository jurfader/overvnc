package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Klucz publiczny wydań OVERVNC (Ed25519). Prywatny jest tylko w sekretach GitHub Actions —
// agent przyjmie wyłącznie binarkę podpisaną tym kluczem, nawet gdyby serwer został przejęty.
// Zmienna (nie stała) wyłącznie po to, by test e2e mógł zbudować agenta z kluczem testowym (-ldflags -X).
var updatePublicKeyB64 = "OQCYoIyr/Z7O2jbaEyFXJOwOVV4Ep9S/cbFDy//dZBs="

const (
	updateFirstCheck   = 2 * time.Minute
	updateInterval     = 6 * time.Hour
	updateHealthyAfter = 60 * time.Second
	maxBootsBeforeBack = 3
	maxBinarySize      = 200 << 20
)

// updatesEnabled — tylko usługa systemowa może się podmienić i zrestartować (w trybie „run” z terminala — nie).
var updatesEnabled = false

// exitForRestart — po podmianie binarki kończymy proces; menedżer usług uruchomi nową wersję. Podmienialne w testach.
var exitForRestart = func() { os.Exit(3) }

type Manifest struct {
	Version string                  `json:"version"`
	Created string                  `json:"created"`
	Files   map[string]ManifestFile `json:"files"`
}

type ManifestFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type updateOffer struct {
	Version   string `json:"version"`
	Manifest  string `json:"manifest"`  // base64 bajtów manifest.json
	Signature string `json:"signature"` // base64 podpisu Ed25519 tych bajtów
	Download  string `json:"download"`  // ścieżka pobrania binarki na serwerze
}

func platformKey() string { return runtime.GOOS + "-" + runtime.GOARCH }

// verifyManifest sprawdza podpis i zwraca manifest. Podpisane są dokładne bajty pliku manifest.json.
func verifyManifest(raw, sig []byte, pub ed25519.PublicKey) (*Manifest, error) {
	if len(pub) != ed25519.PublicKeySize || !ed25519.Verify(pub, raw, sig) {
		return nil, errors.New("nieprawidłowy podpis aktualizacji — odrzucona")
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("uszkodzony manifest: %w", err)
	}
	return &m, nil
}

// ---------- porównywanie wersji (semver: 1.2.3 > 1.2.3-rc1 > 1.2.2) ----------

func parseVersion(v string) (nums [3]int, pre string, ok bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexByte(v, '-'); i >= 0 {
		v, pre = v[:i], v[i+1:]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return nums, "", false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return nums, "", false
		}
		nums[i] = n
	}
	return nums, pre, true
}

// newerVersion — czy a jest nowsza niż b.
func newerVersion(a, b string) bool {
	an, ap, aok := parseVersion(a)
	bn, bp, bok := parseVersion(b)
	if !aok || !bok {
		return false
	}
	for i := range 3 {
		if an[i] != bn[i] {
			return an[i] > bn[i]
		}
	}
	if ap == bp {
		return false
	}
	if ap == "" || bp == "" {
		return ap == "" // wydanie jest nowsze niż jego wersja przedpremierowa/deweloperska
	}
	return ap > bp
}

// ---------- stan aktualizacji (wycofywanie nieudanych wersji) ----------

type updateState struct {
	From  string   `json:"from,omitempty"`
	To    string   `json:"to,omitempty"`
	Boots int      `json:"boots,omitempty"`
	Skip  []string `json:"skip,omitempty"` // wersje, które się nie sprawdziły — nie instalujemy ich ponownie
}

func statePath(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), "update-state.json")
}

func loadState(cfgPath string) updateState {
	var st updateState
	if b, err := os.ReadFile(statePath(cfgPath)); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	return st
}

func saveState(cfgPath string, st updateState) {
	b, _ := json.MarshalIndent(st, "", "  ")
	_ = os.WriteFile(statePath(cfgPath), b, 0o600)
}

// executablePath — ścieżka działającej binarki (zmienna, by testy nie podmieniały programu testowego).
var executablePath = func() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// checkUpdateRollback — wołane przy starcie usługi. Gdy nowa wersja wstaje po raz kolejny bez udanego
// połączenia z serwerem (np. pada przy starcie), po 3 próbach przywracamy poprzednią binarkę.
func checkUpdateRollback(cfgPath string) {
	st := loadState(cfgPath)
	if st.To == "" || st.To != version {
		return
	}
	st.Boots++
	if st.Boots <= maxBootsBeforeBack {
		saveState(cfgPath, st)
		return
	}
	exe, err := executablePath()
	if err != nil {
		return
	}
	if _, err := os.Stat(exe + ".old"); err != nil {
		logger.Errorf("wersja %s nie działa poprawnie, ale brak kopii poprzedniej wersji — nie można wycofać", st.To)
		saveState(cfgPath, st)
		return
	}
	_ = os.Remove(exe + ".failed")
	if err := os.Rename(exe, exe+".failed"); err != nil {
		logger.Errorf("wycofanie aktualizacji nie powiodło się: %v", err)
		return
	}
	if err := os.Rename(exe+".old", exe); err != nil {
		_ = os.Rename(exe+".failed", exe)
		logger.Errorf("wycofanie aktualizacji nie powiodło się: %v", err)
		return
	}
	logger.Errorf("wersja %s %d razy nie połączyła się z serwerem — przywracam %s", st.To, maxBootsBeforeBack, st.From)
	st.Skip = append(st.Skip, st.To)
	st.To, st.Boots = "", 0
	saveState(cfgPath, st)
	exitForRestart()
}

// markUpdateHealthy — nowa wersja połączyła się z serwerem i działa stabilnie: aktualizacja udana.
func markUpdateHealthy(cfgPath string) {
	st := loadState(cfgPath)
	if st.To != version {
		return
	}
	logger.Infof("aktualizacja do %s zakończona powodzeniem", version)
	st.From, st.To, st.Boots = "", "", 0
	saveState(cfgPath, st)
	if exe, err := executablePath(); err == nil {
		_ = os.Remove(exe + ".failed")
	}
}

// ---------- sprawdzanie i instalacja ----------

var updateMu sync.Mutex // jedna aktualizacja naraz

func agentRequest(ctx context.Context, cfg *Config, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(cfg.ServerURL, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.AgentID+"."+cfg.AgentSecret)
	return (&http.Client{Timeout: 10 * time.Minute}).Do(req)
}

// checkForUpdate pobiera ofertę z serwera, weryfikuje i instaluje. Zwraca status dla serwera/logów.
func checkForUpdate(ctx context.Context, cfg *Config, cfgPath string, pub ed25519.PublicKey) (string, error) {
	if !updatesEnabled {
		return "disabled", nil
	}
	if !updateMu.TryLock() {
		return "in_progress", nil
	}
	defer updateMu.Unlock()

	q := fmt.Sprintf("/api/agent/update?version=%s&platform=%s", version, platformKey())
	resp, err := agentRequest(ctx, cfg, q)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return "up_to_date", nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("serwer aktualizacji: HTTP %d", resp.StatusCode)
	}
	var offer updateOffer
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&offer); err != nil {
		return "", fmt.Errorf("nieprawidłowa oferta aktualizacji: %w", err)
	}
	raw, err1 := base64.StdEncoding.DecodeString(offer.Manifest)
	sig, err2 := base64.StdEncoding.DecodeString(offer.Signature)
	if err1 != nil || err2 != nil {
		return "", errors.New("nieprawidłowe kodowanie manifestu")
	}
	m, err := verifyManifest(raw, sig, pub)
	if err != nil {
		return "", err
	}
	if m.Version != offer.Version || !newerVersion(m.Version, version) {
		return "up_to_date", nil
	}
	if slices.Contains(loadState(cfgPath).Skip, m.Version) {
		return "skipped", nil // ta wersja już raz się nie sprawdziła na tym komputerze
	}
	file, ok := m.Files[platformKey()]
	if !ok || file.Size <= 0 || file.Size > maxBinarySize {
		return "", fmt.Errorf("brak binarki %s w wydaniu %s", platformKey(), m.Version)
	}

	exe, err := executablePath()
	if err != nil {
		return "", err
	}
	tmp := filepath.Join(filepath.Dir(exe), ".overvnc-update-"+m.Version)
	if err := downloadVerified(ctx, cfg, offer.Download, tmp, file); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := swapBinary(exe, tmp); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	st := loadState(cfgPath)
	st.From, st.To, st.Boots = version, m.Version, 0
	saveState(cfgPath, st)
	logger.Infof("zainstalowano aktualizację %s → %s, ponowne uruchomienie", version, m.Version)
	go func() {
		time.Sleep(2 * time.Second) // czas na odesłanie odpowiedzi serwerowi
		exitForRestart()
	}()
	return "restarting", nil
}

func downloadVerified(ctx context.Context, cfg *Config, path, dst string, file ManifestFile) error {
	resp, err := agentRequest(ctx, cfg, path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("pobieranie aktualizacji: HTTP %d", resp.StatusCode)
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, file.Size+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n != file.Size || hex.EncodeToString(h.Sum(nil)) != strings.ToLower(file.SHA256) {
		return errors.New("suma kontrolna pobranej aktualizacji się nie zgadza — odrzucona")
	}
	return nil
}

// swapBinary podmienia działający plik wykonywalny. Działający plik można przemianować (także na Windows),
// więc: bieżący -> .old, nowy -> bieżący; przy błędzie przywracamy stan.
func swapBinary(exe, fresh string) error {
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return fmt.Errorf("nie można przenieść bieżącej wersji: %w", err)
	}
	if err := os.Rename(fresh, exe); err != nil {
		_ = os.Rename(old, exe)
		return fmt.Errorf("nie można zainstalować nowej wersji: %w", err)
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(exe, 0o755)
	}
	return nil
}

// ---------- integracja z sesją ----------

var (
	updateCtxMu   sync.Mutex
	updateCfg     *Config
	updateCfgPath string
)

func setUpdateContext(cfg *Config, cfgPath string) {
	updateCtxMu.Lock()
	updateCfg, updateCfgPath = cfg, cfgPath
	updateCtxMu.Unlock()
}

func publicKey() ed25519.PublicKey {
	b, _ := base64.StdEncoding.DecodeString(updatePublicKeyB64)
	return ed25519.PublicKey(b)
}

// updateLoop — pierwsze sprawdzenie chwilę po starcie, potem co ~6 h (z rozrzutem, żeby flota nie pytała naraz).
func updateLoop(ctx context.Context, cfg *Config, cfgPath string) {
	wait := updateFirstCheck
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if status, err := checkForUpdate(ctx, cfg, cfgPath, publicKey()); err != nil {
			logger.Warningf("sprawdzanie aktualizacji: %v", err)
		} else if status == "restarting" {
			return
		}
		wait = updateInterval + time.Duration(time.Now().UnixNano()%int64(30*time.Minute))
	}
}

// update.check — serwer prosi o natychmiastowe sprawdzenie (np. administrator kliknął „Aktualizuj”).
func handleUpdateCheck(ctx context.Context, _ json.RawMessage) (any, error) {
	updateCtxMu.Lock()
	cfg, path := updateCfg, updateCfgPath
	updateCtxMu.Unlock()
	if cfg == nil {
		return nil, protoErr("not_ready", "agent nie jest gotowy")
	}
	status, err := checkForUpdate(ctx, cfg, path, publicKey())
	if err != nil {
		return nil, protoErr("update_failed", "%v", err)
	}
	return map[string]string{"status": status, "version": version}, nil
}

func init() {
	handlers["update.check"] = handleUpdateCheck
}
