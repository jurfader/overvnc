package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// „Zdjęcia z telefonu” — aplikacja dla klienta kiosku: zdjęcia i filmy z podłączonego telefonu
// (Android, iPhone), kopiowanie do Pobranych i usuwanie z telefonu. Działa w sesji klienta jako
// lokalny serwer (127.0.0.1, losowy port i token) z interfejsem w oknie przeglądarki (tryb aplikacji).
// Dostęp do telefonu daje phoneSource: na Windows powłoka systemu (ten sam mechanizm co Eksplorator),
// w testach — folder ze zdjęciami.

//go:embed phoneui
var phoneUI embed.FS

// phoneBrowserPath — przeglądarka dozwolona w trybie kiosku (z profilu, przez argument `browser=`).
var phoneBrowserPath string

type phoneDevice struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type phoneItem struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	TS    int64  `json:"ts"` // ms (data zrobienia / utworzenia)
	Size  int64  `json:"size"`
	Video bool   `json:"video,omitempty"`
	Album string `json:"album"` // Aparat / WhatsApp / Zrzuty ekranu / nazwa folderu
}

type phoneSource interface {
	devices() ([]phoneDevice, error)
	items(device string) ([]phoneItem, error)
	thumb(id string, size int) ([]byte, error) // JPEG
	copyTo(id, destDir string) (string, error) // nazwa utworzonego pliku
	remove(id string) error
	close()
}

var phoneMediaExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".heic": true, ".heif": true, ".webp": true, ".gif": true, ".dng": true, ".bmp": true,
	".mp4": true, ".mov": true, ".3gp": true, ".m4v": true,
}

func phoneIsMedia(name string) bool { return phoneMediaExt[strings.ToLower(path.Ext(name))] }
func phoneIsVideo(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".mp4", ".mov", ".3gp", ".m4v":
		return true
	}
	return false
}

// phoneScanRoots — gdzie na telefonie są zdjęcia: aparat, zrzuty, WhatsApp i inne komunikatory, pobrane.
var phoneScanRoots = [][]string{
	{"DCIM"},
	{"Pictures"},
	{"Download"},
	{"Android", "media", "com.whatsapp", "WhatsApp", "Media", "WhatsApp Images"},
	{"Android", "media", "com.whatsapp", "WhatsApp", "Media", "WhatsApp Video"},
	{"WhatsApp", "Media", "WhatsApp Images"},
	{"WhatsApp", "Media", "WhatsApp Video"},
	{"Telegram"},
	{"Movies"},
}

// phoneSkipDir — foldery bez zdjęć klienta (miniatury, kosz, ukryte, „Wysłane” z WhatsAppa).
func phoneSkipDir(name string) bool {
	n := strings.ToLower(name)
	return strings.HasPrefix(n, ".") || n == "thumbnails" || n == "cache" || n == "sent" || n == "private" || n == ".trash"
}

// phoneAlbum — czytelna nazwa źródła zdjęcia z jego ścieżki na telefonie.
func phoneAlbum(segs []string) string {
	low := strings.ToLower(strings.Join(segs, "/"))
	switch {
	case strings.Contains(low, "whatsapp"):
		return "WhatsApp"
	case strings.Contains(low, "telegram"):
		return "Telegram"
	case strings.Contains(low, "screenshot"):
		return "Zrzuty ekranu"
	case strings.Contains(low, "messenger"):
		return "Messenger"
	case strings.Contains(low, "instagram"):
		return "Instagram"
	case len(segs) > 0 && strings.EqualFold(segs[0], "DCIM"):
		return "Aparat"
	case len(segs) > 0 && strings.EqualFold(segs[0], "Download"):
		return "Pobrane"
	case len(segs) > 1:
		return segs[len(segs)-1]
	}
	return "Inne"
}

// ---------- serwer aplikacji ----------

type phoneOp struct {
	Kind     string   `json:"kind"` // copy | delete
	Total    int      `json:"total"`
	Done     int      `json:"done"`
	Failed   int      `json:"failed"`
	Error    string   `json:"error,omitempty"`
	Finished bool     `json:"finished"`
	Dest     string   `json:"dest,omitempty"`
	Files    []string `json:"-"`
}

type phoneApp struct {
	src      phoneSource
	token    string
	destDir  string
	mu       sync.Mutex
	lastPing time.Time
	op       *phoneOp
	thumbs   map[string][]byte
	thumbMem int
}

func newPhoneApp(src phoneSource, destDir string) *phoneApp {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return &phoneApp{src: src, token: hex.EncodeToString(b), destDir: destDir, thumbs: map[string][]byte{}, lastPing: time.Now()}
}

const phoneThumbCacheBytes = 96 << 20

func (a *phoneApp) handler() http.Handler {
	mux := http.NewServeMux()
	ui, _ := fs.Sub(phoneUI, "phoneui")
	static := http.FileServer(http.FS(ui))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		static.ServeHTTP(w, r)
	}))
	api := func(p string, h func(w http.ResponseWriter, r *http.Request) (any, error)) {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			// tylko ta aplikacja: token z adresu okna, żadnych zapytań z innych stron
			if r.URL.Query().Get("t") != a.token {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			a.mu.Lock()
			a.lastPing = time.Now()
			a.mu.Unlock()
			v, err := h(w, r)
			if err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			if v == nil {
				return // odpowiedź już wysłana (obraz)
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(v)
		})
	}
	api("/api/ping", func(http.ResponseWriter, *http.Request) (any, error) { return map[string]bool{"ok": true}, nil })
	api("/api/devices", func(http.ResponseWriter, *http.Request) (any, error) {
		d, err := a.src.devices()
		if d == nil {
			d = []phoneDevice{}
		}
		return map[string]any{"devices": d}, err
	})
	api("/api/items", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		items, err := a.src.items(r.URL.Query().Get("device"))
		if err != nil {
			return nil, err
		}
		sort.SliceStable(items, func(i, j int) bool { return items[i].TS > items[j].TS })
		if items == nil {
			items = []phoneItem{}
		}
		return map[string]any{"items": items}, nil
	})
	api("/api/thumb", func(w http.ResponseWriter, r *http.Request) (any, error) {
		id := r.URL.Query().Get("id")
		size := 320
		if r.URL.Query().Get("size") == "large" {
			size = 1600
		}
		key := fmt.Sprintf("%s@%d", id, size)
		a.mu.Lock()
		b, ok := a.thumbs[key]
		a.mu.Unlock()
		if !ok {
			var err error
			if b, err = a.src.thumb(id, size); err != nil {
				http.Error(w, "brak podglądu", http.StatusNotFound)
				return nil, nil
			}
			a.mu.Lock()
			if a.thumbMem+len(b) > phoneThumbCacheBytes {
				a.thumbs, a.thumbMem = map[string][]byte{}, 0
			}
			a.thumbs[key] = b
			a.thumbMem += len(b)
			a.mu.Unlock()
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = w.Write(b)
		return nil, nil
	})
	api("/api/copy", func(_ http.ResponseWriter, r *http.Request) (any, error) { return a.start(r, "copy") })
	api("/api/delete", func(_ http.ResponseWriter, r *http.Request) (any, error) { return a.start(r, "delete") })
	api("/api/op", func(http.ResponseWriter, *http.Request) (any, error) {
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.op == nil {
			return map[string]any{"op": nil}, nil
		}
		op := *a.op
		return map[string]any{"op": op}, nil
	})
	api("/api/open-downloads", func(http.ResponseWriter, *http.Request) (any, error) {
		return map[string]bool{"ok": true}, phoneOpenFolder(a.destDir)
	})
	return mux
}

func (a *phoneApp) start(r *http.Request, kind string) (any, error) {
	if r.Method != http.MethodPost {
		return nil, errors.New("tylko POST")
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 4<<20)).Decode(&body); err != nil || len(body.IDs) == 0 {
		return nil, errors.New("nie wybrano zdjęć")
	}
	a.mu.Lock()
	if a.op != nil && !a.op.Finished {
		a.mu.Unlock()
		return nil, errors.New("poprzednia operacja jeszcze trwa")
	}
	op := &phoneOp{Kind: kind, Total: len(body.IDs)}
	if kind == "copy" {
		op.Dest = a.destDir
	}
	a.op = op
	a.mu.Unlock()
	go a.run(op, body.IDs)
	return map[string]bool{"ok": true}, nil
}

func (a *phoneApp) run(op *phoneOp, ids []string) {
	if op.Kind == "copy" {
		if err := os.MkdirAll(a.destDir, 0o755); err != nil {
			a.mu.Lock()
			op.Error, op.Finished = err.Error(), true
			a.mu.Unlock()
			return
		}
	}
	for _, id := range ids {
		var err error
		var file string
		if op.Kind == "copy" {
			file, err = a.src.copyTo(id, a.destDir)
		} else {
			err = a.src.remove(id)
		}
		a.mu.Lock()
		op.Done++
		if err != nil {
			op.Failed++
			if op.Error == "" {
				op.Error = err.Error()
			}
		} else if file != "" {
			op.Files = append(op.Files, file)
		}
		a.mu.Unlock()
	}
	a.mu.Lock()
	op.Finished = true
	a.mu.Unlock()
}

// idleFor — od kiedy okno aplikacji się nie odzywa (zamknięte okno = koniec procesu).
func (a *phoneApp) idleFor() time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	return time.Since(a.lastPing)
}

// runPhoneApp — `overvnc-agent phone [--auto]`: serwer + okno; koniec po zamknięciu okna.
func runPhoneApp(args []string) int {
	if len(args) > 0 && args[0] == "selftest" {
		return runPhoneSelftest()
	}
	for _, a := range args {
		if b, ok := strings.CutPrefix(a, "browser="); ok {
			phoneBrowserPath = b
		}
	}
	release, ok := phoneSingleInstance()
	if !ok {
		return 0 // już otwarta
	}
	defer release()
	src, err := newPhoneSource()
	if err != nil {
		fmt.Fprintln(os.Stderr, "zdjęcia z telefonu:", err)
		return 1
	}
	defer src.close()
	app := newPhoneApp(src, phoneDownloadsDir())
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	srv := &http.Server{Handler: app.handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	url := fmt.Sprintf("http://%s/#%s", ln.Addr(), app.token)
	if os.Getenv("OVERVNC_PHONE_NOWINDOW") == "1" {
		fmt.Println(url) // testy interfejsu: adres zamiast okna
	} else if err := phoneOpenWindow(url); err != nil {
		fmt.Fprintln(os.Stderr, "okno aplikacji:", err)
		return 1
	}
	// okno odpytuje co kilka sekund; cisza = okno zamknięte (2 min na pierwsze uruchomienie przeglądarki)
	limit := 2 * time.Minute
	for range time.Tick(5 * time.Second) {
		idle := app.idleFor()
		if idle > limit {
			break
		}
		if idle < 30*time.Second {
			limit = 45 * time.Second
		}
	}
	_ = srv.Close()
	return 0
}

// phoneDownloadsDir — folder Pobrane bieżącego użytkownika (klienta kiosku).
func phoneDownloadsDir() string {
	if d := os.Getenv("OVERVNC_PHONE_DEST"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Downloads")
}

// uniqueName — „IMG_1.jpg”, a gdy zajęte: „IMG_1 (2).jpg”, „IMG_1 (3).jpg”…
func uniqueName(dir, name string) string {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	cand := name
	for i := 2; ; i++ {
		if _, err := os.Lstat(filepath.Join(dir, cand)); errors.Is(err, os.ErrNotExist) {
			return cand
		}
		cand = fmt.Sprintf("%s (%d)%s", base, i, ext)
	}
}

// runPhoneSelftest — `overvnc-agent phone selftest`: sprawdzenie dostępu do telefonu bez okna
// (na Windows z OVERVNC_PHONE_SHELL_TEST=<folder> — ta sama ścieżka kodu powłoki na zwykłym folderze).
func runPhoneSelftest() int {
	out := map[string]any{}
	fail := func(step string, err error) int {
		out["error"] = step + ": " + err.Error()
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
		return 1
	}
	src, err := newPhoneSource()
	if err != nil {
		return fail("źródło", err)
	}
	defer src.close()
	devs, err := src.devices()
	if err != nil {
		return fail("telefony", err)
	}
	out["devices"] = devs
	if len(devs) == 0 {
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
		return 0
	}
	start := time.Now()
	items, err := src.items(devs[0].ID)
	if err != nil {
		return fail("zdjęcia", err)
	}
	out["items"] = len(items)
	out["listMs"] = time.Since(start).Milliseconds()
	if len(items) > 0 {
		out["first"] = items[0]
		if b, err := src.thumb(items[0].ID, 320); err != nil {
			out["thumbError"] = err.Error()
		} else {
			out["thumbBytes"] = len(b)
		}
		dest := os.Getenv("OVERVNC_PHONE_DEST")
		if dest != "" {
			_ = os.MkdirAll(dest, 0o755)
			name, err := src.copyTo(items[0].ID, dest)
			out["copy"] = map[string]any{"name": name, "error": errString(err)}
			if len(items) > 1 {
				out["delete"] = map[string]any{"name": items[1].Name, "error": errString(src.remove(items[1].ID))}
			}
		}
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(b))
	return 0
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
