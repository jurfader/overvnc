package main

import (
	"context"
	"sync"
	"time"
)

// Stan zabezpieczeń komputera: antywirus, zapora, szyfrowanie dysku, aktualizacje systemu.
// Szybkie sprawdzenia (kilka sekund) idą z każdym inwentarzem i co godzinę osobno („security”),
// wyszukiwanie aktualizacji (bywa wolne, nawet minuty) — w tle raz na 12 godzin, z pamięcią wyniku.
// Ocenę (co jest problemem i jak poważnym) robi serwer — agent podaje surowe fakty.

const (
	securityInterval = time.Hour
	updatesInterval  = 12 * time.Hour
	updatesTimeout   = 10 * time.Minute
)

type Security struct {
	CheckedAt  int64           `json:"checkedAt"`
	Antivirus  *AntivirusState `json:"antivirus,omitempty"`
	Firewall   *FirewallState  `json:"firewall,omitempty"`
	Encryption *EncryptionInfo `json:"encryption,omitempty"`
	Updates    *UpdatesState   `json:"updates,omitempty"`
	// macOS: Gatekeeper (tylko podpisane aplikacje) i SIP (ochrona plików systemu)
	Gatekeeper *bool `json:"gatekeeper,omitempty"`
	SIP        *bool `json:"sip,omitempty"`
}

type AntivirusState struct {
	// Defender (Windows) — gdy inny antywirus jest aktywny, Defender bywa wyłączony celowo
	Defender         bool        `json:"defender"`
	Enabled          bool        `json:"enabled"`
	RealTime         bool        `json:"realTime"`
	TamperProtected  bool        `json:"tamperProtected,omitempty"`
	SignatureAgeDays int         `json:"signatureAgeDays"` // -1 = nieznane
	SignatureUpdated int64       `json:"signatureUpdated,omitempty"`
	Products         []AVProduct `json:"products,omitempty"` // Centrum zabezpieczeń Windows (także inne antywirusy)
}

type AVProduct struct {
	Name     string `json:"name"`
	Enabled  bool   `json:"enabled"`
	UpToDate bool   `json:"upToDate"`
}

type FirewallState struct {
	Enabled  bool          `json:"enabled"` // wszystkie profile włączone
	Profiles []FirewallSet `json:"profiles,omitempty"`
}

type FirewallSet struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

type EncryptionInfo struct {
	Name    string `json:"name"`    // BitLocker / FileVault
	Enabled bool   `json:"enabled"` // dysk systemowy zaszyfrowany i chroniony
	Status  string `json:"status,omitempty"`
}

type UpdatesState struct {
	CheckedAt      int64    `json:"checkedAt,omitempty"` // 0 = jeszcze nie sprawdzono
	Pending        int      `json:"pending"`
	Security       int      `json:"security"`         // w tym poprawki bezpieczeństwa
	Titles         []string `json:"titles,omitempty"` // do 15 nazw
	Error          string   `json:"error,omitempty"`
	RebootRequired bool     `json:"rebootRequired"`
	LastInstalled  int64    `json:"lastInstalled,omitempty"` // ostatnia zainstalowana poprawka (Windows)
}

// updatesCache — wynik ostatniego wyszukiwania aktualizacji (wolnego), dołączany do szybkich sprawdzeń.
var updatesCache struct {
	mu   sync.Mutex
	last *UpdatesState
}

func cachedUpdates() *UpdatesState {
	updatesCache.mu.Lock()
	defer updatesCache.mu.Unlock()
	if updatesCache.last == nil {
		return nil
	}
	u := *updatesCache.last
	return &u
}

// collectSecurity — szybkie sprawdzenia + ostatni wynik wyszukiwania aktualizacji.
func collectSecurity(ctx context.Context) *Security {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	s := collectSecurityFast(ctx)
	if s == nil {
		return nil
	}
	s.CheckedAt = time.Now().UnixMilli()
	if u := cachedUpdates(); u != nil {
		if s.Updates == nil {
			s.Updates = &UpdatesState{}
		}
		reboot, last := s.Updates.RebootRequired, s.Updates.LastInstalled
		*s.Updates = *u
		s.Updates.RebootRequired = s.Updates.RebootRequired || reboot
		if last != 0 {
			s.Updates.LastInstalled = last
		}
	}
	return s
}

// securityNow — prośba o wysłanie stanu zabezpieczeń (np. po wyszukaniu aktualizacji).
var securityNow = make(chan struct{}, 1)

// runUpdatesChecker — wyszukiwanie aktualizacji w tle: 3 min po starcie, potem co 12 h.
func runUpdatesChecker(ctx context.Context) {
	if !updatesSupported() {
		return
	}
	timer := time.NewTimer(3 * time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		cctx, cancel := context.WithTimeout(ctx, updatesTimeout)
		u := checkUpdates(cctx)
		cancel()
		u.CheckedAt = time.Now().UnixMilli()
		updatesCache.mu.Lock()
		updatesCache.last = u
		updatesCache.mu.Unlock()
		select {
		case securityNow <- struct{}{}:
		default:
		}
		timer.Reset(updatesInterval)
	}
}

// sendSecurity — stan zabezpieczeń między inwentarzami (co godzinę i po wyszukaniu aktualizacji).
func sendSecurity(ctx context.Context, send func(string, any) error) error {
	s := collectSecurity(ctx)
	if s == nil {
		return nil
	}
	return send("security", s)
}
