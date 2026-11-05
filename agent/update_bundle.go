package main

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Aktualizacja agenta na macOS jako pakiet aplikacji „OVERVNC Agent.app” (pl.overmedia.overvnc-agent).
// macOS zapamiętuje zgody i decyzje „Zezwól” dla aplikacji z identyfikatorem — dla gołego pliku pytał
// przy każdym połączeniu. Agent zainstalowany wcześniej jako /usr/local/bin/overvnc-agent przenosi się
// do pakietu sam (plik w /usr/local/bin staje się dowiązaniem, usługa launchd się nie zmienia).

// macAppDir — miejsce pakietu (zmienne w testach)
var macAppDir = "/Library/Application Support/OVERVNC"

const (
	macAppName = "OVERVNC Agent.app"
	macAppExe  = "Contents/MacOS/overvnc-agent"
	maxAppSize = 300 << 20
)

// bundleRoot — katalog .app, jeśli plik wykonywalny leży w pakiecie aplikacji; inaczej "".
func bundleRoot(exe string) string {
	i := strings.Index(exe, ".app/Contents/MacOS/")
	if i < 0 {
		return ""
	}
	return exe[:i+len(".app")]
}

// updateUnit — co podmienia aktualizacja: pakiet .app albo pojedynczy plik.
func updateUnit(exe string) string {
	if b := bundleRoot(exe); b != "" {
		return b
	}
	return exe
}

// needsBundleMigration — macOS, usługa systemowa, agent jeszcze jako zwykły plik.
func needsBundleMigration(exe string) bool {
	return runtime.GOOS == "darwin" && bundleRoot(exe) == "" && os.Geteuid() == 0
}

// installBundleUpdate pobiera zip z pakietem, rozpakowuje obok i podmienia pakiet atomowo (rename katalogu).
// Przy przenosinach z pojedynczego pliku zwraca jego ścieżkę (do ewentualnego wycofania).
func installBundleUpdate(ctx context.Context, cfg *Config, path string, file ManifestFile, exe, ver string) (plain string, err error) {
	target := bundleRoot(exe)
	if target == "" {
		target = filepath.Join(macAppDir, macAppName)
		plain = exe
	}
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", err
	}
	zipTmp := filepath.Join(parent, ".overvnc-update-"+ver+".zip")
	defer os.Remove(zipTmp)
	if err := downloadVerified(ctx, cfg, path, zipTmp, file); err != nil {
		return "", err
	}
	stage := filepath.Join(parent, ".overvnc-update-"+ver)
	_ = os.RemoveAll(stage)
	defer os.RemoveAll(stage)
	if err := extractApp(zipTmp, stage); err != nil {
		return "", err
	}
	fresh := filepath.Join(stage, macAppName)
	if fi, err := os.Stat(filepath.Join(fresh, macAppExe)); err != nil || fi.Mode()&0o111 == 0 {
		return "", errors.New("pakiet aktualizacji nie zawiera programu agenta")
	}

	old := target + ".old"
	_ = os.RemoveAll(old)
	hadOld := false
	if _, err := os.Stat(target); err == nil {
		if err := os.Rename(target, old); err != nil {
			return "", fmt.Errorf("nie można przenieść bieżącej wersji: %w", err)
		}
		hadOld = true
	}
	if err := os.Rename(fresh, target); err != nil {
		if hadOld {
			_ = os.Rename(old, target)
		}
		return "", fmt.Errorf("nie można zainstalować nowej wersji: %w", err)
	}
	if plain != "" {
		// /usr/local/bin/overvnc-agent → dowiązanie do programu w pakiecie (usługa launchd uruchamia tę ścieżkę)
		_ = os.Remove(plain + ".old")
		if err := os.Rename(plain, plain+".old"); err != nil {
			return "", fmt.Errorf("nie można przenieść poprzedniego pliku agenta: %w", err)
		}
		if err := os.Symlink(filepath.Join(target, macAppExe), plain); err != nil {
			_ = os.Rename(plain+".old", plain)
			return "", fmt.Errorf("nie można utworzyć dowiązania agenta: %w", err)
		}
	}
	return plain, nil
}

// extractApp rozpakowuje „OVERVNC Agent.app” z zipu do dst (bez wychodzenia poza katalog, bez dowiązań).
func extractApp(zipPath, dst string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("nieprawidłowy pakiet: %w", err)
	}
	defer r.Close()
	var total int64
	for _, f := range r.File {
		name := filepath.FromSlash(f.Name)
		if !strings.HasPrefix(f.Name, macAppName+"/") || strings.Contains(f.Name, "..") || filepath.IsAbs(name) {
			return fmt.Errorf("nieprawidłowa ścieżka w pakiecie: %q", f.Name)
		}
		p := filepath.Join(dst, name)
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 || !f.Mode().IsRegular() {
			return fmt.Errorf("nieobsługiwany element pakietu: %q", f.Name)
		}
		total += int64(f.UncompressedSize64)
		if total > maxAppSize {
			return errors.New("pakiet za duży")
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if f.Mode()&0o111 != 0 {
			mode = 0o755
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
		if err == nil {
			_, err = io.Copy(out, io.LimitReader(rc, maxAppSize))
			if cerr := out.Close(); err == nil {
				err = cerr
			}
		}
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// rollbackPlain — wycofanie przenosin do pakietu: przywraca poprzedni pojedynczy plik agenta.
func rollbackPlain(plain string) error {
	if _, err := os.Stat(plain + ".old"); err != nil {
		return err
	}
	if fi, err := os.Lstat(plain); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		_ = os.Remove(plain)
	}
	return os.Rename(plain+".old", plain)
}
