//go:build windows

package main

import (
	"context"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func listServices(ctx context.Context) ([]ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, err
	}
	defer m.Disconnect()
	names, err := m.ListServices()
	if err != nil {
		return nil, err
	}
	out := make([]ServiceInfo, 0, len(names))
	for _, n := range names {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		s, err := m.OpenService(n)
		if err != nil {
			continue
		}
		info := ServiceInfo{Name: n, DisplayName: n, Status: "other"}
		if st, err := s.Query(); err == nil {
			info.Status = winState(st.State)
		}
		if cfg, err := s.Config(); err == nil {
			info.DisplayName = firstNonEmpty(cfg.DisplayName, n)
			info.Description = cfg.Description
			info.StartType = winStartType(cfg.StartType)
		}
		s.Close()
		out = append(out, info)
	}
	return out, nil
}

func winState(s svc.State) string {
	switch s {
	case svc.Running:
		return "running"
	case svc.Stopped:
		return "stopped"
	case svc.StartPending, svc.ContinuePending:
		return "starting"
	case svc.StopPending, svc.PausePending:
		return "stopping"
	}
	return "other"
}

func winStartType(t uint32) string {
	switch t {
	case mgr.StartAutomatic:
		return "auto"
	case mgr.StartManual:
		return "manual"
	case mgr.StartDisabled:
		return "disabled"
	case windows.SERVICE_BOOT_START, windows.SERVICE_SYSTEM_START:
		return "static"
	}
	return ""
}

func controlService(ctx context.Context, name, action string) error {
	m, err := mgr.Connect()
	if err != nil {
		return protoErr("svc_failed", "menedżer usług: %v", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return protoErr("not_found", "usługa %s nie istnieje", name)
	}
	defer s.Close()

	waitFor := func(want svc.State) error {
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			st, err := s.Query()
			if err != nil {
				return err
			}
			if st.State == want {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(300 * time.Millisecond):
			}
		}
		return protoErr("svc_timeout", "usługa %s nie zmieniła stanu w ciągu 30 s", name)
	}
	stop := func() error {
		st, err := s.Query()
		if err == nil && st.State == svc.Stopped {
			return nil
		}
		if _, err := s.Control(svc.Stop); err != nil {
			return protoErr("svc_failed", "zatrzymanie %s: %v", name, err)
		}
		return waitFor(svc.Stopped)
	}
	start := func() error {
		if err := s.Start(); err != nil {
			return protoErr("svc_failed", "uruchomienie %s: %v", name, err)
		}
		return waitFor(svc.Running)
	}
	setStart := func(t uint32) error {
		cfg, err := s.Config()
		if err != nil {
			return protoErr("svc_failed", "konfiguracja %s: %v", name, err)
		}
		cfg.StartType = t
		if err := s.UpdateConfig(cfg); err != nil {
			return protoErr("svc_failed", "zmiana autostartu %s: %v", name, err)
		}
		return nil
	}

	switch action {
	case "start":
		return start()
	case "stop":
		return stop()
	case "restart":
		if err := stop(); err != nil {
			return err
		}
		return start()
	case "enable":
		return setStart(mgr.StartAutomatic)
	case "disable":
		return setStart(mgr.StartDisabled)
	}
	return nil
}
