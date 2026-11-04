// OVERVNC Agent — instalowany na zarządzanych komputerach.
//
// Użycie:
//
//	overvnc-agent install --server https://overvnc.example.com --token ovnc_XXXX   (rejestracja + usługa systemowa)
//	overvnc-agent install --server ... --token ... --defer   (obraz ISO: rejestracja przy pierwszym uruchomieniu)
//	overvnc-agent uninstall [--purge]
//	overvnc-agent run                       (tryb pierwszoplanowy; tak też uruchamia go usługa)
//	overvnc-agent enroll --server ... --token ...   (tylko rejestracja, bez usługi)
//	overvnc-agent start | stop | status | version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/kardianos/service"
)

var version = "0.7.0-dev" // nadpisywane przy budowaniu: -ldflags "-X main.version=..."

const serviceName = "overvnc-agent"

var logger service.Logger = consoleLogger{}

type program struct {
	cfgPath string
	cancel  context.CancelFunc
	done    chan struct{}
}

func (p *program) Start(s service.Service) error {
	cfg, err := loadConfig(p.cfgPath)
	if err != nil {
		return fmt.Errorf("brak konfiguracji (%s) — najpierw uruchom 'enroll' lub 'install': %w", p.cfgPath, err)
	}
	// po aktualizacji: jeśli nowa wersja wielokrotnie nie wstała, wróć do poprzedniej
	checkUpdateRollback(p.cfgPath)
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.done = make(chan struct{})
	go func() {
		defer close(p.done)
		if !ensureIdentity(ctx, p.cfgPath, cfg) {
			return
		}
		runAgent(ctx, p.cfgPath, cfg)
	}()
	return nil
}

func (p *program) Stop(s service.Service) error {
	if p.cancel != nil {
		p.cancel()
		<-p.done
	}
	return nil
}

func newService(cfgPath string) (service.Service, *program, error) {
	prg := &program{cfgPath: cfgPath}
	svc, err := service.New(prg, &service.Config{
		Name:        serviceName,
		DisplayName: "OVERVNC Agent",
		Description: "Agent zdalnego zarządzania OVERVNC (monitoring, zdalna pomoc).",
		Arguments:   []string{"run", "--config", cfgPath},
		Option: service.KeyValue{
			"LogOutput":        true, // macOS/launchd: logi do /usr/local/var/log
			"Restart":          "always",
			"OnFailure":        "restart",
			"DelayedAutoStart": false,
		},
	})
	return svc, prg, err
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfigPath(), "ścieżka pliku konfiguracyjnego")
	serverURL := fs.String("server", "", "adres serwera, np. https://overvnc.example.com")
	token := fs.String("token", "", "token rejestracji z panelu")
	insecure := fs.Bool("insecure", false, "zezwól na nieszyfrowane http:// (TYLKO do testów)")
	purge := fs.Bool("purge", false, "uninstall: usuń także konfigurację")
	forceUpdates := fs.Bool("updates", false, "run: włącz automatyczne aktualizacje także poza usługą (testy)")
	deferEnroll := fs.Bool("defer", false, "zapisz tylko token — komputer zarejestruje się sam przy pierwszym uruchomieniu usługi (obraz ISO)")
	_ = fs.Parse(os.Args[2:])

	abs, err := filepath.Abs(*cfgPath)
	if err == nil {
		*cfgPath = abs
	}

	switch cmd {
	case "version":
		fmt.Println(version)

	case "desktop-helper":
		// proces pomocniczy pulpitu zdalnego — uruchamiany przez usługę w sesji użytkownika
		if fs.Arg(0) == "snapshot" {
			maxW, _ := strconv.Atoi(fs.Arg(1))
			os.Exit(runDesktopSnapshot(maxW))
		}
		os.Exit(runDesktopHelper())

	case "enroll":
		must(enroll(*cfgPath, *serverURL, *token, *insecure, *deferEnroll))
		fmt.Println("Zapisano konfigurację:", *cfgPath)

	case "install":
		requireAdmin()
		if _, err := loadConfig(*cfgPath); err == nil {
			fmt.Println("Agent już skonfigurowany — pomijam rejestrację.")
		} else if *deferEnroll {
			must(enroll(*cfgPath, *serverURL, *token, *insecure, true))
			fmt.Println("Zapisano token — komputer zarejestruje się sam przy pierwszym uruchomieniu usługi.")
		} else if err := enroll(*cfgPath, *serverURL, *token, *insecure, false); err != nil {
			if errors.Is(err, errEnrollRejected) || *serverURL == "" || *token == "" {
				must(err)
			}
			// brak sieci przy instalacji nie przerywa jej — usługa zarejestruje komputer, gdy połączenie wróci
			must(enroll(*cfgPath, *serverURL, *token, *insecure, true))
			fmt.Println("Serwer niedostępny (", err, ") — komputer zarejestruje się automatycznie po połączeniu.")
		} else {
			fmt.Println("Zarejestrowano w serwerze.")
		}
		svc, _, err := newService(*cfgPath)
		must(err)
		must(svc.Install())
		must(svc.Start())
		fmt.Println("Usługa zainstalowana i uruchomiona.")

	case "uninstall":
		requireAdmin()
		svc, _, err := newService(*cfgPath)
		must(err)
		_ = svc.Stop()
		must(svc.Uninstall())
		if *purge {
			_ = os.Remove(*cfgPath)
		}
		fmt.Println("Usługa usunięta.")

	case "start", "stop", "restart":
		requireAdmin()
		svc, _, err := newService(*cfgPath)
		must(err)
		must(service.Control(svc, cmd))

	case "status":
		svc, _, err := newService(*cfgPath)
		must(err)
		st, err := svc.Status()
		must(err)
		fmt.Println(map[service.Status]string{service.StatusRunning: "działa", service.StatusStopped: "zatrzymana"}[st])

	case "run":
		svc, _, err := newService(*cfgPath)
		must(err)
		if !service.Interactive() {
			if l, err := svc.Logger(nil); err == nil {
				logger = l
			}
			updatesEnabled = true // tylko usługa systemowa może podmienić binarkę i zostać uruchomiona ponownie
		}
		if *forceUpdates {
			updatesEnabled = true
		}
		must(svc.Run())

	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `OVERVNC Agent %s

  install   --server URL --token TOKEN   rejestracja i instalacja usługi (wymaga admina/roota)
            [--defer]                    obraz ISO/sysprep: rejestracja przy pierwszym uruchomieniu
  uninstall [--purge]                    usunięcie usługi
  run                                    uruchomienie w trybie pierwszoplanowym
  enroll    --server URL --token TOKEN   tylko rejestracja
  start | stop | restart | status | version

Wspólna opcja: --config ŚCIEŻKA (domyślnie %s)
`, version, defaultConfigPath())
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "Błąd:", err)
		os.Exit(1)
	}
}

// consoleLogger używany w trybie interaktywnym.
type consoleLogger struct{}

func (consoleLogger) Error(v ...interface{}) error {
	fmt.Fprintln(os.Stderr, append([]any{"[ERR]"}, v...)...)
	return nil
}
func (consoleLogger) Warning(v ...interface{}) error {
	fmt.Fprintln(os.Stderr, append([]any{"[WARN]"}, v...)...)
	return nil
}
func (consoleLogger) Info(v ...interface{}) error { fmt.Fprintln(os.Stderr, v...); return nil }
func (c consoleLogger) Errorf(f string, a ...interface{}) error {
	return c.Error(fmt.Sprintf(f, a...))
}
func (c consoleLogger) Warningf(f string, a ...interface{}) error {
	return c.Warning(fmt.Sprintf(f, a...))
}
func (c consoleLogger) Infof(f string, a ...interface{}) error { return c.Info(fmt.Sprintf(f, a...)) }
