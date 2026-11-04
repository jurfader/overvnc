package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Config struct {
	ServerURL     string `json:"server_url"`
	AgentID       string `json:"agent_id,omitempty"`
	AgentSecret   string `json:"agent_secret,omitempty"`
	AllowInsecure bool   `json:"allow_insecure,omitempty"`
	// EnrollToken — token rejestracji zachowany na potrzeby rejestracji w tle (obraz ISO / brak sieci przy instalacji)
	// oraz ponownej rejestracji po wykryciu sklonowanego dysku.
	EnrollToken string `json:"enroll_token,omitempty"`
	// Machine — odcisk komputera z chwili rejestracji (wykrywanie klonów).
	Machine *MachineID `json:"machine,omitempty"`
}

// enrolled — agent ma własną tożsamość (a nie tylko token startowy).
func (c *Config) enrolled() bool { return c.AgentID != "" && c.AgentSecret != "" }

func defaultConfigPath() string {
	switch runtime.GOOS {
	case "windows":
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "OVERVNC", "agent.json")
	case "darwin":
		return "/Library/Application Support/OVERVNC/agent.json"
	default:
		return "/etc/overvnc/agent.json"
	}
}

func loadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("uszkodzony plik konfiguracyjny: %w", err)
	}
	if c.ServerURL == "" || (!c.enrolled() && c.EnrollToken == "") {
		return nil, errors.New("niekompletna konfiguracja")
	}
	if _, err := checkServerURL(c.ServerURL, c.AllowInsecure); err != nil {
		return nil, err
	}
	return &c, nil
}

func saveConfig(path string, c *Config) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	restrictDir(dir) // Windows: tylko SYSTEM i Administratorzy
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// checkServerURL wymusza HTTPS — wyjątkiem jest localhost albo jawne --insecure.
func checkServerURL(raw string, allowInsecure bool) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("nieprawidłowy adres serwera: %q", raw)
	}
	switch u.Scheme {
	case "https":
	case "http":
		host := u.Hostname()
		ip := net.ParseIP(host)
		if !allowInsecure && host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return nil, errors.New("serwer musi używać https:// (do testów w sieci lokalnej użyj --insecure)")
		}
	default:
		return nil, fmt.Errorf("nieobsługiwany schemat %q", u.Scheme)
	}
	return u, nil
}

func wsURL(c *Config) string {
	u, _ := url.Parse(strings.TrimRight(c.ServerURL, "/"))
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/ws/agent"
	return u.String()
}

// errEnrollRejected — serwer odrzucił token (nieprawidłowy, wygasł, wykorzystany). Ponawianie co chwilę nie ma sensu.
var errEnrollRejected = errors.New("serwer odrzucił token rejestracji")

// requestEnrollment rejestruje komputer i zwraca jego własną tożsamość.
func requestEnrollment(serverURL, token string) (id, secret string, err error) {
	hostname, _ := os.Hostname()
	body, _ := json.Marshal(map[string]string{
		"token":    token,
		"hostname": hostname,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
	})
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Post(strings.TrimRight(serverURL, "/")+"/api/agent/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", "", fmt.Errorf("nie można połączyć się z serwerem: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode == http.StatusForbidden {
		return "", "", fmt.Errorf("%w: %s", errEnrollRejected, strings.TrimSpace(string(data)))
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("serwer odrzucił rejestrację (%d): %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var out struct {
		AgentID     string `json:"agentId"`
		AgentSecret string `json:"agentSecret"`
	}
	if err := json.Unmarshal(data, &out); err != nil || out.AgentID == "" || out.AgentSecret == "" {
		return "", "", errors.New("nieprawidłowa odpowiedź serwera")
	}
	return out.AgentID, out.AgentSecret, nil
}

// enroll — rejestracja z wiersza poleceń. defer=true zapisuje tylko token startowy:
// komputer zarejestruje się sam przy pierwszym uruchomieniu usługi (obraz ISO, sysprep, brak sieci).
func enroll(cfgPath, serverURL, token string, insecure, deferred bool) error {
	if serverURL == "" || token == "" {
		return errors.New("wymagane --server i --token")
	}
	u, err := checkServerURL(serverURL, insecure)
	if err != nil {
		return err
	}
	cfg := &Config{ServerURL: u.String(), AllowInsecure: insecure, EnrollToken: token}
	if deferred {
		return saveConfig(cfgPath, cfg)
	}
	id, secret, err := requestEnrollment(cfg.ServerURL, token)
	if err != nil {
		return err
	}
	cfg.AgentID, cfg.AgentSecret = id, secret
	m := currentMachineID()
	cfg.Machine = &m
	return saveConfig(cfgPath, cfg)
}
