package main

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"unicode"
)

// Akcje zasilania. Każdy system obsługuje inny podzbiór (supportedPowerActions w power_<os>.go);
// agent ogłasza je serwerowi jako capabilities "power.<akcja>", więc panel pokazuje tylko działające.
type powerReq struct {
	Action       string `json:"action"`
	DelayMinutes int    `json:"delayMinutes"`
	Message      string `json:"message"`
}

const maxPowerDelay = 24 * 60

// sanitizeMessage — komunikat trafia jako argument polecenia (bez powłoki), ale i tak usuwamy znaki sterujące.
func sanitizeMessage(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 200 {
		s = string(r[:200])
	}
	return s
}

func handlePower(ctx context.Context, data json.RawMessage) (any, error) {
	var req powerReq
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, protoErr("bad_request", "nieprawidłowe żądanie")
	}
	if !slices.Contains(supportedPowerActions(), req.Action) {
		return nil, protoErr("unsupported", "akcja %q nie jest obsługiwana na tym systemie", req.Action)
	}
	if req.DelayMinutes < 0 || req.DelayMinutes > maxPowerDelay {
		return nil, protoErr("bad_request", "opóźnienie musi mieć 0–%d minut", maxPowerDelay)
	}
	req.Message = sanitizeMessage(req.Message)
	if err := doPower(ctx, req); err != nil {
		return nil, err
	}
	powerScheduled(req)
	return map[string]any{"ok": true, "pending": currentPowerPending().view()}, nil
}

func init() {
	handlers["power.action"] = handlePower
}

// extraCapabilities — możliwości, które nie są osobnymi poleceniami.
func extraCapabilities() []string {
	var out []string
	for _, a := range supportedPowerActions() {
		out = append(out, "power."+a)
	}
	// agent sam zgłasza zaplanowany restart/wyłączenie (zdarzenie "power" i pole hello.powerPending)
	out = append(out, "power.pending")
	if userScriptsSupported() {
		out = append(out, "script.user")
	}
	return out
}
