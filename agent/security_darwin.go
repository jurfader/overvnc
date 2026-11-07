package main

import (
	"context"
	"os/exec"
	"strings"
)

// macOS: FileVault (fdesetup), zapora aplikacji (socketfilterfw), Gatekeeper (spctl), SIP (csrutil),
// aktualizacje (softwareupdate -l — łączy się z serwerami Apple, bywa wolne).

func cmdOut(ctx context.Context, name string, args ...string) string {
	out, _ := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return strings.TrimSpace(string(out))
}

func collectSecurityFast(ctx context.Context) *Security {
	s := &Security{}
	fv := cmdOut(ctx, "/usr/bin/fdesetup", "status")
	enc := &EncryptionInfo{Name: "FileVault", Enabled: strings.Contains(fv, "FileVault is On")}
	switch {
	case enc.Enabled:
		enc.Status = "dysk zaszyfrowany"
	case strings.Contains(fv, "Encryption in progress"):
		enc.Status = "szyfrowanie w toku"
	default:
		enc.Status = "dysk niezaszyfrowany"
	}
	s.Encryption = enc

	fw := cmdOut(ctx, "/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate")
	if fw != "" {
		on := strings.Contains(fw, "enabled") || strings.Contains(fw, "State = 1") || strings.Contains(fw, "State = 2")
		s.Firewall = &FirewallState{Enabled: on}
	}
	if gk := cmdOut(ctx, "/usr/sbin/spctl", "--status"); gk != "" {
		on := strings.Contains(gk, "assessments enabled")
		s.Gatekeeper = &on
	}
	if sip := cmdOut(ctx, "/usr/bin/csrutil", "status"); sip != "" {
		on := strings.Contains(sip, "status: enabled")
		s.SIP = &on
	}
	return s
}

func updatesSupported() bool { return true }

func checkUpdates(ctx context.Context) *UpdatesState {
	out, err := exec.CommandContext(ctx, "/usr/sbin/softwareupdate", "-l").CombinedOutput()
	if ctx.Err() != nil {
		return &UpdatesState{Error: "przekroczony czas wyszukiwania aktualizacji"}
	}
	u := parseSoftwareUpdate(string(out))
	if err != nil && u.Pending == 0 && !strings.Contains(string(out), "No new software available") {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		u.Error = msg
	}
	return u
}

// parseSoftwareUpdate — wynik `softwareupdate -l`:
//
//   - Label: macOS Sequoia 15.3-24D60
//     Title: macOS Sequoia 15.3, Version: 15.3, Size: 3G, Recommended: YES, Action: restart,
func parseSoftwareUpdate(out string) *UpdatesState {
	u := &UpdatesState{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "Title:") {
			continue
		}
		title := strings.TrimSpace(strings.TrimPrefix(strings.SplitN(line, ",", 2)[0], "Title:"))
		u.Pending++
		if strings.Contains(title, "macOS") || strings.Contains(title, "Security") || strings.Contains(title, "XProtect") {
			u.Security++
		}
		if strings.Contains(line, "Action: restart") {
			u.RebootRequired = true
		}
		if len(u.Titles) < 15 {
			u.Titles = append(u.Titles, title)
		}
	}
	return u
}
