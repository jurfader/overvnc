package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ServiceInfo — usługa systemowa w ujednoliconej postaci dla wszystkich systemów.
type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`    // running | stopped | starting | stopping | failed | other
	StartType   string `json:"startType"` // auto | manual | disabled | static | ""
	Description string `json:"description,omitempty"`
}

var serviceNameRe = regexp.MustCompile(`^[A-Za-z0-9_.@:\-]{1,200}$`)

// isOwnService — agenta nie wolno zatrzymać zdalnie (odcięlibyśmy sobie dostęp).
func isOwnService(name string) bool {
	n := strings.ToLower(strings.TrimSuffix(name, ".service"))
	return n == serviceName || strings.Contains(n, "overvnc")
}

func handleSvcList(ctx context.Context, _ json.RawMessage) (any, error) {
	list, err := listServices(ctx)
	if err != nil {
		return nil, protoErr("svc_list", "nie można pobrać listy usług: %v", err)
	}
	sort.Slice(list, func(i, j int) bool {
		return strings.ToLower(list[i].DisplayName) < strings.ToLower(list[j].DisplayName)
	})
	return list, nil
}

func handleSvcControl(ctx context.Context, data json.RawMessage) (any, error) {
	var req struct {
		Name   string `json:"name"`
		Action string `json:"action"`
	}
	if err := json.Unmarshal(data, &req); err != nil || !serviceNameRe.MatchString(req.Name) {
		return nil, protoErr("bad_request", "nieprawidłowa nazwa usługi")
	}
	switch req.Action {
	case "start", "stop", "restart", "enable", "disable":
	default:
		return nil, protoErr("bad_request", "nieznana akcja %q", req.Action)
	}
	if isOwnService(req.Name) && req.Action != "start" {
		return nil, protoErr("protected", "usługą agenta OVERVNC nie można sterować zdalnie")
	}
	if err := controlService(ctx, req.Name, req.Action); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

func init() {
	handlers["svc.list"] = handleSvcList
	handlers["svc.control"] = handleSvcControl
}

// ---------- parsery wyjścia narzędzi systemowych (niezależne od platformy — testowalne wszędzie) ----------

// parseSystemctl łączy `systemctl list-units --type=service --all --plain --no-legend`
// z `systemctl list-unit-files --type=service --no-legend` (stan autostartu).
func parseSystemctl(units, unitFiles []byte) []ServiceInfo {
	startTypes := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(unitFiles))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 2 && strings.HasSuffix(f[0], ".service") {
			startTypes[strings.TrimSuffix(f[0], ".service")] = f[1]
		}
	}

	seen := map[string]bool{}
	var out []ServiceInfo
	sc = bufio.NewScanner(bytes.NewReader(units))
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(sc.Text()), "●"))
		f := strings.Fields(line)
		if len(f) < 4 || !strings.HasSuffix(f[0], ".service") || f[1] == "not-found" {
			continue
		}
		name := strings.TrimSuffix(f[0], ".service")
		desc := strings.Join(f[4:], " ")
		seen[name] = true
		out = append(out, ServiceInfo{
			Name:        name,
			DisplayName: firstNonEmpty(desc, name),
			Status:      systemdStatus(f[2], f[3]),
			StartType:   systemdStartType(startTypes[name]),
		})
	}
	// zainstalowane, ale niezaładowane (np. wyłączone) — też pokazujemy jako zatrzymane
	for name, st := range startTypes {
		if seen[name] || strings.HasSuffix(name, "@") {
			continue
		}
		out = append(out, ServiceInfo{Name: name, DisplayName: name, Status: "stopped", StartType: systemdStartType(st)})
	}
	return out
}

func systemdStatus(active, sub string) string {
	switch {
	case active == "active" && sub == "running":
		return "running"
	case active == "failed":
		return "failed"
	case active == "activating":
		return "starting"
	case active == "deactivating":
		return "stopping"
	case active == "inactive", active == "active" && sub == "exited":
		return "stopped"
	}
	return "other"
}

func systemdStartType(s string) string {
	switch s {
	case "enabled", "enabled-runtime", "alias":
		return "auto"
	case "disabled":
		return "manual"
	case "masked", "masked-runtime":
		return "disabled"
	case "static", "indirect", "generated", "transient":
		return "static"
	}
	return ""
}

// parseLaunchctl parsuje `launchctl list` (kolumny: PID, Status, Label).
func parseLaunchctl(out []byte) []ServiceInfo {
	var list []ServiceInfo
	sc := bufio.NewScanner(bytes.NewReader(out))
	first := true
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if first {
			first = false
			if len(f) > 0 && f[0] == "PID" {
				continue
			}
		}
		if len(f) < 3 {
			continue
		}
		status := "stopped"
		if f[0] != "-" {
			status = "running"
		} else if n, err := strconv.Atoi(f[1]); err == nil && n > 0 {
			// dodatni = kod błędu; ujemny = zakończone sygnałem (zwykle przez sam launchd) — to nie błąd
			status = "failed"
		}
		list = append(list, ServiceInfo{Name: f[2], DisplayName: f[2], Status: status})
	}
	return list
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
