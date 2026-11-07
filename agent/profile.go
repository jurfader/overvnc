package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
)

// Profil komputera: zwykły komputer albo kiosk. O profilu decyduje serwer (panel: „Dodaj kiosk”,
// edycja komputera) i wysyła go po każdym połączeniu (`agent.profile`). Agent zapamiętuje go w pliku
// obok konfiguracji (C:\ProgramData\OVERVNC — wykluczony z UWF), żeby funkcje kiosku działały też
// bez połączenia z serwerem. Na zwykłym komputerze funkcje kiosku są uśpione.

type KioskProfile struct {
	Kiosk    bool `json:"kiosk"`
	PhoneApp bool `json:"phoneApp"` // „Zdjęcia z telefonu”: kafelek w Start + otwieranie po podłączeniu telefonu
	// EndButton — „Zakończ i usuń moje dane”: przycisk na ekranie + kafelek w Start (czyszczenie = restart z UWF)
	EndButton bool `json:"endButton"`
	// Browser — przeglądarka dozwolona w trybie kiosku, w której otwiera się aplikacja (ustalana przy konfiguracji)
	Browser string `json:"browser,omitempty"`
	// Applied* — co faktycznie jest zapisane w systemie (tryb kiosku, kafelki). Różnica z PhoneApp/EndButton =
	// konfiguracja do zrobienia; przy włączonym UWF agent robi ją zadaniem z restartami i dopiero wtedy oznacza.
	AppliedPhone bool `json:"appliedPhone"`
	AppliedEnd   bool `json:"appliedEnd"`
	// Udział sieciowy folderu Pobrane klienta dla pracowników: "" / "off" / "read" / "delete";
	// ShareAllow — adresy, z których wolno się łączyć (puste = sieć lokalna).
	ShareMode         string `json:"shareMode,omitempty"`
	ShareAllow        string `json:"shareAllow,omitempty"`
	AppliedShareMode  string `json:"appliedShareMode,omitempty"`
	AppliedShareAllow string `json:"appliedShareAllow,omitempty"`
}

func shareOn(mode string) bool { return mode == "read" || mode == "delete" }

// needsSetup — tryb kiosku nie odpowiada jeszcze profilowi.
func (p KioskProfile) needsSetup() bool {
	return p.PhoneApp != p.AppliedPhone || p.EndButton != p.AppliedEnd || (p.PhoneApp && p.Browser == "") ||
		normShare(p.ShareMode) != normShare(p.AppliedShareMode) || (shareOn(p.ShareMode) && p.ShareAllow != p.AppliedShareAllow) ||
		pendingSharePassword()
}

func normShare(m string) string {
	if shareOn(m) {
		return m
	}
	return "off"
}

// applyKioskSetupNow — zapis trybu kiosku zgodnie z bieżącym profilem (ochrona przed zapisem wyłączona
// albo jej brak); po sukcesie profil oznaczony jako zastosowany.
func applyKioskSetupNow(ctx context.Context) (string, error) {
	p := currentProfile()
	browser, note, err := setupKioskApps(ctx, p.PhoneApp, p.EndButton)
	if err != nil {
		return "", err
	}
	// udział Pobranych (i hasło konta pracownika, jeśli czeka) — po trybie kiosku
	if p.Kiosk && (normShare(p.ShareMode) != normShare(p.AppliedShareMode) || shareOn(p.ShareMode) || pendingSharePassword()) {
		if err := setupShare(ctx, normShare(p.ShareMode), p.ShareAllow); err != nil {
			return "", fmt.Errorf("udział Pobrane: %w", err)
		}
	}
	p = currentProfile() // mógł przyjść nowszy profil
	if browser != "" {
		p.Browser = browser
	}
	p.AppliedPhone, p.AppliedEnd = p.PhoneApp, p.EndButton
	p.AppliedShareMode, p.AppliedShareAllow = p.ShareMode, p.ShareAllow
	if err := storeProfile(p); err != nil {
		return "", err
	}
	return note, nil
}

var profileState struct {
	mu     sync.Mutex
	loaded bool
	p      KioskProfile
}

func currentProfile() KioskProfile {
	profileState.mu.Lock()
	defer profileState.mu.Unlock()
	if !profileState.loaded && kioskDir != "" {
		if b, err := os.ReadFile(kioskFile("profile.json")); err == nil {
			_ = json.Unmarshal(b, &profileState.p)
		}
		profileState.loaded = true
	}
	return profileState.p
}

func storeProfile(p KioskProfile) error {
	profileState.mu.Lock()
	defer profileState.mu.Unlock()
	profileState.p, profileState.loaded = p, true
	b, _ := json.MarshalIndent(p, "", "  ")
	return os.WriteFile(kioskFile("profile.json"), b, 0o600)
}

func handleProfile(ctx context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		Kiosk      bool   `json:"kiosk"`
		PhoneApp   bool   `json:"phoneApp"`
		EndButton  bool   `json:"endButton"`
		ShareMode  string `json:"shareMode"`
		ShareAllow string `json:"shareAllow"`
	}](data)
	if err != nil {
		return nil, protoErr("bad_request", "nieprawidłowy profil")
	}
	prev := currentProfile()
	next := prev
	next.Kiosk, next.PhoneApp, next.EndButton = req.Kiosk, req.Kiosk && req.PhoneApp, req.Kiosk && req.EndButton
	next.ShareMode, next.ShareAllow = "off", ""
	if req.Kiosk && shareOn(req.ShareMode) {
		if !validAllowList(req.ShareAllow) {
			return nil, protoErr("bad_request", "nieprawidłowa lista adresów: %q", req.ShareAllow)
		}
		next.ShareMode, next.ShareAllow = req.ShareMode, req.ShareAllow
	}
	if next != prev {
		if err := storeProfile(next); err != nil {
			return nil, err
		}
	}
	note := ""
	// konfiguracja systemu, dopóki nie jest zapisana na stałe (agent dostaje profil po każdym połączeniu)
	if next.needsSetup() {
		if note, err = applyKioskSetup(ctx); err != nil {
			return nil, protoErr("kiosk_setup", "konfiguracja trybu kiosku: %v", err)
		}
	}
	return map[string]any{"ok": true, "note": note}, nil
}

func init() {
	handlers["agent.profile"] = handleProfile
	handlers["kiosk.sharepass"] = handleSharePassword
}

// validAllowList — adresy IPv4/IPv6 lub sieci (CIDR) oddzielone przecinkami; puste = sieć lokalna.
func validAllowList(s string) bool {
	if strings.TrimSpace(s) == "" {
		return true
	}
	for _, part := range strings.Split(s, ",") {
		p := strings.TrimSpace(part)
		if p == "" {
			continue
		}
		if net.ParseIP(p) == nil {
			if _, _, err := net.ParseCIDR(p); err != nil {
				return false
			}
		}
	}
	return true
}

// handleSharePassword — hasło konta „pracownik” do udziału Pobrane. Serwer go nie zapisuje; agent trzyma je
// zaszyfrowane (DPAPI, tylko ten komputer) do zapisania na stałe — przy UWF dopiero po restarcie.
func handleSharePassword(ctx context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		Password string `json:"password"`
	}](data)
	if err != nil || len([]rune(req.Password)) < 8 || len(req.Password) > 127 {
		return nil, protoErr("bad_request", "hasło musi mieć od 8 do 127 znaków")
	}
	if !currentProfile().Kiosk {
		return nil, protoErr("not_kiosk", "udział Pobrane jest funkcją kiosku")
	}
	if err := storeSharePassword(req.Password); err != nil {
		return nil, err
	}
	note, err := applyKioskSetup(ctx)
	if err != nil {
		return nil, protoErr("kiosk_setup", "hasło: %v", err)
	}
	return map[string]any{"ok": true, "note": note}, nil
}
