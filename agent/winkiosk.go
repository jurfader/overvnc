package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Stan Windows ważny dla kiosków: licencja (wersja ewaluacyjna 90 dni), ochrona przed zapisem (UWF)
// i zadanie wieloetapowe (np. przedłużanie okresu próbnego z restartami), które przetrwa restart.

type WinStatus struct {
	License  *WinLicense      `json:"license,omitempty"`
	UWF      *UWFStatus       `json:"uwf,omitempty"`
	Task     *KioskTask       `json:"task,omitempty"`     // zadanie w toku
	LastTask *KioskTaskResult `json:"lastTask,omitempty"` // wynik ostatniego zadania
	Share    *ShareStatus     `json:"share,omitempty"`    // kiosk: udział sieciowy folderu Pobrane
}

type WinLicense struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Status       int    `json:"status"` // 0 bez licencji, 1 licencja, 2–6 okresy przejściowe
	Evaluation   bool   `json:"evaluation"`
	GraceMinutes int64  `json:"graceMinutes"` // do końca okresu (dla wersji ewaluacyjnej — do wygaśnięcia)
	EvalEnd      int64  `json:"evalEnd,omitempty"`
	RearmsLeft   int    `json:"rearmsLeft"`
}

type UWFStatus struct {
	Installed     bool  `json:"installed"`
	Enabled       bool  `json:"enabled"`     // teraz
	NextEnabled   bool  `json:"nextEnabled"` // po restarcie
	OverlayUsedMB int64 `json:"overlayUsedMB"`
	OverlayFreeMB int64 `json:"overlayFreeMB"`
	AgentExcluded bool  `json:"agentExcluded"` // folder OVERVNC wykluczony z UWF (stan zadań przetrwa restart)
}

type KioskTask struct {
	Kind        string `json:"kind"` // extend
	Step        string `json:"step"` // rearm, rearming, verify
	Started     int64  `json:"started"`
	StepBoot    uint64 `json:"stepBoot"` // czas startu systemu, gdy zapisano krok (krok czeka na kolejny restart)
	Reenable    bool   `json:"reenable"` // po przedłużeniu włączyć ochronę przed zapisem
	GraceBefore int64  `json:"graceBefore"`
}

type KioskTaskResult struct {
	Kind    string `json:"kind"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	At      int64  `json:"at"`
}

const kioskTaskMaxAge = 3 * time.Hour

var (
	kioskMu  sync.Mutex
	kioskDir string // folder konfiguracji agenta (C:\ProgramData\OVERVNC) — wykluczony z UWF
	// inventoryNow — prośba o natychmiastowe wysłanie inwentarza (np. po zakończeniu zadania)
	inventoryNow = make(chan struct{}, 1)
)

func setKioskContext(cfgPath string) { kioskDir = filepath.Dir(cfgPath) }

func requestInventory() {
	select {
	case inventoryNow <- struct{}{}:
	default:
	}
}

func kioskFile(name string) string { return filepath.Join(kioskDir, name) }

func loadKioskTask() *KioskTask {
	var t KioskTask
	if b, err := os.ReadFile(kioskFile("kiosk-task.json")); err != nil || json.Unmarshal(b, &t) != nil || t.Kind == "" {
		return nil
	}
	return &t
}

func saveKioskTask(t *KioskTask) error {
	b, _ := json.Marshal(t)
	return writeFileSync(kioskFile("kiosk-task.json"), b)
}

func clearKioskTask() { _ = os.Remove(kioskFile("kiosk-task.json")) }

func loadKioskResult() *KioskTaskResult {
	var r KioskTaskResult
	if b, err := os.ReadFile(kioskFile("kiosk-result.json")); err != nil || json.Unmarshal(b, &r) != nil || r.Kind == "" {
		return nil
	}
	return &r
}

func saveKioskResult(kind string, ok bool, msg string) {
	b, _ := json.Marshal(KioskTaskResult{Kind: kind, OK: ok, Message: msg, At: time.Now().UnixMilli()})
	_ = writeFileSync(kioskFile("kiosk-result.json"), b)
	if ok {
		logger.Infof("zadanie %s: %s", kind, msg)
	} else {
		logger.Warningf("zadanie %s: %s", kind, msg)
	}
}

// writeFileSync zapisuje plik i wymusza zapis na dysk — zaraz potem może nastąpić restart.
func writeFileSync(path string, b []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
