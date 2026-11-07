package main

import (
	"context"
	"errors"
	"time"
)

// Zapis funkcji kiosku przy włączonej ochronie przed zapisem (UWF): zmiany w trybie kiosku trafiłyby tylko
// do nakładki i zniknęły po restarcie. Zadanie wieloetapowe (jak przedłużanie licencji) przetrwa restarty:
// wyłącz UWF → restart → zapisz tryb kiosku → włącz UWF → restart.

func applyKioskSetup(ctx context.Context) (string, error) {
	kioskMu.Lock()
	defer kioskMu.Unlock()
	if t := loadKioskTask(); t != nil && time.Since(time.UnixMilli(t.Started)) < kioskTaskMaxAge {
		if t.Kind == "profile" {
			return "Konfiguracja funkcji kiosku jest w toku (restarty).", nil
		}
		return "Trwa inne zadanie kiosku — funkcje zostaną zapisane przy następnym połączeniu.", nil
	}
	st := collectWinStatus(ctx)
	if st.UWF == nil || !st.UWF.Enabled {
		return applyKioskSetupNow(ctx)
	}
	if !st.UWF.AgentExcluded {
		return "", errors.New("ochrona przed zapisem (UWF) jest włączona, a folder C:\\ProgramData\\OVERVNC nie jest z niej wykluczony — włącz tryb serwisowy i zmień ustawienie ponownie")
	}
	if err := saveKioskTask(&KioskTask{Kind: "profile", Step: "apply", Started: time.Now().UnixMilli(), StepBoot: bootTime(), Reenable: true}); err != nil {
		return "", err
	}
	if err := uwfmgr(ctx, "filter", "disable"); err != nil {
		clearKioskTask()
		return "", err
	}
	if err := kioskReboot(ctx, "OVERVNC: zapisywanie ustawień kiosku — restart 1 z 2."); err != nil {
		return "", err
	}
	return "Ochrona przed zapisem (UWF) jest włączona — kiosk uruchomi się dwa razy ponownie, żeby zapisać funkcje na stałe (ok. 3 minuty).", nil
}

// resumeProfileTask — kroki po restartach (wywoływane z resumeKioskTask, pod kioskMu).
func resumeProfileTask(ctx context.Context, t *KioskTask, st *WinStatus) {
	switch t.Step {
	case "apply":
		if st.UWF != nil && st.UWF.Enabled {
			clearKioskTask()
			saveKioskResult(t.Kind, false, "ochrona przed zapisem nadal jest włączona po restarcie — funkcje kiosku niezapisane")
			requestInventory()
			return
		}
		note, err := applyKioskSetupNow(ctx)
		ok, msg := err == nil, "funkcje kiosku zapisane na stałe"
		if err != nil {
			msg = "nie udało się zapisać funkcji kiosku: " + err.Error()
		} else if note != "" {
			msg += " — " + note
		}
		if t.Reenable {
			if err := uwfmgr(ctx, "filter", "enable"); err != nil && ok {
				ok, msg = false, "funkcje zapisane, ale nie udało się włączyć ochrony przed zapisem: "+err.Error()
			}
		}
		t.Step, t.StepBoot = "done", bootTime()
		_ = saveKioskTask(t)
		saveKioskResult(t.Kind, ok, msg)
		_ = kioskReboot(ctx, "OVERVNC: zapisywanie ustawień kiosku — restart 2 z 2.")
	case "done":
		clearKioskTask()
		requestInventory()
	}
}
