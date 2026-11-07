package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestProfileAppliedTracking(t *testing.T) {
	dir := t.TempDir()
	oldDir := kioskDir
	kioskDir = dir
	t.Cleanup(func() {
		kioskDir = oldDir
		profileState.loaded, profileState.p = false, KioskProfile{}
	})
	// profil zapisany przez 0.20.0: funkcje „włączone”, ale bez informacji o zapisie w systemie (np. pod UWF)
	_ = os.WriteFile(filepath.Join(dir, "profile.json"), []byte(`{"kiosk":true,"phoneApp":true,"endButton":true,"browser":"C:\\chrome.exe"}`), 0o600)
	profileState.loaded = false
	if !currentProfile().needsSetup() {
		t.Fatal("profil ze starszej wersji musi zostać zastosowany ponownie")
	}
	b, _ := json.Marshal(map[string]bool{"kiosk": true, "phoneApp": true, "endButton": true})
	if _, err := handleProfile(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	p := currentProfile()
	if !p.AppliedPhone || !p.AppliedEnd || p.needsSetup() {
		t.Fatalf("po zastosowaniu: %+v", p)
	}
	// wyłączenie przycisku = znowu konfiguracja; zwykły komputer = wszystko wyłączone
	b, _ = json.Marshal(map[string]bool{"kiosk": false, "phoneApp": true, "endButton": true})
	if _, err := handleProfile(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if p := currentProfile(); p.PhoneApp || p.EndButton || p.AppliedPhone || p.AppliedEnd {
		t.Fatalf("zwykły komputer z funkcjami kiosku: %+v", p)
	}
}

func TestValidAllowList(t *testing.T) {
	for s, ok := range map[string]bool{
		"":                           true,
		"192.168.1.20":               true,
		"192.168.1.20, 192.168.1.21": true,
		"192.168.1.0/24":             true,
		"fe80::1":                    true,
		"192.168.1.300":              false,
		"komputer-pracownika":        false,
		"1.2.3.4; rm -rf /":          false,
	} {
		if validAllowList(s) != ok {
			t.Errorf("%q: oczekiwano %v", s, ok)
		}
	}
}
