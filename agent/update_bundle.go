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

// macAppDir — miejsce pakietu: osobny, czytelny dla wszystkich folder. NIE folder konfiguracji
// (/Library/Application Support/OVERVNC), który jest zamknięty tylko dla roota (klucz agenta) —
// Ustawienia systemowe nie mogłyby wtedy odczytać aplikacji przy nadawaniu zgód.
// macLink — ścieżka uruchamiana przez usługę launchd (dowiązanie do programu w pakiecie). Zmienne w testach.
var (
	macAppDir = "/Library/Application Support/OVERVNC Agent"
	macLink   = "/usr/local/bin/overvnc-agent"
)

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

// needsBundleMigration — macOS, usługa systemowa, agent jeszcze jako zwykły plik albo pakiet
// w niewłaściwym miejscu (0.17.0 umieszczał go w zamkniętym folderze konfiguracji).
func needsBundleMigration(exe string) bool {
	return runtime.GOOS == "darwin" && os.Geteuid() == 0 && bundleRoot(exe) != filepath.Join(macAppDir, macAppName)
}

// installBundleUpdate pobiera zip z pakietem, rozpakowuje obok i podmienia pakiet atomowo (rename katalogu).
// Zwraca dane do ewentualnego wycofania: plain — pojedynczy plik sprzed przenosin do pakietu,
// prevLink — poprzedni cel dowiązania (pakiet w innym miejscu).
// relocate — usługa systemowa przenosi pakiet do macAppDir; inaczej pakiet aktualizowany jest na miejscu.
func installBundleUpdate(ctx context.Context, cfg *Config, path string, file ManifestFile, exe, ver string, relocate bool) (plain, prevLink string, err error) {
	target := filepath.Join(macAppDir, macAppName)
	cur := bundleRoot(exe)
	switch {
	case cur == "":
		plain = exe
	case !relocate:
		target = cur
	}
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", "", err
	}
	zipTmp := filepath.Join(parent, ".overvnc-update-"+ver+".zip")
	defer os.Remove(zipTmp)
	if err := downloadVerified(ctx, cfg, path, zipTmp, file); err != nil {
		return "", "", err
	}
	stage := filepath.Join(parent, ".overvnc-update-"+ver)
	_ = os.RemoveAll(stage)
	defer os.RemoveAll(stage)
	if err := extractApp(zipTmp, stage); err != nil {
		return "", "", err
	}
	fresh := filepath.Join(stage, macAppName)
	if fi, err := os.Stat(filepath.Join(fresh, macAppExe)); err != nil || fi.Mode()&0o111 == 0 {
		return "", "", errors.New("pakiet aktualizacji nie zawiera programu agenta")
	}

	old := target + ".old"
	_ = os.RemoveAll(old)
	hadOld := false
	if _, err := os.Stat(target); err == nil {
		if err := os.Rename(target, old); err != nil {
			return "", "", fmt.Errorf("nie można przenieść bieżącej wersji: %w", err)
		}
		hadOld = true
	}
	if err := os.Rename(fresh, target); err != nil {
		if hadOld {
			_ = os.Rename(old, target)
		}
		return "", "", fmt.Errorf("nie można zainstalować nowej wersji: %w", err)
	}
	if cur != "" && cur != target {
		// pakiet w innym miejscu (0.17.0) — przestawiamy dowiązanie; stary pakiet zostaje do wycofania
		if fi, err := os.Lstat(macLink); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			prevLink, _ = os.Readlink(macLink)
			if err := relink(filepath.Join(target, macAppExe), macLink); err != nil {
				return "", "", fmt.Errorf("nie można przestawić dowiązania agenta: %w", err)
			}
		}
	}
	if plain != "" {
		// /usr/local/bin/overvnc-agent → dowiązanie do programu w pakiecie (usługa launchd uruchamia tę ścieżkę)
		_ = os.Remove(plain + ".old")
		if err := os.Rename(plain, plain+".old"); err != nil {
			return "", "", fmt.Errorf("nie można przenieść poprzedniego pliku agenta: %w", err)
		}
		if err := os.Symlink(filepath.Join(target, macAppExe), plain); err != nil {
			_ = os.Rename(plain+".old", plain)
			return "", "", fmt.Errorf("nie można utworzyć dowiązania agenta: %w", err)
		}
	}
	return plain, prevLink, nil
}

// relink — atomowa podmiana dowiązania (nowe obok, potem rename na miejsce).
func relink(target, link string) error {
	tmp := link + ".new"
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	return os.Rename(tmp, link)
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
