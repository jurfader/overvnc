package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"
)

// protocolVersion — wersja protokołu agent<->serwer (opis: docs/protocol.md).
const protocolVersion = 1

// Envelope — wspólny format wiadomości z serwerem.
//
//	serwer -> agent (żądanie):   {type: "<polecenie>", id, data}
//	agent -> serwer (odpowiedź): {type: "result", id, data} | {type: "error", id, error: {code, message}}
//	agent -> serwer (zdarzenie): {type: "hello" | "metrics" | "inventory", data}
type Envelope struct {
	Type  string          `json:"type"`
	ID    string          `json:"id,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error *ProtoError     `json:"error,omitempty"`
}

// ProtoError — błąd zwracany serwerowi; Code jest maszynowy, Message dla człowieka.
type ProtoError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *ProtoError) Error() string { return e.Code + ": " + e.Message }

func protoErr(code, format string, a ...any) *ProtoError {
	return &ProtoError{Code: code, Message: fmt.Sprintf(format, a...)}
}

type handlerFunc func(ctx context.Context, data json.RawMessage) (any, error)

// handlers — polecenia obsługiwane przez agenta. Ich nazwy trafiają do serwera jako "capabilities".
var handlers = map[string]handlerFunc{
	"inventory.refresh": func(ctx context.Context, _ json.RawMessage) (any, error) {
		return collectInventory(ctx), nil
	},
}

const requestTimeout = 5 * time.Minute

func capabilities() []string {
	out := make([]string, 0, len(handlers))
	for k := range handlers {
		out = append(out, k)
	}
	out = append(out, extraCapabilities()...)
	slices.Sort(out)
	return out
}

// handleRequest wykonuje polecenie serwera i buduje odpowiedź. Nie panikuje — panika handlera staje się błędem.
func handleRequest(ctx context.Context, req Envelope) (resp Envelope) {
	resp = Envelope{Type: "result", ID: req.ID}
	h, ok := handlers[req.Type]
	if !ok {
		resp.Type, resp.Error = "error", protoErr("unknown_command", "agent nie obsługuje polecenia %q", req.Type)
		return resp
	}
	defer func() {
		if r := recover(); r != nil {
			resp = Envelope{Type: "error", ID: req.ID, Error: protoErr("panic", "błąd wewnętrzny agenta: %v", r)}
		}
	}()

	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	out, err := h(ctx, req.Data)
	if err != nil {
		var pe *ProtoError
		if !errors.As(err, &pe) {
			pe = protoErr("failed", "%s", err.Error())
		}
		resp.Type, resp.Error = "error", pe
		return resp
	}
	raw, err := json.Marshal(out)
	if err != nil {
		resp.Type, resp.Error = "error", protoErr("encode", "nie można zakodować wyniku: %v", err)
		return resp
	}
	resp.Data = raw
	return resp
}
