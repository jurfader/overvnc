package main

import (
	"context"
	"encoding/json"
	"net"
)

// Wake-on-LAN: ten agent wysyła „magiczny pakiet” do wyłączonego komputera w tej samej sieci lokalnej.
// Serwer na VPS nie może tego zrobić sam — broadcast nie przechodzi przez internet.

// magicPacket: 6 × 0xFF, potem 16 × adres MAC.
func magicPacket(mac net.HardwareAddr) []byte {
	p := make([]byte, 0, 102)
	for range 6 {
		p = append(p, 0xFF)
	}
	for range 16 {
		p = append(p, mac...)
	}
	return p
}

func handleWol(ctx context.Context, data json.RawMessage) (any, error) {
	var req struct {
		MACs       []string `json:"macs"`
		Broadcasts []string `json:"broadcasts"`
	}
	if err := json.Unmarshal(data, &req); err != nil || len(req.MACs) == 0 || len(req.MACs) > 16 {
		return nil, protoErr("bad_request", "nieprawidłowa lista adresów MAC")
	}
	targets := []string{"255.255.255.255"}
	for _, b := range req.Broadcasts {
		if ip := net.ParseIP(b); ip != nil && ip.To4() != nil {
			targets = append(targets, ip.String())
		}
	}
	conn, err := net.ListenUDP("udp4", nil)
	if err != nil {
		return nil, protoErr("wol_failed", "gniazdo UDP: %v", err)
	}
	defer conn.Close()
	// bez SO_BROADCAST system odrzuca wysyłkę na adres rozgłoszeniowy (EACCES)
	if raw, err := conn.SyscallConn(); err == nil {
		_ = raw.Control(func(fd uintptr) { _ = enableBroadcast(fd) })
	}
	sent := 0
	for _, m := range req.MACs {
		mac, err := net.ParseMAC(m)
		if err != nil || len(mac) != 6 {
			continue
		}
		pkt := magicPacket(mac)
		for _, t := range targets {
			for _, port := range []int{9, 7} {
				if _, err := conn.WriteToUDP(pkt, &net.UDPAddr{IP: net.ParseIP(t), Port: port}); err == nil {
					sent++
				}
			}
		}
	}
	if sent == 0 {
		return nil, protoErr("wol_failed", "nie udało się wysłać pakietu")
	}
	return map[string]int{"sent": sent}, nil
}

func init() {
	handlers["wol.send"] = handleWol
}
