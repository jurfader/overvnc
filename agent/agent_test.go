package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shirou/gopsutil/v4/disk"
)

func TestCheckServerURL(t *testing.T) {
	cases := []struct {
		url      string
		insecure bool
		ok       bool
	}{
		{"https://vnc.example.com", false, true},
		{"https://vnc.example.com/", false, true},
		{"http://localhost:8080", false, true},
		{"http://127.0.0.1:8080", false, true},
		{"http://[::1]:8080", false, true},
		{"http://192.168.1.10:8080", false, false}, // LAN bez TLS tylko z --insecure
		{"http://192.168.1.10:8080", true, true},
		{"http://vnc.example.com", false, false},
		{"ftp://vnc.example.com", true, false},
		{"vnc.example.com", false, false},
		{"", false, false},
	}
	for _, c := range cases {
		_, err := checkServerURL(c.url, c.insecure)
		if (err == nil) != c.ok {
			t.Errorf("checkServerURL(%q, insecure=%v): err=%v, oczekiwano ok=%v", c.url, c.insecure, err, c.ok)
		}
	}
}

func TestWsURL(t *testing.T) {
	cases := map[string]string{
		"https://vnc.example.com":          "wss://vnc.example.com/ws/agent",
		"https://example.com/overvnc/":     "wss://example.com/overvnc/ws/agent",
		"http://localhost:8080":            "ws://localhost:8080/ws/agent",
		"https://vnc.example.com:8443/sub": "wss://vnc.example.com:8443/sub/ws/agent",
	}
	for in, want := range cases {
		if got := wsURL(&Config{ServerURL: in}); got != want {
			t.Errorf("wsURL(%q) = %q, oczekiwano %q", in, got, want)
		}
	}
}

func TestConfigRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "agent.json")
	in := &Config{ServerURL: "https://vnc.example.com", AgentID: "00000000-0000-0000-0000-000000000000", AgentSecret: "s3cret"}
	if err := saveConfig(path, in); err != nil {
		t.Fatal(err)
	}
	out, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if *out != *in {
		t.Fatalf("odczytano %+v, zapisano %+v", out, in)
	}
}

func TestLoadConfigRejectsInsecureRemote(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.json")
	_ = saveConfig(path, &Config{ServerURL: "http://evil.example.com", AgentID: "a", AgentSecret: "b"})
	if _, err := loadConfig(path); err == nil {
		t.Fatal("konfiguracja z http:// na zdalny host bez allow_insecure musi być odrzucona")
	}
}

func TestParsePackages(t *testing.T) {
	dpkg := parsePackages("dpkg-query", []byte("bash\t5.2-1\tUbuntu Devs\ncurl\t8.5.0\t(none)\n\n"))
	if len(dpkg) != 2 || dpkg[0] != (Software{"bash", "5.2-1", "Ubuntu Devs"}) || dpkg[1].Publisher != "" {
		t.Errorf("dpkg: %+v", dpkg)
	}
	pac := parsePackages("pacman", []byte("linux 6.9.1.arch1-1\nvim 9.1.0-1\n"))
	if len(pac) != 2 || pac[0] != (Software{Name: "linux", Version: "6.9.1.arch1-1"}) {
		t.Errorf("pacman: %+v", pac)
	}
	apk := parsePackages("apk", []byte("musl-1.2.5-r0\nca-certificates-bundle-20240705-r0\n"))
	if len(apk) != 2 || apk[0] != (Software{Name: "musl", Version: "1.2.5-r0"}) || apk[1].Name != "ca-certificates-bundle" {
		t.Errorf("apk: %+v", apk)
	}
}

func TestHasRoutableAddr(t *testing.T) {
	ipnet := func(s string) net.Addr {
		_, n, _ := net.ParseCIDR(s)
		ip, _, _ := net.ParseCIDR(s)
		n.IP = ip
		return n
	}
	if hasRoutableAddr([]net.Addr{ipnet("fe80::1/64")}) {
		t.Error("sam link-local nie powinien się liczyć")
	}
	if !hasRoutableAddr([]net.Addr{ipnet("fe80::1/64"), ipnet("192.168.1.5/24")}) {
		t.Error("adres LAN powinien się liczyć")
	}
	if !hasRoutableAddr([]net.Addr{ipnet("100.89.1.2/32")}) {
		t.Error("adres Tailscale (CGNAT) powinien się liczyć")
	}
}

func TestDarwinUserVolume(t *testing.T) {
	cases := []struct {
		p    disk.PartitionStat
		want bool
	}{
		{disk.PartitionStat{Mountpoint: "/"}, true},
		{disk.PartitionStat{Mountpoint: "/System/Volumes/Data"}, false},
		{disk.PartitionStat{Mountpoint: "/Volumes/Recovery"}, false},
		{disk.PartitionStat{Mountpoint: "/Volumes/Backup", Opts: []string{"rw", "local"}}, true},
		{disk.PartitionStat{Mountpoint: "/Volumes/Installer", Opts: []string{"ro", "local"}}, false},
		{disk.PartitionStat{Mountpoint: "/Library/Developer/CoreSimulator/Volumes/iOS"}, false},
	}
	for _, c := range cases {
		if got := darwinUserVolume(c.p); got != c.want {
			t.Errorf("darwinUserVolume(%s) = %v, oczekiwano %v", c.p.Mountpoint, got, c.want)
		}
	}
}

func TestHandleRequest(t *testing.T) {
	orig := handlers
	t.Cleanup(func() { handlers = orig })
	handlers = map[string]handlerFunc{
		"echo":  func(_ context.Context, d json.RawMessage) (any, error) { return json.RawMessage(d), nil },
		"fail":  func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("nie wyszło") },
		"typed": func(context.Context, json.RawMessage) (any, error) { return nil, protoErr("denied", "brak zgody") },
		"panic": func(context.Context, json.RawMessage) (any, error) { panic("ups") },
	}
	ctx := context.Background()

	r := handleRequest(ctx, Envelope{Type: "echo", ID: "1", Data: json.RawMessage(`{"a":1}`)})
	if r.Type != "result" || r.ID != "1" || string(r.Data) != `{"a":1}` {
		t.Errorf("echo: %+v", r)
	}
	r = handleRequest(ctx, Envelope{Type: "fail", ID: "2"})
	if r.Type != "error" || r.Error.Code != "failed" || r.Error.Message != "nie wyszło" {
		t.Errorf("fail: %+v", r)
	}
	r = handleRequest(ctx, Envelope{Type: "typed", ID: "3"})
	if r.Error == nil || r.Error.Code != "denied" {
		t.Errorf("typed: %+v", r)
	}
	r = handleRequest(ctx, Envelope{Type: "panic", ID: "4"})
	if r.Type != "error" || r.Error.Code != "panic" || r.ID != "4" {
		t.Errorf("panic: %+v", r)
	}
	r = handleRequest(ctx, Envelope{Type: "nope", ID: "5"})
	if r.Error == nil || r.Error.Code != "unknown_command" {
		t.Errorf("unknown: %+v", r)
	}
}

func TestCapabilitiesSorted(t *testing.T) {
	caps := capabilities()
	if len(caps) == 0 || !strings.Contains(strings.Join(caps, ","), "inventory.refresh") {
		t.Errorf("capabilities: %v", caps)
	}
}
