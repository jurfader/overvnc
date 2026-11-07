package main

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	metricsInterval   = 15 * time.Second
	inventoryInterval = 6 * time.Hour
	pingInterval      = 30 * time.Second
	maxBackoff        = 60 * time.Second
	maxConcurrentReqs = 16
)

var errUnauthorized = errors.New("serwer odrzucił dane agenta (agent usunięty z panelu?)")

// runAgent utrzymuje połączenie z serwerem aż do anulowania ctx.
func runAgent(ctx context.Context, cfgPath string, cfg *Config) {
	logger.Infof("OVERVNC Agent %s, serwer: %s", version, cfg.ServerURL)
	setUpdateContext(cfg, cfgPath)
	setKioskContext(cfgPath)
	go updateLoop(ctx, cfg, cfgPath)
	go resumeKioskTask(ctx) // np. przedłużanie okresu próbnego przerwane restartem
	go runUpdatesChecker(ctx)
	go runPhoneWatcher(ctx) // kiosk: „Zdjęcia z telefonu” po podłączeniu telefonu
	backoff := time.Second
	for {
		started := time.Now()
		err := session(ctx, cfg, cfgPath)
		if ctx.Err() != nil {
			return
		}
		wait := backoff
		switch {
		case errors.Is(err, errUnauthorized):
			logger.Error(err)
			wait = 5 * time.Minute
		case err != nil:
			logger.Warningf("rozłączono: %v", err)
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second // połączenie było stabilne — zacznij od nowa
		} else {
			backoff = min(backoff*2, maxBackoff)
		}
		// losowy rozrzut, żeby po awarii serwera agenci nie wracali wszyscy naraz
		wait += time.Duration(rand.Int64N(int64(wait/2) + 1))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func session(parent context.Context, cfg *Config, cfgPath string) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	dialCtx, dialCancel := context.WithTimeout(ctx, 20*time.Second)
	conn, resp, err := websocket.Dial(dialCtx, wsURL(cfg), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + cfg.AgentID + "." + cfg.AgentSecret}},
	})
	dialCancel()
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return errUnauthorized
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(16 << 20)
	logger.Info("połączono z serwerem")
	// stabilne połączenie po aktualizacji = aktualizacja udana (inaczej po 3 startach wycofanie)
	healthy := time.AfterFunc(updateHealthyAfter, func() { markUpdateHealthy(cfgPath) })
	defer healthy.Stop()

	// coder/websocket pozwala na współbieżne Write, więc odpowiedzi, zdarzenia i strumienie mogą iść z wielu gorutyn
	write := func(env Envelope) error {
		wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
		defer wcancel()
		return wsjson.Write(wctx, conn, env)
	}
	send := func(typ string, data any) error {
		raw, err := json.Marshal(data)
		if err != nil {
			return err
		}
		return write(Envelope{Type: typ, Data: raw})
	}

	sess := &sessionIO{
		writeBinary: func(b []byte) error {
			wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
			defer wcancel()
			return conn.Write(wctx, websocket.MessageBinary, b)
		},
		event:    send,
		channels: newChannelManager(),
	}
	// zerwanie połączenia kończy wszystkie powłoki — nie zostawiamy osieroconych procesów root/SYSTEM
	defer sess.channels.closeAll()
	ctx = withSession(ctx, sess)

	errc := make(chan error, 4)
	fail := func(err error) {
		select {
		case errc <- err:
		default:
		}
	}

	// odczyt żądań z serwera; każde wykonywane w osobnej gorutynie, z limitem współbieżności
	go func() {
		sem := make(chan struct{}, maxConcurrentReqs)
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				fail(err)
				return
			}
			if typ == websocket.MessageBinary {
				sess.channels.handleFrame(data)
				continue
			}
			var msg Envelope
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			if msg.ID == "" {
				continue // serwer nie wysyła obecnie zdarzeń bez ID
			}
			select {
			case sem <- struct{}{}:
			default:
				_ = write(Envelope{Type: "error", ID: msg.ID, Error: protoErr("busy", "agent wykonuje zbyt wiele poleceń naraz")})
				continue
			}
			go func(req Envelope) {
				defer func() { <-sem }()
				if err := write(handleRequest(ctx, req)); err != nil {
					fail(err)
				}
			}(msg)
		}
	}()

	// wykrywanie martwego połączenia
	go func() {
		t := time.NewTicker(pingInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, pcancel := context.WithTimeout(ctx, 15*time.Second)
				err := conn.Ping(pctx)
				pcancel()
				if err != nil {
					fail(errors.New("brak odpowiedzi na ping"))
					return
				}
			}
		}
	}()

	// hello + inwentarz, potem cykliczne metryki i inwentarz
	go func() {
		hello := map[string]any{
			"version":      version,
			"protocol":     protocolVersion,
			"capabilities": capabilities(),
			"shells":       availableShells(),
			"runAs":        currentUser(),
			"inventory":    collectInventory(ctx),
		}
		if err := send("hello", hello); err != nil {
			fail(err)
			return
		}
		mc := newMetricsCollector()
		metricsT := time.NewTicker(metricsInterval)
		invT := time.NewTicker(inventoryInterval)
		secT := time.NewTicker(securityInterval)
		defer metricsT.Stop()
		defer invT.Stop()
		defer secT.Stop()
		if err := send("metrics", mc.collect(ctx)); err != nil {
			fail(err)
			return
		}
		for {
			var err error
			select {
			case <-ctx.Done():
				return
			case <-metricsT.C:
				err = send("metrics", mc.collect(ctx))
			case <-invT.C:
				err = send("inventory", collectInventory(ctx))
			case <-inventoryNow:
				err = send("inventory", collectInventory(ctx))
			case <-secT.C:
				err = sendSecurity(ctx, send)
			case <-securityNow:
				err = sendSecurity(ctx, send)
			}
			if err != nil {
				fail(err)
				return
			}
		}
	}()

	select {
	case <-ctx.Done():
		conn.Close(websocket.StatusNormalClosure, "agent stopping")
		return nil
	case err := <-errc:
		return err
	}
}
