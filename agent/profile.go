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
	next := KioskProfile{Kiosk: req.Kiosk, PhoneApp: req.Kiosk && req.PhoneApp, EndButton: req.Kiosk && req.EndButton, Browser: prev.Browser}
	note := ""
	// konfiguracja systemu tylko przy zmianie (agent dostaje profil po każdym połączeniu)
	if next.PhoneApp != prev.PhoneApp || next.EndButton != prev.EndButton || (next.PhoneApp && prev.Browser == "") {
		browser, msg, err := setupKioskApps(ctx, next.PhoneApp, next.EndButton)
		if err != nil {
			return nil, protoErr("kiosk_setup", "konfiguracja trybu kiosku: %v", err)
		}
		if browser != "" {
			next.Browser = browser
		}
		note = msg
	}
	if next != prev {
		if err := storeProfile(next); err != nil {
			return nil, err
		}
	}
	return map[string]any{"ok": true, "note": note}, nil
}

func init() {
	handlers["agent.profile"] = handleProfile
}
