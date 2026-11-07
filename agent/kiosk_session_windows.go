package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Usługa agenta na kiosku: przyjmuje „Zakończ i usuń moje dane” od klienta (kanał nazwany dostępny tylko
// dla zalogowanego interaktywnie użytkownika), usuwa Pobrane i restartuje — UWF odrzuca wszystkie zmiany.
// Pilnuje też, żeby przycisk działał w sesji klienta (nigdy na koncie administratora, np. „Serwis”).

func runKioskSession(ctx context.Context) {
	go runKioskPipe(ctx)
	var btn windows.Handle
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		p := currentProfile()
		want := p.Kiosk && p.EndButton && !consoleUserIsAdmin()
		running := processRunning(btn)
		switch {
		case want && !running:
			if btn != 0 {
				windows.CloseHandle(btn)
				btn = 0
			}
			if h, err := startAsConsoleUser("session-button"); err == nil {
				btn = h
			}
		case !want && running:
			_ = windows.TerminateProcess(btn, 0)
		}
	}
}

// consoleUserIsAdmin — przy komputerze siedzi ktoś z grupy Administratorzy (obsługa, serwis);
// także bez podniesionych uprawnień (grupa „tylko do odmowy” w tokenie UAC).
func consoleUserIsAdmin() bool {
	sid, err := targetSession()
	if err != nil {
		return true // nikt nie jest zalogowany — nie ma komu pokazywać przycisku
	}
	var tok windows.Token
	if windows.WTSQueryUserToken(sid, &tok) != nil {
		return true
	}
	defer tok.Close()
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return false
	}
	groups, err := tok.GetTokenGroups()
	if err != nil {
		return false
	}
	for _, g := range groups.AllGroups() {
		if windows.EqualSid(g.Sid, admins) {
			return true
		}
	}
	return false
}

func runKioskPipe(ctx context.Context) {
	// SYSTEM: pełny dostęp; IU (zalogowani interaktywnie): odczyt i zapis. Bez klientów z sieci.
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GRGW;;;IU)")
	if err != nil {
		logger.Warningf("kiosk: kanał: %v", err)
		return
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	name, _ := windows.UTF16PtrFromString(kioskPipe)
	for ctx.Err() == nil {
		h, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX,
			windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS,
			windows.PIPE_UNLIMITED_INSTANCES, 512, 512, 0, &sa)
		if err != nil {
			logger.Warningf("kiosk: kanał: %v", err)
			time.Sleep(30 * time.Second)
			continue
		}
		if err := windows.ConnectNamedPipe(h, nil); err != nil && err != windows.ERROR_PIPE_CONNECTED {
			windows.CloseHandle(h)
			continue
		}
		go serveKioskPipe(h)
	}
}

func serveKioskPipe(h windows.Handle) {
	f := os.NewFile(uintptr(h), "kiosk-pipe")
	defer f.Close()
	buf := make([]byte, 64)
	n, _ := f.Read(buf)
	cmd := strings.TrimSpace(string(buf[:n]))
	reply := "error: nieznane polecenie"
	if cmd == "cleanup" {
		if err := startKioskCleanup(); err != nil {
			reply = "error: " + err.Error()
		} else {
			reply = "ok"
		}
	}
	_, _ = f.Write([]byte(reply + "\n"))
	_ = windows.FlushFileBuffers(h)
	_ = windows.DisconnectNamedPipe(h)
}

var kioskCleanup struct {
	mu   sync.Mutex
	last time.Time
}

// startKioskCleanup — usunięcie Pobranych klienta i restart (po krótkiej chwili na odpowiedź i wpis w dzienniku).
func startKioskCleanup() error {
	p := currentProfile()
	if !p.Kiosk || !p.EndButton {
		return fmt.Errorf("funkcja jest wyłączona na tym komputerze")
	}
	if consoleUserIsAdmin() {
		return fmt.Errorf("przy komputerze zalogowane jest konto serwisowe — czyszczenie działa tylko dla klienta")
	}
	kioskCleanup.mu.Lock()
	defer kioskCleanup.mu.Unlock()
	if time.Since(kioskCleanup.last) < 3*time.Minute {
		return nil // czyszczenie już trwa
	}
	kioskCleanup.last = time.Now()

	downloads := ""
	if sid, err := targetSession(); err == nil {
		var tok windows.Token
		if windows.WTSQueryUserToken(sid, &tok) == nil {
			if dir, err := tok.GetUserProfileDirectory(); err == nil {
				downloads = filepath.Join(dir, "Downloads")
			}
			tok.Close()
		}
	}
	uwf := false
	if st := collectWinStatus(context.Background()); st != nil && st.UWF != nil {
		uwf = st.UWF.Enabled
	}
	updating := fileExists(`C:\Kiosk\Stan\aktualizacje.json`) // trwają aktualizacje kiosku — bez restartu
	logger.Infof("kiosk: klient kończy sesję — usuwam dane (UWF: %v)", uwf)
	reportAgentEvent("kiosk.session_end", map[string]any{"uwf": uwf, "restart": !updating})

	go func() {
		// Pobrane — także bez UWF (np. w trybie serwisowym) nic po kliencie nie zostaje
		if downloads != "" {
			if ents, err := os.ReadDir(downloads); err == nil {
				for _, e := range ents {
					if !strings.EqualFold(e.Name(), "desktop.ini") {
						_ = os.RemoveAll(filepath.Join(downloads, e.Name()))
					}
				}
			}
		}
		if updating {
			return
		}
		time.Sleep(2 * time.Second) // wpis do serwera i odpowiedź dla przycisku
		_ = exec.Command(filepath.Join(os.Getenv("SystemRoot"), `System32\shutdown.exe`), "/r", "/t", "5", "/d", "p:0:0",
			"/c", "Usuwam dane klienta — komputer uruchomi się ponownie.").Run()
	}()
	return nil
}
