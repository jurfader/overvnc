package main

import (
	"context"
	"encoding/json"
	"os"
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
}

// needsSetup — tryb kiosku nie odpowiada jeszcze profilowi.
func (p KioskProfile) needsSetup() bool {
	return p.PhoneApp != p.AppliedPhone || p.EndButton != p.AppliedEnd || (p.PhoneApp && p.Browser == "")
}

// applyKioskSetupNow — zapis trybu kiosku zgodnie z bieżącym profilem (ochrona przed zapisem wyłączona
// albo jej brak); po sukcesie profil oznaczony jako zastosowany.
func applyKioskSetupNow(ctx context.Context) (string, error) {
	p := currentProfile()
	browser, note, err := setupKioskApps(ctx, p.PhoneApp, p.EndButton)
	if err != nil {
		return "", err
	}
	p = currentProfile() // mógł przyjść nowszy profil
	if browser != "" {
		p.Browser = browser
	}
	p.AppliedPhone, p.AppliedEnd = p.PhoneApp, p.EndButton
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
		Kiosk     bool `json:"kiosk"`
		PhoneApp  bool `json:"phoneApp"`
		EndButton bool `json:"endButton"`
	}](data)
	if err != nil {
		return nil, protoErr("bad_request", "nieprawidłowy profil")
	}
	prev := currentProfile()
	next := prev
	next.Kiosk, next.PhoneApp, next.EndButton = req.Kiosk, req.Kiosk && req.PhoneApp, req.Kiosk && req.EndButton
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
}
