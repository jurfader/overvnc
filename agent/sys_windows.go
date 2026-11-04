//go:build windows

package main

import (
	"context"
	"slices"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// consoleUsers — użytkownicy aktywnych sesji (konsola i RDP). Działa, gdy agent pracuje jako SYSTEM.
func consoleUsers() []string {
	var sessions *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &sessions, &count); err != nil {
		return nil
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(sessions)))

	var out []string
	for _, s := range unsafe.Slice(sessions, count) {
		if s.State != windows.WTSActive {
			continue
		}
		var tok windows.Token
		if err := windows.WTSQueryUserToken(s.SessionID, &tok); err != nil {
			continue
		}
		tu, err := tok.GetTokenUser()
		if err == nil {
			if name, domain, _, err := tu.User.Sid.LookupAccount(""); err == nil {
				full := domain + `\` + name
				if !slices.Contains(out, full) {
					out = append(out, full)
				}
			}
		}
		tok.Close()
	}
	return out
}

// installedSoftware — programy z kluczy Uninstall w rejestrze (64- i 32-bitowe).
func installedSoftware(ctx context.Context) ([]Software, error) {
	paths := []string{
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
		`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
	}
	seen := map[string]bool{}
	var out []Software
	for _, p := range paths {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, p, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		names, _ := k.ReadSubKeyNames(-1)
		for _, n := range names {
			if ctx.Err() != nil {
				k.Close()
				return out, ctx.Err()
			}
			sk, err := registry.OpenKey(k, n, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			name, _, _ := sk.GetStringValue("DisplayName")
			sysComp, _, _ := sk.GetIntegerValue("SystemComponent")
			if name != "" && sysComp != 1 {
				ver, _, _ := sk.GetStringValue("DisplayVersion")
				pub, _, _ := sk.GetStringValue("Publisher")
				key := name + "|" + ver
				if !seen[key] {
					seen[key] = true
					out = append(out, Software{Name: name, Version: ver, Publisher: pub})
				}
			}
			sk.Close()
		}
		k.Close()
	}
	return out, nil
}
