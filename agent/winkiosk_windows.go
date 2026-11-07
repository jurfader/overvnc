//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/host"
	"golang.org/x/sys/windows/registry"
)

// Jedno zapytanie CIM — niezależne od języka systemu (w przeciwieństwie do tekstów slmgr).
const winStatusScript = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$p = Get-CimInstance SoftwareLicensingProduct -Filter "ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL" | Select-Object -First 1
$s = Get-CimInstance SoftwareLicensingService
$f = Get-CimInstance -Namespace root\standardcimv2\embedded -ClassName UWF_Filter | Select-Object -First 1
$o = Get-CimInstance -Namespace root\standardcimv2\embedded -ClassName UWF_Overlay | Select-Object -First 1
$ex = $false
$v = Get-CimInstance -Namespace root\standardcimv2\embedded -ClassName UWF_Volume | Where-Object { $_.CurrentSession -and $_.DriveLetter -eq $env:SystemDrive } | Select-Object -First 1
if ($v) {
  $r = Invoke-CimMethod -InputObject $v -MethodName GetExclusions
  $ex = [bool]($r.ExcludedFiles | Where-Object { $_.FileName -like '*ProgramData\OVERVNC*' })
}
if ($f -and -not $ex) {
  $t = (& "$env:SystemRoot\System32\uwfmgr.exe" file get-exclusions | Out-String) -replace "` + "`" + `0", ''
  $ex = $t -match 'ProgramData\\OVERVNC'
}
$end = $null
if ($p.EvaluationEndDate -and $p.EvaluationEndDate.Year -gt 2000) { $end = $p.EvaluationEndDate.ToUniversalTime().ToString('o') }
[pscustomobject]@{
  licName = [string]$p.Name; licDesc = [string]$p.Description; licStatus = [int]$p.LicenseStatus
  graceMin = [int64]$p.GracePeriodRemaining; evalEnd = $end; rearms = [int]$s.RemainingWindowsReArmCount
  uwf = [bool]$f; uwfNow = [bool]$f.CurrentEnabled; uwfNext = [bool]$f.NextEnabled
  ovUsed = [int64]$o.OverlayConsumption; ovFree = [int64]$o.AvailableSpace; excluded = [bool]$ex
} | ConvertTo-Json -Compress
`

func powershellExe() string {
	return filepath.Join(os.Getenv("SystemRoot"), `System32\WindowsPowerShell\v1.0\powershell.exe`)
}

func runPowerShell(ctx context.Context, script string) ([]byte, error) {
	return runPowerShellCmd(ctx, script).CombinedOutput()
}

func runPowerShellCmd(ctx context.Context, script string) *exec.Cmd {
	return exec.CommandContext(ctx, powershellExe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
}

func editionIsEval() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	ed, _, _ := k.GetStringValue("EditionID")
	return strings.HasSuffix(strings.ToLower(ed), "eval")
}

func collectWinStatus(ctx context.Context) *WinStatus {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	st := &WinStatus{Task: loadKioskTask(), LastTask: loadKioskResult()}
	out, err := runPowerShell(ctx, winStatusScript)
	if err != nil {
		return st
	}
	var raw struct {
		LicName   string `json:"licName"`
		LicDesc   string `json:"licDesc"`
		LicStatus int    `json:"licStatus"`
		GraceMin  int64  `json:"graceMin"`
		EvalEnd   string `json:"evalEnd"`
		Rearms    int    `json:"rearms"`
		UWF       bool   `json:"uwf"`
		UWFNow    bool   `json:"uwfNow"`
		UWFNext   bool   `json:"uwfNext"`
		OvUsed    int64  `json:"ovUsed"`
		OvFree    int64  `json:"ovFree"`
		Excluded  bool   `json:"excluded"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return st
	}
	if raw.LicName != "" {
		lic := &WinLicense{
			Name: raw.LicName, Description: raw.LicDesc, Status: raw.LicStatus, GraceMinutes: raw.GraceMin, RearmsLeft: raw.Rearms,
			Evaluation: strings.Contains(strings.ToUpper(raw.LicDesc), "EVAL") || editionIsEval(),
		}
		if t, err := time.Parse(time.RFC3339, raw.EvalEnd); err == nil {
			lic.EvalEnd = t.UnixMilli()
		}
		st.License = lic
	}
	if raw.UWF {
		st.UWF = &UWFStatus{Installed: true, Enabled: raw.UWFNow, NextEnabled: raw.UWFNext, OverlayUsedMB: raw.OvUsed, OverlayFreeMB: raw.OvFree, AgentExcluded: raw.Excluded}
	}
	return st
}

func uwfmgr(ctx context.Context, args ...string) error {
	out, err := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), `System32\uwfmgr.exe`), args...).CombinedOutput()
	if err != nil {
		return protoErr("uwf_failed", "uwfmgr %s: %s", strings.Join(args, " "), strings.TrimSpace(firstNonEmpty(string(out), err.Error())))
	}
	return nil
}

func kioskReboot(ctx context.Context, msg string) error {
	return shutdownExe(ctx, "/r", "/t", "15", "/d", "p:0:0", "/c", msg)
}

// rearmWindows — przedłużenie okresu próbnego (SoftwareLicensingService.ReArmWindows, kod 0 = sukces).
func rearmWindows(ctx context.Context) error {
	out, err := runPowerShell(ctx, `$r = Invoke-CimMethod -InputObject (Get-CimInstance SoftwareLicensingService) -MethodName ReArmWindows; exit [int]$r.ReturnValue`)
	if err != nil {
		code := -1
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
		return fmt.Errorf("ReArmWindows: kod %#x %s", uint32(code), strings.TrimSpace(string(out)))
	}
	return nil
}

func bootTime() uint64 {
	t, _ := host.BootTime()
	return t
}

func handleKioskAction(ctx context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		Action string `json:"action"`
	}](data)
	if err != nil {
		return nil, protoErr("bad_request", "nieprawidłowe żądanie")
	}
	kioskMu.Lock()
	defer kioskMu.Unlock()
	if t := loadKioskTask(); t != nil && time.Since(time.UnixMilli(t.Started)) < kioskTaskMaxAge {
		return nil, protoErr("busy", "trwa inne zadanie (%s) — poczekaj na jego zakończenie", t.Kind)
	}
	st := collectWinStatus(ctx)
	switch req.Action {
	case "service-on":
		if st.UWF == nil {
			return nil, protoErr("no_uwf", "ochrona przed zapisem (UWF) nie jest zainstalowana")
		}
		if err := uwfmgr(ctx, "filter", "disable"); err != nil {
			return nil, err
		}
		return map[string]any{"status": "restarting"}, kioskReboot(ctx, "OVERVNC: tryb serwisowy — ochrona przed zapisem zostanie wyłączona po restarcie.")
	case "service-off":
		if st.UWF == nil {
			return nil, protoErr("no_uwf", "ochrona przed zapisem (UWF) nie jest zainstalowana")
		}
		if err := uwfmgr(ctx, "filter", "enable"); err != nil {
			return nil, err
		}
		return map[string]any{"status": "restarting"}, kioskReboot(ctx, "OVERVNC: ochrona przed zapisem zostanie włączona po restarcie.")
	case "extend":
		return startExtend(ctx, st)
	}
	return nil, protoErr("bad_request", "nieznana akcja %q", req.Action)
}

func startExtend(ctx context.Context, st *WinStatus) (any, error) {
	lic := st.License
	if lic == nil || !lic.Evaluation {
		// przedłużenie na aktywowanym systemie mogłoby naruszyć aktywację
		return nil, protoErr("not_evaluation", "to nie jest wersja ewaluacyjna Windows — przedłużanie jest wyłączone")
	}
	if lic.RearmsLeft <= 0 {
		return nil, protoErr("no_rearms", "limit przedłużeń wyczerpany — pozostaje ponowna instalacja systemu")
	}
	now := time.Now().UnixMilli()
	if st.UWF != nil && st.UWF.Enabled {
		if !st.UWF.AgentExcluded {
			return nil, protoErr("not_excluded", "folder C:\\ProgramData\\OVERVNC nie jest wykluczony z ochrony przed zapisem — stan zadania nie przetrwałby restartu. Zaktualizuj konfigurację kiosku albo najpierw włącz tryb serwisowy.")
		}
		// krok 1/2: wyłącz ochronę i uruchom ponownie; przedłużenie wykona się po restarcie
		if err := saveKioskTask(&KioskTask{Kind: "extend", Step: "rearm", Started: now, StepBoot: bootTime(), Reenable: true, GraceBefore: lic.GraceMinutes}); err != nil {
			return nil, protoErr("state", "zapis stanu zadania: %v", err)
		}
		if err := uwfmgr(ctx, "filter", "disable"); err != nil {
			clearKioskTask()
			return nil, err
		}
		return map[string]any{"status": "restarting", "restarts": 2}, kioskReboot(ctx, "OVERVNC: przedłużanie okresu próbnego Windows — restart 1 z 2.")
	}
	// ochrona wyłączona (tryb serwisowy) albo brak UWF — przedłużenie od razu, potem restart
	if err := rearmWindows(ctx); err != nil {
		return nil, protoErr("rearm_failed", "przedłużenie nie powiodło się: %v", err)
	}
	if err := saveKioskTask(&KioskTask{Kind: "extend", Step: "verify", Started: now, StepBoot: bootTime(), GraceBefore: lic.GraceMinutes}); err != nil {
		return nil, protoErr("state", "zapis stanu zadania: %v", err)
	}
	return map[string]any{"status": "restarting", "restarts": 1}, kioskReboot(ctx, "OVERVNC: przedłużono okres próbny Windows — restart.")
}

// resumeKioskTask — po starcie agenta: kontynuacja zadania przerwanego restartem.
func resumeKioskTask(ctx context.Context) {
	kioskMu.Lock()
	defer kioskMu.Unlock()
	t := loadKioskTask()
	if t == nil {
		return
	}
	if time.Since(time.UnixMilli(t.Started)) > kioskTaskMaxAge {
		clearKioskTask()
		saveKioskResult(t.Kind, false, "zadanie przerwane — trwało zbyt długo")
		requestInventory()
		return
	}
	// krok czeka na restart systemu — poza „rearming” (agent zrestartował się w trakcie przedłużania)
	if t.Step != "rearming" && bootTime() <= t.StepBoot {
		return
	}
	// po restarcie usługi systemowe (WMI, licencjonowanie) potrzebują chwili
	var st *WinStatus
	for range 12 {
		st = collectWinStatus(ctx)
		if st.License != nil {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
	switch t.Step {
	case "rearm", "rearming":
		if st.UWF != nil && st.UWF.Enabled {
			clearKioskTask()
			saveKioskResult(t.Kind, false, "ochrona przed zapisem nadal jest włączona po restarcie — przedłużenie przerwane")
			requestInventory()
			return
		}
		ok := true
		msg := ""
		if t.Step == "rearm" {
			// najpierw zapis „w trakcie” — gdyby agent zrestartował się w tej chwili, nie przedłużymy drugi raz
			t.Step, t.StepBoot = "rearming", bootTime()
			_ = saveKioskTask(t)
			if err := rearmWindows(ctx); err != nil {
				ok, msg = false, err.Error()
			}
		}
		if t.Reenable {
			if err := uwfmgr(ctx, "filter", "enable"); err != nil && ok {
				ok, msg = false, "przedłużono, ale nie udało się włączyć ochrony przed zapisem: "+err.Error()
			}
		}
		if !ok {
			clearKioskTask()
			saveKioskResult(t.Kind, false, msg)
			if t.Reenable {
				_ = kioskReboot(ctx, "OVERVNC: przywracanie ochrony przed zapisem.")
			}
			requestInventory()
			return
		}
		t.Step, t.StepBoot = "verify", bootTime()
		_ = saveKioskTask(t)
		_ = kioskReboot(ctx, "OVERVNC: przedłużanie okresu próbnego Windows — restart 2 z 2.")
	case "verify":
		clearKioskTask()
		if st.License == nil {
			saveKioskResult(t.Kind, false, "nie udało się odczytać licencji po przedłużeniu")
		} else if st.License.GraceMinutes > t.GraceBefore+24*60 {
			saveKioskResult(t.Kind, true, fmt.Sprintf("okres próbny przedłużony: zostało %d dni, pozostałe przedłużenia: %d", st.License.GraceMinutes/1440, st.License.RearmsLeft))
		} else {
			saveKioskResult(t.Kind, false, fmt.Sprintf("liczba dni nie wzrosła (%d dni) — przedłużenie mogło się nie udać", st.License.GraceMinutes/1440))
		}
		requestInventory()
	}
}

func init() {
	handlers["kiosk.action"] = handleKioskAction
}
