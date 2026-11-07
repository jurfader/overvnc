//go:build darwin

package main

import (
	"context"
	"os"
	"testing"
)

func TestParseSoftwareUpdate(t *testing.T) {
	out := `Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: macOS Sequoia 15.3-24D60
	Title: macOS Sequoia 15.3, Version: 15.3, Size: 3215648KiB, Recommended: YES, Action: restart,
* Label: Safari18.3-18.3
	Title: Safari, Version: 18.3, Size: 210000KiB, Recommended: YES,
`
	u := parseSoftwareUpdate(out)
	if u.Pending != 2 || u.Security != 1 || !u.RebootRequired || u.Titles[0] != "macOS Sequoia 15.3" || u.Titles[1] != "Safari" {
		t.Fatalf("%+v", u)
	}
	if u := parseSoftwareUpdate("No new software available."); u.Pending != 0 || u.RebootRequired {
		t.Fatalf("%+v", u)
	}
}

// Prawdziwe sprawdzenia na tym Macu (OVERVNC_MAC_SMOKE=1).
func TestMacSecuritySmoke(t *testing.T) {
	if os.Getenv("OVERVNC_MAC_SMOKE") != "1" {
		t.Skip("tylko ręcznie: OVERVNC_MAC_SMOKE=1")
	}
	s := collectSecurityFast(context.Background())
	if s == nil || s.Encryption == nil || s.Firewall == nil || s.Gatekeeper == nil || s.SIP == nil {
		t.Fatalf("niepełny stan: %+v", s)
	}
	t.Logf("FileVault=%v (%s) zapora=%v Gatekeeper=%v SIP=%v", s.Encryption.Enabled, s.Encryption.Status, s.Firewall.Enabled, *s.Gatekeeper, *s.SIP)
}
