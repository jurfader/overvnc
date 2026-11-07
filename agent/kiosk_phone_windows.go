package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Kiosk: otwieranie „Zdjęć z telefonu” po podłączeniu telefonu i konfiguracja trybu kiosku
// (aplikacja dozwolona w Assigned Access, kafelek w Start, adres lokalny dopuszczony w zasadach przeglądarki).

var (
	cfgmgr32                          = windows.NewLazySystemDLL("cfgmgr32.dll")
	procCMGetDeviceInterfaceListSizeW = cfgmgr32.NewProc("CM_Get_Device_Interface_List_SizeW")
	procCMGetDeviceInterfaceListW     = cfgmgr32.NewProc("CM_Get_Device_Interface_ListW")
	guidDevInterfaceWPD               = mustGUID("{6AC27878-A6FA-4155-BA85-F98F491D4F33}")
)

// wpdDevices — urządzenia przenośne (telefony, aparaty) podłączone teraz.
func wpdDevices() map[string]bool {
	var n uint32
	if r, _, _ := procCMGetDeviceInterfaceListSizeW.Call(uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(&guidDevInterfaceWPD)), 0, 0); r != 0 || n < 2 {
		return map[string]bool{}
	}
	buf := make([]uint16, n)
	if r, _, _ := procCMGetDeviceInterfaceListW.Call(uintptr(unsafe.Pointer(&guidDevInterfaceWPD)), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(n), 0); r != 0 {
		return map[string]bool{}
	}
	out := map[string]bool{}
	for start := 0; start < len(buf); {
		end := start
		for end < len(buf) && buf[end] != 0 {
			end++
		}
		if end == start {
			break
		}
		out[strings.ToLower(windows.UTF16ToString(buf[start:end]))] = true
		start = end + 1
	}
	return out
}

// runPhoneWatcher — co 2 s sprawdza podłączone telefony; nowy telefon = aplikacja na ekranie klienta.
// Telefon podłączony już przy starcie agenta nie otwiera aplikacji (dopiero kolejne podłączenie).
func runPhoneWatcher(ctx context.Context) {
	var known map[string]bool
	var app windows.Handle
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		p := currentProfile()
		if !p.Kiosk || !p.PhoneApp {
			known = nil
			continue
		}
		now := wpdDevices()
		if known == nil {
			known = now
			continue
		}
		added := false
		for id := range now {
			if !known[id] {
				added = true
			}
		}
		known = now
		if !added || processRunning(app) {
			continue
		}
		if app != 0 {
			windows.CloseHandle(app)
			app = 0
		}
		h, err := startAsConsoleUser("phone", "browser="+p.Browser)
		if err != nil {
			logger.Warningf("zdjęcia z telefonu: %v", err)
			continue
		}
		app = h
	}
}

func processRunning(h windows.Handle) bool {
	if h == 0 {
		return false
	}
	ev, _ := windows.WaitForSingleObject(h, 0)
	return ev == uint32(windows.WAIT_TIMEOUT)
}

// startAsConsoleUser — `overvnc-agent <args>` jako zalogowany użytkownik (klient kiosku), z jego pulpitem.
func startAsConsoleUser(args ...string) (windows.Handle, error) {
	sid, err := targetSession()
	if err != nil {
		return 0, err
	}
	var tok windows.Token
	if err := windows.WTSQueryUserToken(sid, &tok); err != nil {
		return 0, fmt.Errorf("nikt nie jest zalogowany: %w", err)
	}
	defer tok.Close()
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, tok, false); err != nil {
		return 0, err
	}
	defer windows.DestroyEnvironmentBlock(env)
	line := windows.EscapeArg(exe)
	for _, a := range args {
		line += " " + windows.EscapeArg(a)
	}
	cmd, _ := windows.UTF16PtrFromString(line)
	desk, _ := windows.UTF16PtrFromString(`winsta0\default`)
	si := windows.StartupInfo{Desktop: desk}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	syscall.ForkLock.Lock()
	err = windows.CreateProcessAsUser(tok, nil, cmd, nil, nil, false, windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT, env, nil, &si, &pi)
	syscall.ForkLock.Unlock()
	if err != nil {
		return 0, err
	}
	windows.CloseHandle(pi.Thread)
	return pi.Process, nil
}

// Konfiguracja trybu kiosku dla aplikacji (jako SYSTEM, jak skrypt kiosku: most WMI-MDM Assigned Access).
// Zwraca JSON: state = updated | unchanged | nokiosk, browser = przeglądarka dozwolona w kiosku.
const phoneSetupScript = `$ErrorActionPreference = 'Stop'
$exe = $env:OVERVNC_EXE; $enable = $env:OVERVNC_ENABLE -eq '1'
$lnk = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Zdjęcia z telefonu.lnk'
$aaNs = 'http://schemas.microsoft.com/AssignedAccess/2017/config'
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$o = Get-CimInstance -Namespace 'root\cimv2\mdm\dmmap' -ClassName MDM_AssignedAccess
$cfg = [string]$o.Configuration
$browser = $edge
$state = 'nokiosk'
if ($cfg) {
  $xml = [xml][System.Net.WebUtility]::HtmlDecode($cfg)
  $ns = New-Object System.Xml.XmlNamespaceManager $xml.NameTable
  $ns.AddNamespace('a', $aaNs); $ns.AddNamespace('v5', 'http://schemas.microsoft.com/AssignedAccess/2022/config')
  $apps = @($xml.SelectNodes('//a:AllowedApps/a:App', $ns) | ForEach-Object { [string]$_.DesktopAppPath })
  # przeglądarka już dozwolona w kiosku — nie otwieramy klientowi nowej
  if ($chrome -and ($apps | Where-Object { $_ -ieq $chrome })) { $browser = $chrome }
  elseif ($edge -and ($apps | Where-Object { $_ -ieq $edge })) { $browser = $edge }
  elseif ($chrome) { $browser = $chrome }
  $changed = $false
  foreach ($list in $xml.SelectNodes('//a:AllowedApps', $ns)) {
    $mine = @($list.SelectNodes('a:App', $ns) | Where-Object { $_.DesktopAppPath -ieq $exe })
    if ($enable -and -not $mine) { $e = $xml.CreateElement('App', $aaNs); $e.SetAttribute('DesktopAppPath', $exe); [void]$list.AppendChild($e); $changed = $true }
    if (-not $enable -and $mine) { $mine | ForEach-Object { [void]$list.RemoveChild($_) }; $changed = $true }
  }
  foreach ($pins in $xml.SelectNodes('//v5:StartPins', $ns)) {
    $j = $pins.InnerText | ConvertFrom-Json
    $list = @($j.pinnedList | Where-Object { $_.desktopAppLink -ine $lnk })
    if ($enable) { $list += [pscustomobject]@{ desktopAppLink = $lnk } }
    if ($list.Count -ne @($j.pinnedList).Count -or $enable -ne [bool]($j.pinnedList | Where-Object { $_.desktopAppLink -ieq $lnk })) {
      $j.pinnedList = $list
      $pins.RemoveAll(); [void]$pins.AppendChild($xml.CreateCDataSection(($j | ConvertTo-Json -Depth 6 -Compress)))
      $changed = $true
    }
  }
  if ($changed) { $o.Configuration = [System.Net.WebUtility]::HtmlEncode($xml.OuterXml); Set-CimInstance -CimInstance $o; $state = 'updated' } else { $state = 'unchanged' }
}
if ($enable) {
  $sh = New-Object -ComObject WScript.Shell; $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $exe; $s.Arguments = "phone browser=""$browser"""; $s.IconLocation = "$browser,0"; $s.Description = 'Zdjęcia z telefonu — kopiowanie i usuwanie zdjęć z telefonu'; $s.Save()
  # przeglądarka z listą zablokowanych adresów: dopuść aplikację (adres lokalny tego komputera)
  foreach ($pol in 'HKLM:\SOFTWARE\Policies\Google\Chrome', 'HKLM:\SOFTWARE\Policies\Microsoft\Edge') {
    if (Test-Path "$pol\URLBlocklist") {
      if (-not (Test-Path "$pol\URLAllowlist")) { New-Item "$pol\URLAllowlist" -Force | Out-Null }
      $vals = (Get-Item "$pol\URLAllowlist").Property | ForEach-Object { (Get-ItemProperty "$pol\URLAllowlist").$_ }
      if ($vals -notcontains 'http://127.0.0.1') {
        $n = 1; while ((Get-Item "$pol\URLAllowlist").Property -contains "$n") { $n++ }
        New-ItemProperty "$pol\URLAllowlist" -Name "$n" -Value 'http://127.0.0.1' -PropertyType String -Force | Out-Null
      }
    }
  }
} elseif (Test-Path $lnk) { Remove-Item $lnk -Force }
[pscustomobject]@{ state = $state; browser = [string]$browser } | ConvertTo-Json -Compress`

func setupPhoneApp(ctx context.Context, enable bool) (browser, note string, err error) {
	exe, err := os.Executable()
	if err != nil {
		return "", "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := runPowerShellCmd(ctx, phoneSetupScript)
	en := "0"
	if enable {
		en = "1"
	}
	cmd.Env = append(os.Environ(), "OVERVNC_EXE="+exe, "OVERVNC_ENABLE="+en)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", "", fmt.Errorf("%s", strings.TrimSpace(firstNonEmpty(string(out), err.Error())))
	}
	var r struct {
		State   string `json:"state"`
		Browser string `json:"browser"`
	}
	if json.Unmarshal(out, &r) != nil {
		return "", "", fmt.Errorf("nieoczekiwany wynik: %s", strings.TrimSpace(string(out)))
	}
	switch r.State {
	case "updated":
		note = "Tryb kiosku zaktualizowany — zmiana zadziała po ponownym zalogowaniu klienta (np. restart kiosku)."
	case "nokiosk":
		note = "Na tym komputerze nie ma trybu kiosku (Assigned Access) — aplikacja jest w menu Start."
	}
	if st := collectWinStatus(ctx); st != nil && st.UWF != nil && st.UWF.Enabled {
		note += " Uwaga: ochrona przed zapisem (UWF) jest włączona — zmiana zniknie po restarcie. Wyłącz UWF, włącz aplikację ponownie, potem włącz UWF."
	}
	return r.Browser, strings.TrimSpace(note), nil
}
