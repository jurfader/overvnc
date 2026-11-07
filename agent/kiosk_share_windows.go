package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Udział sieciowy „Pobrane” na kiosku: pracownicy (konto „pracownik”) przeglądają z innych komputerów
// pliki klienta — tylko odczyt albo odczyt i usuwanie. Dostęp tylko z sieci lokalnej (albo z podanych
// adresów) — własna reguła zapory, niezależna od profilu sieci (działa też przy sieci „publicznej”).
// Istniejący udział „Pobrane” i konto „pracownik” (zakładane wcześniej ręcznie) są przejmowane.

const shareScript = `$ErrorActionPreference = 'Stop'
$mode = $env:OVERVNC_SHARE_MODE; $allow = $env:OVERVNC_SHARE_ALLOW; $pass = $env:OVERVNC_SHARE_PASS
$user = 'pracownik'; $share = 'Pobrane'; $rule = 'OVERVNC - udzial Pobrane'
# konto klienta kiosku: z konfiguracji trybu kiosku (Assigned Access), inaczej „Klient”
$acct = 'Klient'
try {
  $o = Get-CimInstance -Namespace 'root\cimv2\mdm\dmmap' -ClassName MDM_AssignedAccess
  if ($o.Configuration) {
    $x = [xml][System.Net.WebUtility]::HtmlDecode($o.Configuration)
    $a = $x.GetElementsByTagName('Account') | Select-Object -First 1
    if ($a -and $a.InnerText) { $acct = $a.InnerText.Split('\')[-1] }
  }
} catch {}
$prof = (Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -and (Split-Path $_.LocalPath -Leaf) -ieq $acct } | Select-Object -First 1).LocalPath
if (-not $prof) { $prof = Join-Path $env:SystemDrive "Users\$acct" }
$folder = Join-Path $prof 'Downloads'

if ($pass) {
  $sec = ConvertTo-SecureString $pass -AsPlainText -Force
  if (Get-LocalUser -Name $user -ErrorAction SilentlyContinue) { Set-LocalUser -Name $user -Password $sec -PasswordNeverExpires $true }
  else { New-LocalUser -Name $user -Password $sec -PasswordNeverExpires -UserMayNotChangePassword -Description 'OVERVNC: udział Pobrane kiosku' | Out-Null }
  Enable-LocalUser -Name $user
}

if ($mode -eq 'read' -or $mode -eq 'delete') {
  if (-not (Test-Path $folder)) { throw "Brak folderu $folder (konto kiosku: $acct)" }
  if (-not (Get-LocalUser -Name $user -ErrorAction SilentlyContinue)) {
    # bez hasła konto nie zaloguje się przez sieć — dostęp ruszy po ustawieniu hasła w panelu
    New-LocalUser -Name $user -NoPassword -Description 'OVERVNC: udział Pobrane kiosku' | Out-Null
    Disable-LocalUser -Name $user
  }
  # NTFS: odczyt; przy „delete” także usuwanie plików i podfolderów (bez samego folderu Pobrane)
  & icacls.exe $folder /remove:g $user /T /C /Q | Out-Null
  & icacls.exe $folder /grant "$($user):(OI)(CI)RX" /Q | Out-Null
  if ($mode -eq 'delete') { & icacls.exe $folder /grant "$($user):(OI)(CI)(IO)D" /Q | Out-Null }
  $s = Get-SmbShare -Name $share -ErrorAction SilentlyContinue
  if ($s -and $s.Path -ine $folder) { Remove-SmbShare -Name $share -Force; $s = $null }
  if (-not $s) { New-SmbShare -Name $share -Path $folder -Description 'OVERVNC: Pobrane klienta kiosku' -ReadAccess $user | Out-Null }
  $right = if ($mode -eq 'delete') { 'Change' } else { 'Read' }
  Grant-SmbShareAccess -Name $share -AccountName $user -AccessRight $right -Force | Out-Null
  Get-SmbShareAccess -Name $share | Where-Object { $_.AccountName -notmatch "\\$user$" } | ForEach-Object {
    Revoke-SmbShareAccess -Name $share -AccountName $_.AccountName -Force | Out-Null
  }
  Set-Service -Name LanmanServer -StartupType Automatic
  Start-Service -Name LanmanServer
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $remote = if ($allow) { @($allow -split '[,\s]+' | Where-Object { $_ }) } else { 'LocalSubnet' }
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort 445 -RemoteAddress $remote -Profile Any -Action Allow | Out-Null
} else {
  if (Get-SmbShare -Name $share -ErrorAction SilentlyContinue) { Remove-SmbShare -Name $share -Force }
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if (Test-Path $folder) { & icacls.exe $folder /remove:g $user /T /C /Q | Out-Null }
  if (Get-LocalUser -Name $user -ErrorAction SilentlyContinue) { Disable-LocalUser -Name $user }
}
'ok'`

func setupShare(ctx context.Context, mode, allow string) error {
	pass, _ := loadSharePassword()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := runPowerShellCmd(ctx, shareScript)
	cmd.Env = append(os.Environ(), "OVERVNC_SHARE_MODE="+mode, "OVERVNC_SHARE_ALLOW="+allow, "OVERVNC_SHARE_PASS="+pass)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return errors.New(strings.TrimSpace(firstNonEmpty(string(out), err.Error())))
	}
	clearSharePassword()
	return nil
}

// ---------- hasło: DPAPI (klucz komputera), plik w folderze agenta (wykluczony z UWF) ----------

const cryptProtectLocalMachine = 0x4

func sharePassFile() string { return kioskFile("share-pass.bin") }

func pendingSharePassword() bool { return fileExists(sharePassFile()) }

func storeSharePassword(p string) error {
	in := windows.DataBlob{Size: uint32(len(p)), Data: unsafe.SliceData([]byte(p))}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, cryptProtectLocalMachine, &out); err != nil {
		return fmt.Errorf("szyfrowanie hasła: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return writeFileSync(sharePassFile(), append([]byte(nil), unsafe.Slice(out.Data, out.Size)...))
}

func loadSharePassword() (string, error) {
	b, err := os.ReadFile(sharePassFile())
	if err != nil || len(b) == 0 {
		return "", err
	}
	in := windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, 0, &out); err != nil {
		return "", err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return string(unsafe.Slice(out.Data, out.Size)), nil
}

func clearSharePassword() { _ = os.Remove(sharePassFile()) }

// ---------- stan do panelu ----------

type ShareStatus struct {
	Mode        string   `json:"mode"` // read | delete | "" (brak udziału)
	Folder      string   `json:"folder,omitempty"`
	User        bool     `json:"user"`        // konto „pracownik” istnieje
	UserEnabled bool     `json:"userEnabled"` // i jest włączone (ma hasło)
	Allow       string   `json:"allow,omitempty"`
	Addresses   []string `json:"addresses,omitempty"` // adresy IPv4 kiosku w sieci lokalnej
	Computer    string   `json:"computer"`
}

const shareStatusScript = `$ErrorActionPreference = 'SilentlyContinue'
$s = Get-SmbShare -Name 'Pobrane'
$acc = Get-SmbShareAccess -Name 'Pobrane' | Where-Object { $_.AccountName -match '\\pracownik$' } | Select-Object -First 1
$u = Get-LocalUser -Name 'pracownik'
$r = Get-NetFirewallRule -DisplayName 'OVERVNC - udzial Pobrane'
$allow = if ($r) { (($r | Get-NetFirewallAddressFilter).RemoteAddress | Where-Object { $_ -ne 'LocalSubnet' }) -join ', ' } else { '' }
$ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress })
[pscustomobject]@{
  mode = $(if ($s -and $acc) { if ([string]$acc.AccessRight -eq 'Change' -or [string]$acc.AccessRight -eq 'Full') { 'delete' } else { 'read' } } else { '' })
  folder = [string]$s.Path; user = [bool]$u; userEnabled = [bool]$u.Enabled; allow = $allow; addresses = $ips; computer = $env:COMPUTERNAME
} | ConvertTo-Json -Compress`

func collectShareStatus(ctx context.Context) *ShareStatus {
	out, err := runPowerShell(ctx, shareStatusScript)
	if err != nil && len(out) == 0 {
		return nil
	}
	var st ShareStatus
	if json.Unmarshal(out, &st) != nil {
		return nil
	}
	return &st
}
