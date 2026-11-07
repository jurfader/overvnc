package main

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// Szybkie sprawdzenia (jedno wywołanie PowerShell, kilka sekund). Get-MpComputerStatus — Defender;
// SecurityCenter2 — wszystkie antywirusy znane Windows (na Windows Server klasy brak — pomijamy);
// BitLocker przez CIM (nie wymaga modułu BitLocker); restart wymagany — klucze rejestru obsługi i WU.
const securityScript = `$ErrorActionPreference = 'SilentlyContinue'
$mp = Get-MpComputerStatus
$fw = @(Get-NetFirewallProfile | ForEach-Object { @{ n = [string]$_.Name; e = ([string]$_.Enabled -ne 'False') } })
$bl = Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -Filter "DriveLetter='$env:SystemDrive'"
$av = @(Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct | ForEach-Object { @{ n = [string]$_.displayName; s = [int]$_.productState } })
$reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
$hf = Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1
[pscustomobject]@{
  mp = [bool]$mp; amOn = [bool]$mp.AMServiceEnabled; avOn = [bool]$mp.AntivirusEnabled; rtp = [bool]$mp.RealTimeProtectionEnabled
  tamper = [bool]$mp.IsTamperProtected; sigAge = $(if ($mp) { [int]$mp.AntivirusSignatureAge } else { -1 })
  sigAt = $(if ($mp -and $mp.AntivirusSignatureLastUpdated) { $mp.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('o') } else { '' })
  fw = $fw; bl = $(if ($bl) { [int]$bl.ProtectionStatus } else { -1 }); blConv = $(if ($bl) { [int]$bl.ConversionStatus } else { -1 })
  av = $av; reboot = [bool]$reboot; hotfix = $(if ($hf) { $hf.InstalledOn.ToUniversalTime().ToString('o') } else { '' })
} | ConvertTo-Json -Compress -Depth 4`

func collectSecurityFast(ctx context.Context) *Security {
	out, err := runPowerShell(ctx, securityScript)
	if err != nil && len(out) == 0 {
		return nil
	}
	var raw struct {
		MP     bool   `json:"mp"`
		AMOn   bool   `json:"amOn"`
		AVOn   bool   `json:"avOn"`
		RTP    bool   `json:"rtp"`
		Tamper bool   `json:"tamper"`
		SigAge int    `json:"sigAge"`
		SigAt  string `json:"sigAt"`
		FW     []struct {
			N string `json:"n"`
			E bool   `json:"e"`
		} `json:"fw"`
		BL     int `json:"bl"`
		BLConv int `json:"blConv"`
		AV     []struct {
			N string `json:"n"`
			S int    `json:"s"`
		} `json:"av"`
		Reboot bool   `json:"reboot"`
		Hotfix string `json:"hotfix"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return nil
	}
	s := &Security{}
	av := &AntivirusState{Defender: raw.MP, Enabled: raw.MP && raw.AMOn && raw.AVOn, RealTime: raw.RTP, TamperProtected: raw.Tamper, SignatureAgeDays: -1}
	if raw.MP {
		av.SignatureAgeDays = raw.SigAge
		if t, err := time.Parse(time.RFC3339, raw.SigAt); err == nil {
			av.SignatureUpdated = t.UnixMilli()
		}
	}
	for _, p := range raw.AV {
		// productState: bity 12–15 = stan (1 = włączony), bity 4–7 = sygnatury (0 = aktualne)
		av.Products = append(av.Products, AVProduct{Name: p.N, Enabled: (p.S>>12)&0xF == 1, UpToDate: (p.S>>4)&0xF == 0})
	}
	if raw.MP || len(av.Products) > 0 {
		s.Antivirus = av
	}
	if len(raw.FW) > 0 {
		fw := &FirewallState{Enabled: true}
		for _, p := range raw.FW {
			fw.Profiles = append(fw.Profiles, FirewallSet{Name: firewallProfileName(p.N), Enabled: p.E})
			fw.Enabled = fw.Enabled && p.E
		}
		s.Firewall = fw
	}
	// ProtectionStatus: 0 = wyłączona, 1 = włączona, 2 = nieznana; -1 = BitLocker niedostępny (np. Home)
	enc := &EncryptionInfo{Name: "BitLocker", Enabled: raw.BL == 1}
	switch {
	case raw.BL == -1:
		enc.Status = "niedostępny w tej edycji Windows"
	case raw.BL == 1:
		enc.Status = "dysk systemowy zaszyfrowany"
	case raw.BLConv == 2 || raw.BLConv == 3:
		enc.Status = "szyfrowanie w toku"
	default:
		enc.Status = "dysk systemowy niezaszyfrowany"
	}
	s.Encryption = enc
	s.Updates = &UpdatesState{RebootRequired: raw.Reboot}
	if t, err := time.Parse(time.RFC3339, raw.Hotfix); err == nil {
		s.Updates.LastInstalled = t.UnixMilli()
	}
	return s
}

func firewallProfileName(n string) string {
	switch strings.ToLower(n) {
	case "domain":
		return "domenowy"
	case "private":
		return "prywatny"
	case "public":
		return "publiczny"
	}
	return n
}

func updatesSupported() bool { return true }

// Wyszukiwanie aktualizacji przez usługę Windows Update (COM). Poprawki bezpieczeństwa i krytyczne
// rozpoznajemy po identyfikatorach kategorii (nazwy kategorii są tłumaczone).
const updatesScript = `$ErrorActionPreference = 'Stop'
$sess = New-Object -ComObject Microsoft.Update.Session
$res = $sess.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
$secIds = @('0fa1201d-4330-4fa8-8ae9-b877473b6441', 'e6cf1350-c01b-414d-a61f-263d14d133b4')
$list = @($res.Updates | ForEach-Object {
  $u = $_
  [pscustomobject]@{ t = [string]$u.Title; s = [bool](@($u.Categories | Where-Object { $secIds -contains ([string]$_.CategoryID).ToLower() }).Count) }
})
[pscustomobject]@{
  n = $list.Count; sec = @($list | Where-Object { $_.s }).Count
  titles = @($list | Select-Object -First 15 | ForEach-Object { $_.t })
  reboot = [bool](New-Object -ComObject Microsoft.Update.SystemInfo).RebootRequired
} | ConvertTo-Json -Compress`

func checkUpdates(ctx context.Context) *UpdatesState {
	out, err := runPowerShell(ctx, updatesScript)
	var raw struct {
		N      int      `json:"n"`
		Sec    int      `json:"sec"`
		Titles []string `json:"titles"`
		Reboot bool     `json:"reboot"`
	}
	if err != nil || json.Unmarshal(out, &raw) != nil {
		msg := strings.TrimSpace(string(out))
		if ctx.Err() != nil {
			msg = "przekroczony czas wyszukiwania aktualizacji"
		} else if msg == "" && err != nil {
			msg = err.Error()
		}
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return &UpdatesState{Error: msg}
	}
	return &UpdatesState{Pending: raw.N, Security: raw.Sec, Titles: raw.Titles, RebootRequired: raw.Reboot}
}
