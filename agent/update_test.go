package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
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

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.6.0", "0.5.0", true},
		{"0.6.0", "0.6.0-dev", true},
		{"0.6.0-dev", "0.6.0", false},
		{"0.6.1", "0.6.0", true},
		{"1.0.0", "0.99.99", true},
		{"0.6.0", "0.6.0", false},
		{"0.5.9", "0.6.0", false},
		{"v0.7.0", "0.6.0", true},
		{"0.6.0-rc2", "0.6.0-rc1", true},
		{"śmieci", "0.1.0", false},
	}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestIsClone(t *testing.T) {
	base := MachineID{HostID: "abc", MACs: []string{"00:11:22:33:44:55", "00:11:22:33:44:66"}}
	if isClone(base, base) {
		t.Error("ten sam komputer to nie klon")
	}
	if isClone(base, MachineID{HostID: "abc", MACs: []string{"00:11:22:33:44:66", "aa:aa:aa:aa:aa:aa"}}) {
		t.Error("wymiana jednej karty to nie klon")
	}
	if !isClone(base, MachineID{HostID: "abc", MACs: []string{"aa:bb:cc:dd:ee:ff"}}) {
		t.Error("ten sam machine-id, ale inne karty sieciowe = klon maszyny wirtualnej")
	}
	if !isClone(base, MachineID{HostID: "xyz", MACs: base.MACs}) {
		t.Error("inny identyfikator systemu = inny komputer")
	}
	if isClone(base, MachineID{HostID: "abc"}) {
		t.Error("brak kart (np. sieć jeszcze nie wstała) nie może wywołać ponownej rejestracji")
	}
}

// fakeRelease — podpisane wydanie z binarką dla bieżącej platformy.
type fakeRelease struct {
	priv     ed25519.PrivateKey
	pub      ed25519.PublicKey
	binary   []byte
	manifest []byte
	sig      []byte
}

func newRelease(t *testing.T, ver string) *fakeRelease {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	bin := []byte("#!nowa-wersja-" + ver)
	sum := sha256.Sum256(bin)
	m, _ := json.Marshal(Manifest{Version: ver, Files: map[string]ManifestFile{platformKey(): {Name: "agent", Size: int64(len(bin)), SHA256: hex.EncodeToString(sum[:])}}})
	return &fakeRelease{priv: priv, pub: pub, binary: bin, manifest: m, sig: ed25519.Sign(priv, m)}
}

func (r *fakeRelease) server(t *testing.T, tamper bool) (*httptest.Server, *atomic.Int32) {
	var downloads atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/agent/update", func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer id.secret" {
			w.WriteHeader(401)
			return
		}
		var m Manifest
		_ = json.Unmarshal(r.manifest, &m)
		_ = json.NewEncoder(w).Encode(updateOffer{
			Version:   m.Version,
			Manifest:  base64.StdEncoding.EncodeToString(r.manifest),
			Signature: base64.StdEncoding.EncodeToString(r.sig),
			Download:  "/dl",
		})
	})
	mux.HandleFunc("/dl", func(w http.ResponseWriter, _ *http.Request) {
		downloads.Add(1)
		b := r.binary
		if tamper {
			b = append([]byte{}, b...)
			b[0] ^= 0xFF
		}
		_, _ = w.Write(b)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &downloads
}

func setupUpdateEnv(t *testing.T) (exe, cfgPath string, restarted *atomic.Int32) {
	dir := t.TempDir()
	exe = filepath.Join(dir, "overvnc-agent")
	os.WriteFile(exe, []byte("stara-wersja"), 0o755)
	cfgPath = filepath.Join(dir, "agent.json")
	oldExe, oldExit, oldEnabled, oldVer := executablePath, exitForRestart, updatesEnabled, version
	restarted = &atomic.Int32{}
	executablePath = func() (string, error) { return exe, nil }
	exitForRestart = func() { restarted.Add(1) }
	updatesEnabled = true
	version = "0.5.0"
	t.Cleanup(func() { executablePath, exitForRestart, updatesEnabled, version = oldExe, oldExit, oldEnabled, oldVer })
	return
}

func TestUpdateInstallsSignedRelease(t *testing.T) {
	exe, cfgPath, restarted := setupUpdateEnv(t)
	rel := newRelease(t, "0.6.0")
	srv, _ := rel.server(t, false)
	cfg := &Config{ServerURL: srv.URL, AgentID: "id", AgentSecret: "secret"}

	status, err := checkForUpdate(context.Background(), cfg, cfgPath, rel.pub)
	if err != nil || status != "restarting" {
		t.Fatalf("status=%s err=%v", status, err)
	}
	if b, _ := os.ReadFile(exe); string(b) != string(rel.binary) {
		t.Errorf("binarka nie została podmieniona: %q", b)
	}
	if b, _ := os.ReadFile(exe + ".old"); string(b) != "stara-wersja" {
		t.Errorf("brak kopii poprzedniej wersji: %q", b)
	}
	st := loadState(cfgPath)
	if st.From != "0.5.0" || st.To != "0.6.0" {
		t.Errorf("stan: %+v", st)
	}
	waitFor(t, func() bool { return restarted.Load() == 1 })
}

func TestUpdateRejectsForeignSignatureAndBadChecksum(t *testing.T) {
	exe, cfgPath, _ := setupUpdateEnv(t)
	rel := newRelease(t, "0.6.0")
	cfg := func(url string) *Config { return &Config{ServerURL: url, AgentID: "id", AgentSecret: "secret"} }

	// podpis innym kluczem (np. przejęty serwer próbuje podsunąć własną binarkę)
	srv, downloads := rel.server(t, false)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := checkForUpdate(context.Background(), cfg(srv.URL), cfgPath, otherPub); err == nil || !strings.Contains(err.Error(), "podpis") {
		t.Errorf("obcy podpis musi być odrzucony: %v", err)
	}
	if downloads.Load() != 0 {
		t.Error("przy złym podpisie binarka nie powinna być nawet pobierana")
	}
	// prawidłowy manifest, ale podmieniona binarka
	srv2, _ := rel.server(t, true)
	if _, err := checkForUpdate(context.Background(), cfg(srv2.URL), cfgPath, rel.pub); err == nil || !strings.Contains(err.Error(), "suma kontrolna") {
		t.Errorf("zła suma kontrolna musi być odrzucona: %v", err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "stara-wersja" {
		t.Error("po odrzuceniu aktualizacji binarka musi zostać nietknięta")
	}
	entries, _ := os.ReadDir(filepath.Dir(exe))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".overvnc-update") {
			t.Errorf("pozostał plik tymczasowy %s", e.Name())
		}
	}
}

func TestUpdateSkipsOlderAndFailedVersions(t *testing.T) {
	_, cfgPath, _ := setupUpdateEnv(t)
	old := newRelease(t, "0.4.0")
	srv, downloads := old.server(t, false)
	cfg := &Config{ServerURL: srv.URL, AgentID: "id", AgentSecret: "secret"}
	if s, _ := checkForUpdate(context.Background(), cfg, cfgPath, old.pub); s != "up_to_date" {
		t.Errorf("starsza wersja nie jest aktualizacją: %s", s)
	}
	failed := newRelease(t, "0.6.0")
	srv2, _ := failed.server(t, false)
	saveState(cfgPath, updateState{Skip: []string{"0.6.0"}})
	cfg.ServerURL = srv2.URL
	if s, _ := checkForUpdate(context.Background(), cfg, cfgPath, failed.pub); s != "skipped" {
		t.Errorf("wersja, która się nie sprawdziła, ma być pomijana: %s", s)
	}
	if downloads.Load() != 0 {
		t.Error("nie pobieramy wersji starszej")
	}
}

func TestRollbackAfterRepeatedFailedStarts(t *testing.T) {
	exe, cfgPath, restarted := setupUpdateEnv(t)
	version = "0.6.0"
	os.WriteFile(exe, []byte("nowa-zepsuta"), 0o755)
	os.WriteFile(exe+".old", []byte("stara-dzialajaca"), 0o755)
	saveState(cfgPath, updateState{From: "0.5.0", To: "0.6.0"})

	for range maxBootsBeforeBack {
		checkUpdateRollback(cfgPath)
	}
	if restarted.Load() != 0 {
		t.Fatal("wycofanie za wcześnie")
	}
	checkUpdateRollback(cfgPath) // 4. nieudany start
	if restarted.Load() != 1 {
		t.Fatal("brak wycofania po 3 nieudanych startach")
	}
	if b, _ := os.ReadFile(exe); string(b) != "stara-dzialajaca" {
		t.Errorf("nie przywrócono poprzedniej wersji: %q", b)
	}
	if st := loadState(cfgPath); len(st.Skip) != 1 || st.Skip[0] != "0.6.0" || st.To != "" {
		t.Errorf("stan po wycofaniu: %+v", st)
	}
}

func TestHealthyUpdateClearsState(t *testing.T) {
	exe, cfgPath, _ := setupUpdateEnv(t)
	version = "0.6.0"
	os.WriteFile(exe+".failed", nil, 0o644)
	saveState(cfgPath, updateState{From: "0.5.0", To: "0.6.0", Boots: 2, Skip: []string{"0.5.5"}})
	markUpdateHealthy(cfgPath)
	if st := loadState(cfgPath); st.To != "" || st.Boots != 0 || len(st.Skip) != 1 {
		t.Errorf("stan: %+v", st)
	}
}

func TestDeferredEnrollmentAndCloneReenroll(t *testing.T) {
	var enrolls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["token"] != "ovnc_kiosk" {
			w.WriteHeader(403)
			return
		}
		n := enrolls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]string{"agentId": "agent-" + string(rune('0'+n)), "agentSecret": "s"})
	}))
	defer srv.Close()
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.json")

	// obraz ISO: tylko token, bez tożsamości
	if err := enroll(path, srv.URL, "ovnc_kiosk", false, true); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil || cfg.enrolled() {
		t.Fatalf("konfiguracja startowa: %+v %v", cfg, err)
	}
	if !ensureIdentity(context.Background(), path, cfg) || cfg.AgentID != "agent-1" || cfg.Machine == nil {
		t.Fatalf("rejestracja w tle: %+v", cfg)
	}
	saved, _ := loadConfig(path)
	if saved.AgentID != "agent-1" || saved.EnrollToken == "" {
		t.Errorf("zapisana konfiguracja: %+v", saved)
	}

	// ten sam plik na innym komputerze (klon) -> nowa rejestracja
	saved.Machine = &MachineID{HostID: "inny-komputer"}
	ensureIdentity(context.Background(), path, saved)
	if saved.AgentID != "agent-2" || enrolls.Load() != 2 {
		t.Errorf("po wykryciu klonu: %+v (rejestracji: %d)", saved, enrolls.Load())
	}
	// ten sam komputer — bez ponownej rejestracji
	ensureIdentity(context.Background(), path, saved)
	if enrolls.Load() != 2 {
		t.Error("ponowna rejestracja bez powodu")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for range 400 {
		if cond() {
			return
		}
		sleepMs(10)
	}
	t.Fatal("waitFor: timeout")
}

func sleepMs(n int) { <-time.After(time.Duration(n) * time.Millisecond) }
