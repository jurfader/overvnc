package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	maxListEntries = 5000
	maxTextSize    = 1 << 20 // podgląd/edycja tekstu do 1 MB
)

type FileEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Type     string `json:"type"` // dir | file | other
	Link     bool   `json:"link,omitempty"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"` // ms od epoki
	Mode     string `json:"mode"`
	Hidden   bool   `json:"hidden,omitempty"`
}

type DirListing struct {
	Path      string      `json:"path"`
	Parent    string      `json:"parent,omitempty"`
	Entries   []FileEntry `json:"entries"`
	Truncated bool        `json:"truncated,omitempty"`
}

type FsRoot struct {
	Path  string `json:"path"`
	Label string `json:"label"`
	Total uint64 `json:"total,omitempty"`
	Free  uint64 `json:"free,omitempty"`
	Kind  string `json:"kind"` // drive | shortcut
}

// cleanPath — wymagamy ścieżek bezwzględnych; Clean usuwa "..", podwójne separatory itp.
func cleanPath(p string) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) {
		return "", protoErr("bad_path", "pusta lub nieprawidłowa ścieżka")
	}
	p = filepath.Clean(p)
	if !filepath.IsAbs(p) {
		return "", protoErr("bad_path", "ścieżka musi być bezwzględna: %s", p)
	}
	return p, nil
}

// validName — nazwa pojedynczego elementu (bez separatorów, nie "." ani "..").
func validName(n string) bool {
	return n != "" && n != "." && n != ".." && !strings.ContainsAny(n, `/\`) && !strings.ContainsRune(n, 0) && len(n) <= 255
}

// fsErr tłumaczy typowe błędy systemu plików na czytelne komunikaty.
func fsErr(err error, path string) error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return protoErr("not_found", "nie istnieje: %s", path)
	case errors.Is(err, fs.ErrPermission):
		return protoErr("permission", "brak dostępu: %s", path)
	case errors.Is(err, fs.ErrExist):
		return protoErr("exists", "już istnieje: %s", path)
	}
	return protoErr("fs_error", "%s: %v", path, err)
}

func entryFor(dir string, name string) (FileEntry, bool) {
	full := filepath.Join(dir, name)
	li, err := os.Lstat(full)
	if err != nil {
		return FileEntry{}, false
	}
	e := FileEntry{Name: name, Path: full, Type: "file", Size: li.Size(), Modified: li.ModTime().UnixMilli(), Mode: li.Mode().String(), Hidden: isHidden(name, li)}
	fi := li
	if li.Mode()&fs.ModeSymlink != 0 {
		e.Link = true
		if target, err := os.Stat(full); err == nil {
			fi = target
			e.Size = target.Size()
		}
	}
	switch {
	case fi.IsDir():
		e.Type, e.Size = "dir", 0
	case !fi.Mode().IsRegular() && !e.Link:
		e.Type = "other"
	}
	return e, true
}

func listDir(path string) (DirListing, error) {
	path, err := cleanPath(path)
	if err != nil {
		return DirListing{}, err
	}
	des, err := os.ReadDir(path)
	if err != nil {
		return DirListing{}, fsErr(err, path)
	}
	out := DirListing{Path: path, Entries: make([]FileEntry, 0, min(len(des), maxListEntries))}
	if parent := filepath.Dir(path); parent != path {
		out.Parent = parent
	}
	for _, d := range des {
		if len(out.Entries) >= maxListEntries {
			out.Truncated = true
			break
		}
		if e, ok := entryFor(path, d.Name()); ok {
			out.Entries = append(out.Entries, e)
		}
	}
	sort.SliceStable(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		if (a.Type == "dir") != (b.Type == "dir") {
			return a.Type == "dir"
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return out, nil
}

// assertNotProtected — katalogów krytycznych dla systemu nie usuwamy ani nie przenosimy zdalnie.
func assertNotProtected(path string) error {
	norm := strings.TrimRight(strings.ToLower(filepath.Clean(path)), `\/`)
	if norm == "" || filepath.Dir(path) == path {
		return protoErr("protected", "nie można usunąć ani przenieść katalogu głównego dysku")
	}
	for _, p := range protectedPaths() {
		if norm == strings.TrimRight(strings.ToLower(p), `\/`) {
			return protoErr("protected", "%s to katalog systemowy — operacja zablokowana", path)
		}
	}
	return nil
}

// isText — bez bajtów zerowych i poprawne UTF-8 (z tolerancją uciętego znaku na końcu).
func isText(b []byte) bool {
	if bytes.IndexByte(b, 0) >= 0 {
		return false
	}
	if utf8.Valid(b) {
		return true
	}
	for i := 1; i <= 3 && i < len(b); i++ {
		if utf8.Valid(b[:len(b)-i]) {
			return true
		}
	}
	return false
}

// ---------- handlery ----------

func decode[T any](data json.RawMessage) (T, error) {
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		return v, protoErr("bad_request", "nieprawidłowe żądanie")
	}
	return v, nil
}

func handleFsRoots(ctx context.Context, _ json.RawMessage) (any, error) {
	return fsRoots(ctx), nil
}

func handleFsList(_ context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		Path string `json:"path"`
	}](data)
	if err != nil {
		return nil, err
	}
	return listDir(req.Path)
}

func handleFsMkdir(_ context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		Path string `json:"path"`
	}](data)
	if err != nil {
		return nil, err
	}
	p, err := cleanPath(req.Path)
	if err != nil {
		return nil, err
	}
	if err := os.Mkdir(p, 0o755); err != nil {
		return nil, fsErr(err, p)
	}
	return map[string]string{"path": p}, nil
}

func handleFsRename(_ context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		From string `json:"from"`
		To   string `json:"to"`
	}](data)
	if err != nil {
		return nil, err
	}
	from, err := cleanPath(req.From)
	if err != nil {
		return nil, err
	}
	to, err := cleanPath(req.To)
	if err != nil {
		return nil, err
	}
	if err := assertNotProtected(from); err != nil {
		return nil, err
	}
	// rename nadpisałby cel bez pytania — sprawdzamy (z wyjątkiem zmiany samej wielkości liter)
	if _, err := os.Lstat(to); err == nil && !strings.EqualFold(from, to) {
		return nil, protoErr("exists", "już istnieje: %s", to)
	}
	if err := os.Rename(from, to); err != nil {
		return nil, fsErr(err, from)
	}
	return map[string]string{"path": to}, nil
}

func handleFsDelete(_ context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		Paths []string `json:"paths"`
	}](data)
	if err != nil || len(req.Paths) == 0 || len(req.Paths) > 1000 {
		return nil, protoErr("bad_request", "nieprawidłowa lista ścieżek")
	}
	// najpierw walidacja wszystkich — nie usuwamy połowy, gdy dalsza ścieżka jest chroniona
	paths := make([]string, 0, len(req.Paths))
	for _, raw := range req.Paths {
		p, err := cleanPath(raw)
		if err != nil {
			return nil, err
		}
		if err := assertNotProtected(p); err != nil {
			return nil, err
		}
		paths = append(paths, p)
	}
	deleted := 0
	for _, p := range paths {
		li, err := os.Lstat(p)
		if err != nil {
			return map[string]int{"deleted": deleted}, fsErr(err, p)
		}
		if li.IsDir() {
			err = os.RemoveAll(p)
		} else {
			err = os.Remove(p)
		}
		if err != nil {
			return map[string]int{"deleted": deleted}, fsErr(err, p)
		}
		deleted++
	}
	return map[string]int{"deleted": deleted}, nil
}

func handleFsReadText(_ context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		Path string `json:"path"`
	}](data)
	if err != nil {
		return nil, err
	}
	p, err := cleanPath(req.Path)
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(p)
	if err != nil {
		return nil, fsErr(err, p)
	}
	if fi.IsDir() {
		return nil, protoErr("is_dir", "to jest katalog")
	}
	res := map[string]any{"path": p, "size": fi.Size(), "modified": fi.ModTime().UnixMilli()}
	if fi.Size() > maxTextSize {
		res["tooLarge"] = true
		return res, nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, fsErr(err, p)
	}
	if !isText(b) {
		res["binary"] = true
		return res, nil
	}
	res["content"] = string(b)
	return res, nil
}

func handleFsWriteText(_ context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		Path             string `json:"path"`
		Content          string `json:"content"`
		ExpectedModified int64  `json:"expectedModified"`
	}](data)
	if err != nil {
		return nil, err
	}
	p, err := cleanPath(req.Path)
	if err != nil {
		return nil, err
	}
	if len(req.Content) > maxTextSize {
		return nil, protoErr("too_large", "plik przekracza 1 MB")
	}
	mode := fs.FileMode(0o644)
	if fi, err := os.Stat(p); err == nil {
		if fi.IsDir() {
			return nil, protoErr("is_dir", "to jest katalog")
		}
		// ktoś zmienił plik od otwarcia w edytorze — nie nadpisujemy jego zmian
		if req.ExpectedModified != 0 && fi.ModTime().UnixMilli() != req.ExpectedModified {
			return nil, protoErr("conflict", "plik został zmieniony na komputerze od czasu otwarcia")
		}
		mode = fi.Mode().Perm()
	}
	// zapis atomowy: plik tymczasowy w tym samym katalogu + rename
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".overvnc-*")
	if err != nil {
		return nil, fsErr(err, p)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(req.Content); err != nil {
		tmp.Close()
		return nil, fsErr(err, p)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return nil, fsErr(err, p)
	}
	tmp.Close()
	_ = os.Chmod(tmp.Name(), mode)
	if err := os.Rename(tmp.Name(), p); err != nil {
		return nil, fsErr(err, p)
	}
	fi, _ := os.Stat(p)
	return map[string]any{"path": p, "size": fi.Size(), "modified": fi.ModTime().UnixMilli()}, nil
}

func init() {
	handlers["fs.roots"] = handleFsRoots
	handlers["fs.list"] = handleFsList
	handlers["fs.mkdir"] = handleFsMkdir
	handlers["fs.rename"] = handleFsRename
	handlers["fs.delete"] = handleFsDelete
	handlers["fs.readText"] = handleFsReadText
	handlers["fs.writeText"] = handleFsWriteText
}
