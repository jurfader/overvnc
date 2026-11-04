package main

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

type ProcInfo struct {
	PID        int32   `json:"pid"`
	PPID       int32   `json:"ppid"`
	Name       string  `json:"name"`
	User       string  `json:"user"`
	Cmdline    string  `json:"cmdline"`
	CPU        float64 `json:"cpu"` // % całego procesora (suma rdzeni = 100%)
	MemRSS     uint64  `json:"memRss"`
	MemPercent float32 `json:"memPercent"`
	Started    int64   `json:"started"` // ms od epoki
}

const cpuSampleWindow = 600 * time.Millisecond

// listProcesses — CPU liczone z dwóch próbek czasów procesora (jak Menedżer zadań), w % całej maszyny.
func listProcesses(ctx context.Context) ([]ProcInfo, error) {
	procs, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return nil, err
	}
	cpuTime := func(p *process.Process) float64 {
		t, err := p.TimesWithContext(ctx)
		if err != nil {
			return -1
		}
		return t.User + t.System
	}
	before := make(map[int32]float64, len(procs))
	for _, p := range procs {
		before[p.Pid] = cpuTime(p)
	}
	start := time.Now()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(cpuSampleWindow):
	}
	elapsed := time.Since(start).Seconds()
	ncpu := float64(runtime.NumCPU())

	out := make([]ProcInfo, 0, len(procs))
	for _, p := range procs {
		name, err := p.NameWithContext(ctx)
		if err != nil {
			continue // proces zdążył się zakończyć
		}
		info := ProcInfo{PID: p.Pid, Name: name}
		info.PPID, _ = p.PpidWithContext(ctx)
		info.User, _ = p.UsernameWithContext(ctx)
		if cmd, err := p.CmdlineWithContext(ctx); err == nil {
			if len(cmd) > 1024 {
				cmd = cmd[:1024] + "…"
			}
			info.Cmdline = cmd
		}
		if mi, err := p.MemoryInfoWithContext(ctx); err == nil {
			info.MemRSS = mi.RSS
		}
		info.MemPercent, _ = p.MemoryPercentWithContext(ctx)
		info.Started, _ = p.CreateTimeWithContext(ctx)
		if b := before[p.Pid]; b >= 0 {
			if a := cpuTime(p); a >= b {
				info.CPU = round1((a - b) / elapsed / ncpu * 100)
			}
		}
		out = append(out, info)
	}
	return out, nil
}

func handleProcList(ctx context.Context, _ json.RawMessage) (any, error) {
	return listProcesses(ctx)
}

func handleProcKill(ctx context.Context, data json.RawMessage) (any, error) {
	var req struct {
		PID   int32 `json:"pid"`
		Force bool  `json:"force"`
	}
	if err := json.Unmarshal(data, &req); err != nil || req.PID <= 0 {
		return nil, protoErr("bad_request", "nieprawidłowy PID")
	}
	// ochrona: procesu systemowego (PID 1/4) i samego agenta nie zabijamy
	if req.PID == 1 || (runtime.GOOS == "windows" && req.PID == 4) || int(req.PID) == os.Getpid() {
		return nil, protoErr("protected", "tego procesu nie można zakończyć zdalnie")
	}
	p, err := process.NewProcessWithContext(ctx, req.PID)
	if err != nil {
		return nil, protoErr("not_found", "proces %d już nie istnieje", req.PID)
	}
	if req.Force {
		err = p.KillWithContext(ctx)
	} else {
		err = p.TerminateWithContext(ctx)
	}
	if err != nil {
		return nil, protoErr("kill_failed", "nie udało się zakończyć procesu %d: %v", req.PID, err)
	}
	return map[string]bool{"ok": true}, nil
}

func init() {
	handlers["proc.list"] = handleProcList
	handlers["proc.kill"] = handleProcKill
}
