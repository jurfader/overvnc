package main

import (
	"context"
	"errors"
	"net"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/host"
)

// MachineID — odcisk komputera. Służy do wykrycia, że agent.json trafił na INNY komputer
// (sklonowany dysk, obraz przechwycony po rejestracji) — wtedy agent rejestruje się od nowa,
// zamiast udawać komputer, z którego go skopiowano.
type MachineID struct {
	HostID string   `json:"host_id"`
	MACs   []string `json:"macs"`
}

var virtualNIC = regexp.MustCompile(`(?i)^(lo|docker|br-|veth|virbr|vmnet|vboxnet|utun|awdl|llw|tun|tap|zt|tailscale|wg|vEthernet|VirtualBox|VMware|Npcap|Bluetooth)`)

func currentMachineID() MachineID {
	m := MachineID{}
	if id, err := host.HostIDWithContext(context.Background()); err == nil {
		m.HostID = strings.ToLower(id)
	}
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		mac := i.HardwareAddr
		// pomijamy pętlę, interfejsy wirtualne i adresy lokalnie administrowane (losowe MAC Wi-Fi, Hyper-V, VPN)
		if len(mac) != 6 || i.Flags&net.FlagLoopback != 0 || virtualNIC.MatchString(i.Name) || mac[0]&0x02 != 0 {
			continue
		}
		m.MACs = append(m.MACs, mac.String())
	}
	slices.Sort(m.MACs)
	m.MACs = slices.Compact(m.MACs)
	return m
}

// isClone — inny identyfikator systemu ALBO żadna fizyczna karta sieciowa się nie powtarza.
// (Sklonowane maszyny wirtualne często mają ten sam machine-id, ale inne MAC; po sysprep bywa odwrotnie.)
func isClone(saved, now MachineID) bool {
	if saved.HostID != "" && now.HostID != "" && saved.HostID != now.HostID {
		return true
	}
	if len(saved.MACs) == 0 || len(now.MACs) == 0 {
		return false
	}
	for _, m := range now.MACs {
		if slices.Contains(saved.MACs, m) {
			return false
		}
	}
	return true
}

// ensureIdentity zapewnia własną tożsamość agenta: rejestruje go w tle (z ponawianiem, bo przy pierwszym
// uruchomieniu kiosku sieci może jeszcze nie być) i rejestruje ponownie po wykryciu klonu.
// Zwraca false tylko po anulowaniu ctx.
func ensureIdentity(ctx context.Context, path string, cfg *Config) bool {
	now := currentMachineID()
	if cfg.enrolled() && cfg.Machine != nil && isClone(*cfg.Machine, now) {
		if cfg.EnrollToken == "" {
			logger.Warning("ten agent.json pochodzi z innego komputera, a brak tokenu rejestracji — działam ze starą tożsamością")
		} else {
			logger.Warning("wykryto sklonowany dysk (inny komputer niż przy rejestracji) — rejestruję ten komputer jako nowy")
			cfg.AgentID, cfg.AgentSecret, cfg.Machine = "", "", nil
			_ = saveConfig(path, cfg)
		}
	}
	if cfg.enrolled() {
		if cfg.Machine == nil { // konfiguracja sprzed wykrywania klonów — zapamiętaj odcisk
			cfg.Machine = &now
			_ = saveConfig(path, cfg)
		}
		return true
	}

	backoff := 5 * time.Second
	for {
		id, secret, err := requestEnrollment(cfg.ServerURL, cfg.EnrollToken)
		if err == nil {
			cfg.AgentID, cfg.AgentSecret, cfg.Machine = id, secret, &now
			if err := saveConfig(path, cfg); err != nil {
				logger.Errorf("rejestracja udana, ale nie można zapisać konfiguracji: %v", err)
			}
			logger.Infof("komputer zarejestrowany w serwerze (%s)", id)
			return true
		}
		wait := backoff
		if errors.Is(err, errEnrollRejected) {
			// token nieważny — administrator musi go przedłużyć/zmienić; nie zasypujemy serwera prośbami
			logger.Errorf("%v — ponowna próba za godzinę", err)
			wait = time.Hour
		} else {
			logger.Warningf("rejestracja nieudana (%v) — ponowna próba za %s", err, wait)
			backoff = min(backoff*2, 5*time.Minute)
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(wait):
		}
	}
}
