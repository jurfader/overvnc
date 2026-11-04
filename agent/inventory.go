package main

import (
	"context"
	"net"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	psnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

type Inventory struct {
	CollectedAt   int64      `json:"collectedAt"`
	Host          HostInfo   `json:"host"`
	CPU           CPUInfo    `json:"cpu"`
	Memory        MemInfo    `json:"memory"`
	Disks         []DiskInfo `json:"disks"`
	Network       []NetIf    `json:"network"`
	Users         []string   `json:"users"`
	Software      []Software `json:"software"`
	SoftwareError string     `json:"softwareError,omitempty"`
}

type HostInfo struct {
	Hostname        string `json:"hostname"`
	OS              string `json:"os"`
	Platform        string `json:"platform"`
	PlatformFamily  string `json:"platformFamily"`
	PlatformVersion string `json:"platformVersion"`
	KernelVersion   string `json:"kernelVersion"`
	Arch            string `json:"arch"`
	HostID          string `json:"hostId"`
	BootTime        uint64 `json:"bootTime"`
	Virtualization  string `json:"virtualization,omitempty"`
}

type CPUInfo struct {
	Model   string  `json:"model"`
	Cores   int     `json:"cores"`
	Threads int     `json:"threads"`
	MHz     float64 `json:"mhz"`
}

type MemInfo struct {
	Total     uint64 `json:"total"`
	SwapTotal uint64 `json:"swapTotal"`
}

type DiskInfo struct {
	Device      string  `json:"device"`
	Mountpoint  string  `json:"mountpoint"`
	Fstype      string  `json:"fstype"`
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	UsedPercent float64 `json:"usedPercent"`
}

type NetIf struct {
	Name  string   `json:"name"`
	MAC   string   `json:"mac"`
	Addrs []string `json:"addrs"`
}

type Software struct {
	Name      string `json:"name"`
	Version   string `json:"version,omitempty"`
	Publisher string `json:"publisher,omitempty"`
}

func collectInventory(ctx context.Context) Inventory {
	inv := Inventory{CollectedAt: time.Now().UnixMilli()}

	if h, err := host.InfoWithContext(ctx); err == nil {
		inv.Host = HostInfo{
			Hostname: h.Hostname, OS: h.OS, Platform: h.Platform, PlatformFamily: h.PlatformFamily,
			PlatformVersion: h.PlatformVersion, KernelVersion: h.KernelVersion, Arch: h.KernelArch,
			HostID: h.HostID, BootTime: h.BootTime,
		}
		if h.VirtualizationRole == "guest" {
			inv.Host.Virtualization = h.VirtualizationSystem
		}
	}
	if inv.Host.OS == "" {
		inv.Host.OS = runtime.GOOS
	}
	if inv.Host.Arch == "" {
		inv.Host.Arch = runtime.GOARCH
	}

	if infos, err := cpu.InfoWithContext(ctx); err == nil && len(infos) > 0 {
		inv.CPU.Model = strings.TrimSpace(infos[0].ModelName)
		inv.CPU.MHz = infos[0].Mhz
	}
	inv.CPU.Cores, _ = cpu.CountsWithContext(ctx, false)
	inv.CPU.Threads, _ = cpu.CountsWithContext(ctx, true)

	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		inv.Memory.Total = vm.Total
	}
	if sw, err := mem.SwapMemoryWithContext(ctx); err == nil {
		inv.Memory.SwapTotal = sw.Total
	}

	for _, p := range relevantPartitions(ctx) {
		if u, err := disk.UsageWithContext(ctx, p.Mountpoint); err == nil && u.Total > 0 {
			inv.Disks = append(inv.Disks, DiskInfo{
				Device: p.Device, Mountpoint: p.Mountpoint, Fstype: p.Fstype,
				Total: u.Total, Used: u.Used, UsedPercent: u.UsedPercent,
			})
		}
	}

	if ifs, err := net.Interfaces(); err == nil {
		for _, i := range ifs {
			if i.Flags&net.FlagLoopback != 0 || i.Flags&net.FlagUp == 0 {
				continue
			}
			addrs, _ := i.Addrs()
			if !hasRoutableAddr(addrs) {
				continue // np. utun/awdl na macOS — tylko adresy link-local
			}
			n := NetIf{Name: i.Name, MAC: i.HardwareAddr.String()}
			for _, a := range addrs {
				n.Addrs = append(n.Addrs, a.String())
			}
			inv.Network = append(inv.Network, n)
		}
	}

	if us, err := host.UsersWithContext(ctx); err == nil {
		for _, u := range us {
			if !slices.Contains(inv.Users, u.User) {
				inv.Users = append(inv.Users, u.User)
			}
		}
	}
	if len(inv.Users) == 0 {
		inv.Users = consoleUsers()
	}

	swCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if sw, err := installedSoftware(swCtx); err != nil {
		inv.SoftwareError = err.Error()
	} else {
		slices.SortFunc(sw, func(a, b Software) int { return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)) })
		inv.Software = sw
	}
	return inv
}

// relevantPartitions pomija partycje systemowe/wirtualne, które tylko zaśmiecają widok.
func relevantPartitions(ctx context.Context) []disk.PartitionStat {
	parts, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		return nil
	}
	skipFs := map[string]bool{"tmpfs": true, "devtmpfs": true, "squashfs": true, "overlay": true, "devfs": true, "autofs": true, "nullfs": true}
	var out []disk.PartitionStat
	seen := map[string]bool{}
	for _, p := range parts {
		if skipFs[p.Fstype] || seen[p.Mountpoint] {
			continue
		}
		if runtime.GOOS == "darwin" && !darwinUserVolume(p) {
			continue
		}
		if runtime.GOOS == "linux" && (strings.HasPrefix(p.Mountpoint, "/snap/") || strings.HasPrefix(p.Mountpoint, "/boot/efi")) {
			continue
		}
		seen[p.Mountpoint] = true
		out = append(out, p)
	}
	return out
}

// darwinUserVolume: "/" oraz dyski zamontowane w /Volumes (bez Recovery i obrazów DMG tylko do odczytu).
// "/System/Volumes/Data" pomijamy, bo to ten sam kontener APFS co "/".
func darwinUserVolume(p disk.PartitionStat) bool {
	if p.Mountpoint == "/" {
		return true
	}
	if !strings.HasPrefix(p.Mountpoint, "/Volumes/") || p.Mountpoint == "/Volumes/Recovery" {
		return false
	}
	return !slices.Contains(p.Opts, "ro")
}

func hasRoutableAddr(addrs []net.Addr) bool {
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLinkLocalUnicast() && !ipn.IP.IsLoopback() {
			return true
		}
	}
	return false
}

// ---------- metryki ----------

type Metrics struct {
	Ts          int64       `json:"ts"`
	CPUPercent  float64     `json:"cpuPercent"`
	MemTotal    uint64      `json:"memTotal"`
	MemUsed     uint64      `json:"memUsed"`
	MemPercent  float64     `json:"memPercent"`
	SwapUsed    uint64      `json:"swapUsed"`
	Disks       []DiskUsage `json:"disks"`
	Uptime      uint64      `json:"uptime"`
	Load        []float64   `json:"load,omitempty"`
	NetRxBps    float64     `json:"netRxBps"`
	NetTxBps    float64     `json:"netTxBps"`
	Processes   int         `json:"processes"`
	ActiveUsers []string    `json:"activeUsers,omitempty"`
}

type DiskUsage struct {
	Mountpoint  string  `json:"mountpoint"`
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	UsedPercent float64 `json:"usedPercent"`
}

type metricsCollector struct {
	lastNetAt  time.Time
	lastRx     uint64
	lastTx     uint64
	partitions []disk.PartitionStat
	partsAt    time.Time
}

func newMetricsCollector() *metricsCollector { return &metricsCollector{} }

func (m *metricsCollector) collect(ctx context.Context) Metrics {
	out := Metrics{Ts: time.Now().UnixMilli()}

	if p, err := cpu.PercentWithContext(ctx, time.Second, false); err == nil && len(p) > 0 {
		out.CPUPercent = round1(p[0])
	}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		out.MemTotal, out.MemUsed, out.MemPercent = vm.Total, vm.Used, round1(vm.UsedPercent)
	}
	if sw, err := mem.SwapMemoryWithContext(ctx); err == nil {
		out.SwapUsed = sw.Used
	}

	if time.Since(m.partsAt) > 10*time.Minute {
		m.partitions, m.partsAt = relevantPartitions(ctx), time.Now()
	}
	for _, p := range m.partitions {
		if u, err := disk.UsageWithContext(ctx, p.Mountpoint); err == nil && u.Total > 0 {
			out.Disks = append(out.Disks, DiskUsage{Mountpoint: p.Mountpoint, Total: u.Total, Used: u.Used, UsedPercent: round1(u.UsedPercent)})
		}
	}

	out.Uptime, _ = host.UptimeWithContext(ctx)
	if runtime.GOOS != "windows" {
		if l, err := load.AvgWithContext(ctx); err == nil {
			out.Load = []float64{round2(l.Load1), round2(l.Load5), round2(l.Load15)}
		}
	}

	if io, err := psnet.IOCountersWithContext(ctx, false); err == nil && len(io) > 0 {
		now := time.Now()
		if !m.lastNetAt.IsZero() && io[0].BytesRecv >= m.lastRx && io[0].BytesSent >= m.lastTx {
			dt := now.Sub(m.lastNetAt).Seconds()
			out.NetRxBps = float64(io[0].BytesRecv-m.lastRx) / dt
			out.NetTxBps = float64(io[0].BytesSent-m.lastTx) / dt
		}
		m.lastNetAt, m.lastRx, m.lastTx = now, io[0].BytesRecv, io[0].BytesSent
	}

	if pids, err := process.PidsWithContext(ctx); err == nil {
		out.Processes = len(pids)
	}
	out.ActiveUsers = consoleUsers()
	return out
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }
func round2(f float64) float64 { return float64(int(f*100+0.5)) / 100 }
