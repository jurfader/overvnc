package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"sync"
	"time"
)

// Okno czatu ze wsparciem (proces ikony w zasobniku, sesja użytkownika): lokalny serwer na 127.0.0.1
// z tokenem w adresie okna; okno przeglądarki w trybie aplikacji. Stan (historia, połączenie, kto jest
// na pulpicie) przychodzi od usługi agenta; wiadomości użytkownika idą do usługi.

//go:embed trayui
var trayUI embed.FS

type trayState struct {
	mu       sync.Mutex
	history  []chatMsg
	online   bool // usługa agenta połączona z serwerem
	linked   bool // ikona połączona z usługą agenta
	remote   []string
	computer string
	user     string
	lastPing time.Time
	// do usługi (ustawiane przez warstwę systemu)
	sendChat  func(text string) error
	endRemote func() error
}

func (s *trayState) windowOpen() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Since(s.lastPing) < 6*time.Second
}

// apply — wiadomość od usługi; zwraca nową wiadomość od wsparcia (do powiadomienia), jeśli przyszła.
func (s *trayState) apply(raw []byte) (incoming *chatMsg, statusChanged bool) {
	var m struct {
		T        string    `json:"t"`
		Items    []chatMsg `json:"items"`
		Msg      *chatMsg  `json:"msg"`
		Online   bool      `json:"online"`
		Remote   []string  `json:"remote"`
		Computer string    `json:"computer"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch m.T {
	case "history":
		s.history = m.Items
	case "chat":
		if m.Msg != nil {
			s.history = append(s.history, *m.Msg)
			if len(s.history) > chatHistoryMax {
				s.history = s.history[len(s.history)-chatHistoryMax:]
			}
			if m.Msg.From == "operator" {
				return m.Msg, false
			}
		}
	case "status":
		s.online, s.remote, s.computer = m.Online, m.Remote, m.Computer
		return nil, true
	}
	return nil, false
}

func (s *trayState) setLinked(v bool) {
	s.mu.Lock()
	s.linked = v
	s.mu.Unlock()
}

func (s *trayState) remoteNames() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.remote...)
}

// startTrayServer — serwer okna czatu; zwraca adres okna (z tokenem).
func startTrayServer(st *trayState) (string, error) {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	token := hex.EncodeToString(b)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	mux := http.NewServeMux()
	ui, _ := fs.Sub(trayUI, "trayui")
	static := http.FileServer(http.FS(ui))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		static.ServeHTTP(w, r)
	}))
	api := func(p string, h func(r *http.Request) (any, error)) {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("t") != token {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			st.mu.Lock()
			st.lastPing = time.Now()
			st.mu.Unlock()
			v, err := h(r)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			if err != nil {
				w.WriteHeader(http.StatusBadGateway)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			_ = json.NewEncoder(w).Encode(v)
		})
	}
	api("/api/state", func(*http.Request) (any, error) {
		st.mu.Lock()
		defer st.mu.Unlock()
		h := st.history
		if h == nil {
			h = []chatMsg{}
		}
		return map[string]any{"history": h, "online": st.online && st.linked, "linked": st.linked, "remote": st.remote, "computer": st.computer, "user": st.user}, nil
	})
	api("/api/send", func(r *http.Request) (any, error) {
		var body struct {
			Text string `json:"text"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(http.MaxBytesReader(nil, r.Body, 64<<10)).Decode(&body) != nil {
			return nil, errors.New("nieprawidłowa wiadomość")
		}
		if st.sendChat == nil {
			return nil, errors.New("brak połączenia z usługą OVERVNC")
		}
		return map[string]bool{"ok": true}, st.sendChat(body.Text)
	})
	api("/api/end-remote", func(r *http.Request) (any, error) {
		if r.Method != http.MethodPost || st.endRemote == nil {
			return nil, errors.New("brak połączenia z usługą OVERVNC")
		}
		return map[string]bool{"ok": true}, st.endRemote()
	})
	go func() { _ = (&http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}).Serve(ln) }()
	return "http://" + ln.Addr().String() + "/#" + token, nil
}
