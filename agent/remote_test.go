package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFrameRoundTrip(t *testing.T) {
	f := encodeFrame(frameData, 0xDEADBEEF, []byte("ls -la\n"))
	kind, ch, payload, err := decodeFrame(f)
	if err != nil || kind != frameData || ch != 0xDEADBEEF || string(payload) != "ls -la\n" {
		t.Fatalf("got %v %x %q %v", kind, ch, payload, err)
	}
	if _, _, _, err := decodeFrame([]byte{1, 2}); err == nil {
		t.Fatal("za krótka ramka musi dać błąd")
	}
}

func TestParseSystemctl(t *testing.T) {
	units := []byte(`ssh.service                 loaded    active   running OpenBSD Secure Shell server
● nginx.service             loaded    failed   failed  A high performance web server
cron.service                loaded    inactive dead    Regular background program processing daemon
ghost.service               not-found inactive dead    ghost.service
oneshot.service             loaded    active   exited  Something that ran once
`)
	files := []byte(`ssh.service      enabled  enabled
nginx.service    enabled  enabled
cron.service     disabled enabled
oneshot.service  static   -
bluetooth.service masked  enabled
getty@.service   enabled  enabled
`)
	got := map[string]ServiceInfo{}
	for _, s := range parseSystemctl(units, files) {
		got[s.Name] = s
	}
	check := func(name, status, start string) {
		t.Helper()
		s, ok := got[name]
		if !ok || s.Status != status || s.StartType != start {
			t.Errorf("%s: %+v (oczekiwano %s/%s)", name, s, status, start)
		}
	}
	check("ssh", "running", "auto")
	check("nginx", "failed", "auto")
	check("cron", "stopped", "manual")
	check("oneshot", "stopped", "static")
	check("bluetooth", "stopped", "disabled") // tylko w unit-files
	if _, ok := got["ghost"]; ok {
		t.Error("not-found nie powinno się pojawić")
	}
	if _, ok := got["getty@"]; ok {
		t.Error("szablon usługi nie powinien się pojawić")
	}
	if got["ssh"].DisplayName != "OpenBSD Secure Shell server" {
		t.Errorf("opis: %q", got["ssh"].DisplayName)
	}
}

func TestParseLaunchctl(t *testing.T) {
	out := []byte("PID\tStatus\tLabel\n123\t0\tcom.apple.sshd\n-\t0\tcom.example.idle\n-\t78\tcom.example.crashed\n-\t-9\tcom.example.killed\n")
	l := parseLaunchctl(out)
	if len(l) != 4 || l[0].Status != "running" || l[1].Status != "stopped" || l[2].Status != "failed" || l[3].Status != "stopped" {
		t.Fatalf("%+v", l)
	}
}

func TestOwnServiceProtected(t *testing.T) {
	for _, n := range []string{"overvnc-agent", "overvnc-agent.service", "com.overvnc.agent"} {
		if !isOwnService(n) {
			t.Errorf("%s powinno być chronione", n)
		}
	}
	if isOwnService("nginx") {
		t.Error("nginx nie jest usługą agenta")
	}
	raw, _ := json.Marshal(map[string]string{"name": "overvnc-agent", "action": "stop"})
	if _, err := handleSvcControl(context.Background(), raw); err == nil || !strings.Contains(err.Error(), "protected") {
		t.Errorf("zatrzymanie agenta musi być zablokowane: %v", err)
	}
	raw, _ = json.Marshal(map[string]string{"name": "x; rm -rf /", "action": "stop"})
	if _, err := handleSvcControl(context.Background(), raw); err == nil {
		t.Error("nazwa usługi z niedozwolonymi znakami musi być odrzucona")
	}
}

func TestSanitizeMessage(t *testing.T) {
	if got := sanitizeMessage("  Restart\no 18:00\x00 "); got != "Restart o 18:00" {
		t.Errorf("%q", got)
	}
	if got := sanitizeMessage(strings.Repeat("ż", 300)); len([]rune(got)) != 200 {
		t.Errorf("długość %d", len([]rune(got)))
	}
}

func TestPowerValidation(t *testing.T) {
	bad := []map[string]any{
		{"action": "selfdestruct"},
		{"action": "reboot", "delayMinutes": -1},
		{"action": "reboot", "delayMinutes": 100000},
	}
	for _, b := range bad {
		raw, _ := json.Marshal(b)
		if _, err := handlePower(context.Background(), raw); err == nil {
			t.Errorf("%v powinno być odrzucone", b)
		}
	}
}

func TestMagicPacket(t *testing.T) {
	mac, _ := net.ParseMAC("aa:bb:cc:dd:ee:ff")
	p := magicPacket(mac)
	if len(p) != 102 || !bytes.Equal(p[:6], bytes.Repeat([]byte{0xFF}, 6)) || !bytes.Equal(p[96:], mac) {
		t.Fatalf("zły pakiet: %x", p)
	}
}

func TestProcList(t *testing.T) {
	list, err := listProcesses(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range list {
		if int(p.PID) == os.Getpid() {
			found = true
		}
	}
	if !found || len(list) < 3 {
		t.Fatalf("brak bieżącego procesu na liście (%d procesów)", len(list))
	}
	raw, _ := json.Marshal(map[string]any{"pid": os.Getpid()})
	if _, err := handleProcKill(context.Background(), raw); err == nil {
		t.Error("agent nie może zakończyć samego siebie")
	}
}

func TestCapabilitiesIncludeRemote(t *testing.T) {
	caps := strings.Join(capabilities(), ",")
	for _, c := range []string{"term.open", "proc.list", "svc.list", "power.action", "power.reboot", "wol.send"} {
		if !strings.Contains(caps, c) {
			t.Errorf("brak %s w %s", c, caps)
		}
	}
}

// Test integracyjny: prawdziwa powłoka w PTY, wejście i wyjście ramkami jak przez WebSocket.
func TestTerminalSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("ConPTY testowany ręcznie na Windows")
	}
	var mu sync.Mutex
	var output bytes.Buffer
	closed := make(chan map[string]any, 1)
	sess := &sessionIO{
		writeBinary: func(b []byte) error {
			_, ch, payload, err := decodeFrame(b)
			if err != nil || ch != 7 {
				t.Errorf("zła ramka: ch=%d err=%v", ch, err)
			}
			mu.Lock()
			output.Write(payload)
			mu.Unlock()
			return nil
		},
		event: func(typ string, data any) error {
			if typ == "channel.closed" {
				closed <- data.(map[string]any)
			}
			return nil
		},
		channels: newChannelManager(),
	}
	ctx := withSession(context.Background(), sess)
	raw, _ := json.Marshal(termOpenReq{Channel: 7, Cols: 100, Rows: 30, Shell: "sh"})
	res, err := handleTermOpen(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["shell"] != "sh" {
		t.Fatalf("%v", res)
	}

	// drugi kanał o tym samym numerze — odrzucony
	if _, err := handleTermOpen(ctx, raw); err == nil {
		t.Error("duplikat kanału powinien być odrzucony")
	}

	sess.channels.handleFrame(encodeFrame(frameData, 7, []byte("echo OVERVNC_$((40+2))\n")))
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		got := output.String()
		mu.Unlock()
		if strings.Contains(got, "OVERVNC_42") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("brak wyniku polecenia, wyjście: %q", got)
		}
		time.Sleep(20 * time.Millisecond)
	}

	rz, _ := json.Marshal(map[string]any{"channel": 7, "cols": 120, "rows": 40})
	if _, err := handleTermResize(ctx, rz); err != nil {
		t.Errorf("resize: %v", err)
	}

	sess.channels.handleFrame(encodeFrame(frameData, 7, []byte("exit 3\n")))
	select {
	case ev := <-closed:
		if ev["exitCode"] != 3 {
			t.Errorf("kod wyjścia: %v", ev["exitCode"])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("brak zdarzenia channel.closed")
	}
	if sess.channels.get(7) != nil {
		t.Error("kanał powinien zostać usunięty po zakończeniu powłoki")
	}
}
