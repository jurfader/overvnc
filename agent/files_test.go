package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func call(t *testing.T, h handlerFunc, ctx context.Context, req any) (any, error) {
	t.Helper()
	raw, _ := json.Marshal(req)
	return h(ctx, raw)
}

func TestListDir(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("hello"), 0o644)
	os.WriteFile(filepath.Join(dir, "A.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, ".hidden"), nil, 0o644)
	os.Mkdir(filepath.Join(dir, "zeta"), 0o755)
	os.Symlink(filepath.Join(dir, "zeta"), filepath.Join(dir, "link-do-katalogu"))

	l, err := listDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range l.Entries {
		names = append(names, e.Name)
	}
	// katalogi (także przez link) najpierw, potem pliki alfabetycznie bez względu na wielkość liter
	want := []string{"link-do-katalogu", "zeta", ".hidden", "A.txt", "b.txt"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Errorf("kolejność: %v, oczekiwano %v", names, want)
	}
	byName := map[string]FileEntry{}
	for _, e := range l.Entries {
		byName[e.Name] = e
	}
	if !byName[".hidden"].Hidden || byName["b.txt"].Size != 5 || byName["b.txt"].Type != "file" {
		t.Errorf("metadane: %+v", byName)
	}
	if !byName["link-do-katalogu"].Link || byName["link-do-katalogu"].Type != "dir" {
		t.Errorf("link: %+v", byName["link-do-katalogu"])
	}
	if l.Parent != filepath.Dir(dir) {
		t.Errorf("parent: %s", l.Parent)
	}
	if _, err := listDir("relatywna/sciezka"); err == nil {
		t.Error("ścieżka względna musi być odrzucona")
	}
	if _, err := listDir(filepath.Join(dir, "nie-ma")); err == nil || !strings.Contains(err.Error(), "not_found") {
		t.Errorf("brak katalogu: %v", err)
	}
}

func TestMkdirRenameDelete(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	a := filepath.Join(dir, "nowy")
	if _, err := call(t, handleFsMkdir, ctx, map[string]string{"path": a}); err != nil {
		t.Fatal(err)
	}
	if _, err := call(t, handleFsMkdir, ctx, map[string]string{"path": a}); err == nil || !strings.Contains(err.Error(), "exists") {
		t.Errorf("duplikat katalogu: %v", err)
	}
	os.WriteFile(filepath.Join(a, "plik.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "inny.txt"), []byte("y"), 0o644)

	// rename nie nadpisuje istniejącego pliku
	if _, err := call(t, handleFsRename, ctx, map[string]string{"from": filepath.Join(a, "plik.txt"), "to": filepath.Join(dir, "inny.txt")}); err == nil {
		t.Error("rename nie może nadpisać istniejącego pliku")
	}
	b := filepath.Join(dir, "przeniesiony")
	if _, err := call(t, handleFsRename, ctx, map[string]string{"from": a, "to": b}); err != nil {
		t.Fatal(err)
	}
	// usuwanie rekurencyjne
	res, err := call(t, handleFsDelete, ctx, map[string]any{"paths": []string{b, filepath.Join(dir, "inny.txt")}})
	if err != nil || res.(map[string]int)["deleted"] != 2 {
		t.Fatalf("delete: %v %v", res, err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("zostało: %v", entries)
	}
}

func TestProtectedPaths(t *testing.T) {
	ctx := context.Background()
	root := "/"
	if v := filepath.VolumeName(os.TempDir()); v != "" {
		root = v + `\`
	}
	for _, p := range append([]string{root}, protectedPaths()...) {
		if _, err := call(t, handleFsDelete, ctx, map[string]any{"paths": []string{p}}); err == nil || !strings.Contains(err.Error(), "protected") {
			t.Errorf("%s powinien być chroniony: %v", p, err)
		}
	}
	// chroniona ścieżka na liście blokuje całą operację — nic nie zostaje usunięte
	dir := t.TempDir()
	f := filepath.Join(dir, "zostaje.txt")
	os.WriteFile(f, nil, 0o644)
	if _, err := call(t, handleFsDelete, ctx, map[string]any{"paths": []string{f, root}}); err == nil {
		t.Error("oczekiwano błędu")
	}
	if _, err := os.Stat(f); err != nil {
		t.Error("plik nie powinien zostać usunięty, gdy lista zawiera ścieżkę chronioną")
	}
}

func TestTextReadWrite(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	p := filepath.Join(dir, "konfig.ini")
	os.WriteFile(p, []byte("[sekcja]\nklucz=wartość\n"), 0o600)

	res, err := call(t, handleFsReadText, ctx, map[string]string{"path": p})
	if err != nil {
		t.Fatal(err)
	}
	r := res.(map[string]any)
	if r["content"] != "[sekcja]\nklucz=wartość\n" {
		t.Fatalf("treść: %v", r)
	}
	mod := r["modified"].(int64)

	// zapis z prawidłowym znacznikiem czasu
	if _, err := call(t, handleFsWriteText, ctx, map[string]any{"path": p, "content": "nowa", "expectedModified": mod}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "nowa" {
		t.Errorf("zapisano: %q", b)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 && os.PathSeparator == '/' {
		t.Errorf("uprawnienia nie zachowane: %v", fi.Mode().Perm())
	}
	// zapis ze starym znacznikiem — konflikt
	if _, err := call(t, handleFsWriteText, ctx, map[string]any{"path": p, "content": "nadpisanie", "expectedModified": mod - 1000}); err == nil || !strings.Contains(err.Error(), "conflict") {
		t.Errorf("oczekiwano konfliktu: %v", err)
	}
	// plik binarny i za duży
	bin := filepath.Join(dir, "a.bin")
	os.WriteFile(bin, []byte{0x7f, 'E', 'L', 'F', 0, 1, 2}, 0o644)
	res, _ = call(t, handleFsReadText, ctx, map[string]string{"path": bin})
	if res.(map[string]any)["binary"] != true {
		t.Errorf("binarny: %v", res)
	}
	big := filepath.Join(dir, "duzy.log")
	os.WriteFile(big, bytes.Repeat([]byte("a"), maxTextSize+1), 0o644)
	res, _ = call(t, handleFsReadText, ctx, map[string]string{"path": big})
	if res.(map[string]any)["tooLarge"] != true {
		t.Errorf("za duży: %v", res)
	}
	// brak pozostałości plików tymczasowych
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".overvnc-") {
			t.Errorf("pozostał plik tymczasowy: %s", e.Name())
		}
	}
}

// testSession zbiera ramki i zdarzenia jak połączenie z serwerem.
type testSession struct {
	*sessionIO
	mu     sync.Mutex
	data   bytes.Buffer
	acks   int
	events chan map[string]any
}

func newTestSession(autoAck bool) *testSession {
	ts := &testSession{events: make(chan map[string]any, 4)}
	ts.sessionIO = &sessionIO{channels: newChannelManager()}
	ts.writeBinary = func(b []byte) error {
		kind, ch, payload, _ := decodeFrame(b)
		ts.mu.Lock()
		if kind == frameData {
			ts.data.Write(payload)
		} else {
			ts.acks += int(payload[0])<<24 | int(payload[1])<<16 | int(payload[2])<<8 | int(payload[3])
		}
		ts.mu.Unlock()
		if autoAck && kind == frameData {
			go ts.channels.handleFrame(encodeAck(ch, len(payload)))
		}
		return nil
	}
	ts.event = func(typ string, d any) error {
		if typ == "channel.closed" {
			ts.events <- d.(map[string]any)
		}
		return nil
	}
	return ts
}

func (ts *testSession) received() int {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return ts.data.Len()
}

func TestDownloadFlowControl(t *testing.T) {
	dir := t.TempDir()
	content := make([]byte, 5<<20+123)
	rand.Read(content)
	p := filepath.Join(dir, "duzy.bin")
	os.WriteFile(p, content, 0o644)

	// bez potwierdzeń agent wysyła dokładnie okno i czeka
	ts := newTestSession(false)
	ctx := withSession(context.Background(), ts.sessionIO)
	res, err := call(t, handleFsRead, ctx, map[string]any{"channel": 1, "path": p})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["size"].(int64) != int64(len(content)) {
		t.Errorf("rozmiar: %v", res)
	}
	time.Sleep(200 * time.Millisecond)
	if got := ts.received(); got != flowWindow {
		t.Fatalf("bez potwierdzeń wysłano %d bajtów, oczekiwano dokładnie okna %d", got, flowWindow)
	}
	// zamknięcie przez serwer przerywa nadawanie bez zdarzenia
	ts.channels.remove(1).close()
	select {
	case ev := <-ts.events:
		t.Errorf("nieoczekiwane zdarzenie po przerwaniu: %v", ev)
	case <-time.After(100 * time.Millisecond):
	}

	// z potwierdzeniami — całość, zgodna bajt w bajt
	ts = newTestSession(true)
	ctx = withSession(context.Background(), ts.sessionIO)
	if _, err := call(t, handleFsRead, ctx, map[string]any{"channel": 2, "path": p}); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-ts.events:
		if ev["exitCode"] != 0 || ev["bytes"].(int64) != int64(len(content)) {
			t.Errorf("zdarzenie: %v", ev)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("brak końca pobierania")
	}
	ts.mu.Lock()
	ok := bytes.Equal(ts.data.Bytes(), content)
	ts.mu.Unlock()
	if !ok {
		t.Error("pobrana zawartość różni się od pliku")
	}
}

func TestDownloadDirectoryAsZip(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "projekt")
	os.MkdirAll(filepath.Join(src, "pod"), 0o755)
	os.WriteFile(filepath.Join(src, "a.txt"), []byte("AAA"), 0o644)
	os.WriteFile(filepath.Join(src, "pod", "b.txt"), []byte("BBB"), 0o644)

	ts := newTestSession(true)
	ctx := withSession(context.Background(), ts.sessionIO)
	res, err := call(t, handleFsRead, ctx, map[string]any{"channel": 3, "path": src})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["name"] != "projekt.zip" {
		t.Errorf("nazwa: %v", res)
	}
	<-ts.events
	ts.mu.Lock()
	zr, err := zip.NewReader(bytes.NewReader(ts.data.Bytes()), int64(ts.data.Len()))
	ts.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	var files []string
	for _, f := range zr.File {
		if !strings.HasSuffix(f.Name, "/") {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			files = append(files, f.Name+"="+string(b))
		}
	}
	sort.Strings(files)
	if strings.Join(files, ",") != "projekt/a.txt=AAA,projekt/pod/b.txt=BBB" {
		t.Errorf("zawartość zip: %v", files)
	}
}

func TestUploadCommitAndAbort(t *testing.T) {
	dir := t.TempDir()
	ts := newTestSession(false)
	ctx := withSession(context.Background(), ts.sessionIO)
	payload := make([]byte, 300_000)
	rand.Read(payload)

	if _, err := call(t, handleFsWrite, ctx, map[string]any{"channel": 5, "dir": dir, "name": "raport.pdf", "size": len(payload)}); err != nil {
		t.Fatal(err)
	}
	for off := 0; off < len(payload); off += chunkSize {
		ts.channels.handleFrame(encodeFrame(frameData, 5, payload[off:min(off+chunkSize, len(payload))]))
	}
	res, err := call(t, handleFsCommit, ctx, map[string]any{"channel": 5, "size": len(payload)})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "raport.pdf")); !bytes.Equal(got, payload) {
		t.Error("zapisany plik różni się od wysłanego")
	}
	// ostatnie potwierdzenie może dotrzeć tuż po zatwierdzeniu — czekamy chwilę
	deadline := time.Now().Add(2 * time.Second)
	for {
		ts.mu.Lock()
		acks := ts.acks
		ts.mu.Unlock()
		if acks == len(payload) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("potwierdzono %d z %d bajtów", acks, len(payload))
		}
		time.Sleep(5 * time.Millisecond)
	}
	_ = res

	// istniejący plik bez overwrite — odmowa; z overwrite — OK
	if _, err := call(t, handleFsWrite, ctx, map[string]any{"channel": 6, "dir": dir, "name": "raport.pdf", "size": 1}); err == nil || !strings.Contains(err.Error(), "exists") {
		t.Errorf("oczekiwano exists: %v", err)
	}
	// przerwane wysyłanie — plik tymczasowy znika, cel nie powstaje
	if _, err := call(t, handleFsWrite, ctx, map[string]any{"channel": 7, "dir": dir, "name": "przerwany.iso", "size": 1000}); err != nil {
		t.Fatal(err)
	}
	ts.channels.handleFrame(encodeFrame(frameData, 7, make([]byte, 100)))
	time.Sleep(50 * time.Millisecond)
	ts.channels.remove(7).close()
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != "raport.pdf" {
		var n []string
		for _, e := range entries {
			n = append(n, e.Name())
		}
		t.Errorf("po przerwaniu w katalogu: %v", n)
	}
	// nazwa z separatorem / ".." — odrzucona
	for _, bad := range []string{"../ucieczka", "a/b", "..", ""} {
		if _, err := call(t, handleFsWrite, ctx, map[string]any{"channel": 8, "dir": dir, "name": bad, "size": 1}); err == nil {
			t.Errorf("nazwa %q powinna być odrzucona", bad)
		}
	}
}

func TestFsRoots(t *testing.T) {
	roots := fsRoots(context.Background())
	if len(roots) == 0 || roots[0].Kind != "drive" {
		t.Fatalf("roots: %+v", roots)
	}
}
