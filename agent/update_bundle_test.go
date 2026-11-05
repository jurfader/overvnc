//go:build !windows

package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func appZip(t *testing.T, files map[string]string) ([]byte, ManifestFile) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		h.SetMode(0o755)
		w, _ := zw.CreateHeader(h)
		_, _ = w.Write([]byte(body))
	}
	_ = zw.Close()
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), ManifestFile{Name: "overvnc-agent-darwin-arm64-app.zip", Size: int64(buf.Len()), SHA256: hex.EncodeToString(sum[:])}
}

func serveBytes(t *testing.T, data []byte) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(data) }))
	t.Cleanup(srv.Close)
	setUpdateContext(&Config{ServerURL: srv.URL, AgentID: "a", AgentSecret: "b"}, "")
}

func TestBundleUpdateSwapsWholeApp(t *testing.T) {
	data, mf := appZip(t, map[string]string{
		macAppName + "/Contents/MacOS/overvnc-agent": "v2",
		macAppName + "/Contents/Info.plist":          "<plist/>",
	})
	serveBytes(t, data)
	root := t.TempDir()
	app := filepath.Join(root, macAppName)
	exe := filepath.Join(app, macAppExe)
	_ = os.MkdirAll(filepath.Dir(exe), 0o755)
	_ = os.WriteFile(exe, []byte("v1"), 0o755)
	plain, err := installBundleUpdate(context.Background(), updateCfg, "/x", mf, exe, "2.0.0")
	if err != nil || plain != "" {
		t.Fatalf("aktualizacja pakietu: %v %q", err, plain)
	}
	if b, _ := os.ReadFile(exe); string(b) != "v2" {
		t.Fatalf("nowa wersja: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(app+".old", macAppExe)); string(b) != "v1" {
		t.Fatal("brak kopii poprzedniej wersji")
	}
	if fi, _ := os.Stat(exe); fi.Mode()&0o111 == 0 {
		t.Fatal("program bez prawa wykonania")
	}
	if updateUnit(exe) != app {
		t.Fatalf("jednostka aktualizacji: %s", updateUnit(exe))
	}
}

func TestBundleMigrationFromPlainFileAndRollback(t *testing.T) {
	data, mf := appZip(t, map[string]string{macAppName + "/Contents/MacOS/overvnc-agent": "v2"})
	serveBytes(t, data)
	macAppDir = t.TempDir()
	t.Cleanup(func() { macAppDir = "/Library/Application Support/OVERVNC" })
	bin := filepath.Join(t.TempDir(), "overvnc-agent")
	_ = os.WriteFile(bin, []byte("v1"), 0o755)
	plain, err := installBundleUpdate(context.Background(), updateCfg, "/x", mf, bin, "2.0.0")
	if err != nil || plain != bin {
		t.Fatalf("przenosiny: %v %q", err, plain)
	}
	target, err := os.Readlink(bin)
	if err != nil || target != filepath.Join(macAppDir, macAppName, macAppExe) {
		t.Fatalf("dowiązanie: %q %v", target, err)
	}
	if b, _ := os.ReadFile(bin); string(b) != "v2" {
		t.Fatal("dowiązanie nie prowadzi do nowej wersji")
	}
	if err := rollbackPlain(bin); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(bin); string(b) != "v1" {
		t.Fatal("wycofanie nie przywróciło poprzedniego pliku")
	}
}

func TestExtractAppRejectsEscapes(t *testing.T) {
	for _, bad := range []string{"../evil", macAppName + "/../../evil", "/etc/passwd", "inny.app/Contents/MacOS/x"} {
		data, _ := appZip(t, map[string]string{bad: "x"})
		p := filepath.Join(t.TempDir(), "a.zip")
		_ = os.WriteFile(p, data, 0o644)
		if err := extractApp(p, t.TempDir()); err == nil {
			t.Fatalf("ścieżka %q powinna zostać odrzucona", bad)
		}
	}
}
