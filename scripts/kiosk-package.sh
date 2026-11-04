#!/usr/bin/env bash
# Paczka OVERVNC do obrazu Windows (ISO kiosku).
# Użycie: scripts/kiosk-package.sh <adres serwera https://...> <token rejestracji> <wersja> [arch: amd64|arm64]
# Wynik: dist/overvnc-kiosk/ — skopiuj do obrazu wg README-ISO.txt.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${1:?adres serwera}"; TOKEN="${2:?token rejestracji}"; VERSION="${3:?wersja, np. 0.6.0}"; ARCH="${4:-amd64}"
[[ "$SERVER" == https://* ]] || { echo "Adres serwera musi zaczynać się od https://"; exit 1; }
[[ "$TOKEN" == ovnc_* ]] || { echo "Nieprawidłowy token (oczekiwano ovnc_...)"; exit 1; }
OUT="$ROOT/dist/overvnc-kiosk"
rm -rf "$OUT" && mkdir -p "$OUT"

(cd "$ROOT/agent" && CGO_ENABLED=0 GOOS=windows GOARCH="$ARCH" go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$OUT/overvnc-agent.exe" .)

crlf() { sed 's/$/\r/' > "$1"; }

crlf "$OUT/install-overvnc.cmd" <<CMD
@echo off
rem OVERVNC ${VERSION} - instalacja agenta (SetupComplete.cmd / NTLite Post-Setup / recznie jako administrator).
rem Komputer zarejestruje sie sam przy pierwszym polaczeniu z siecia (--defer) - kazdy z wlasna tozsamoscia.
setlocal
set "SRC=%~dp0"
set "DEST=%ProgramFiles%\\OVERVNC"
set "LOG=%SystemRoot%\\Temp\\overvnc-install.log"
echo [%date% %time%] Instalacja OVERVNC ${VERSION} >> "%LOG%"
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%SRC%overvnc-agent.exe" "%DEST%\\overvnc-agent.exe" >> "%LOG%" 2>&1
"%DEST%\\overvnc-agent.exe" install --defer --server "${SERVER}" --token "${TOKEN}" >> "%LOG%" 2>&1
echo [%date% %time%] Kod wyjscia: %errorlevel% >> "%LOG%"
exit /b 0
CMD

crlf "$OUT/uninstall-overvnc.cmd" <<'CMD'
@echo off
rem OVERVNC - odinstalowanie agenta (jako administrator).
"%ProgramFiles%\OVERVNC\overvnc-agent.exe" uninstall --purge
rmdir /S /Q "%ProgramFiles%\OVERVNC"
CMD

crlf "$OUT/SetupComplete.cmd" <<'CMD'
@echo off
rem Windows uruchamia ten plik jako SYSTEM na koncu instalacji (C:\Windows\Setup\Scripts\SetupComplete.cmd).
rem Jesli w obrazie jest juz wlasny SetupComplete.cmd - dopisz do niego tylko ponizsza linie.
call "%~dp0OVERVNC\install-overvnc.cmd"
CMD

crlf "$OUT/README-ISO.txt" <<TXT
OVERVNC ${VERSION} - agent do obrazu Windows (kiosk)
=====================================================

Serwer:  ${SERVER}
Token:   ${TOKEN:0:12}... (wielokrotnego uzytku - zarzadzasz nim w panelu: Dodaj komputer)

Co robi instalacja
- kopiuje agenta do C:\\Program Files\\OVERVNC i instaluje usluge "OVERVNC Agent" (start automatyczny),
- NIE rejestruje komputera od razu: kazdy komputer z obrazu rejestruje sie sam przy pierwszym
  polaczeniu z siecia i dostaje wlasna tozsamosc (wykrywa tez sklonowane dyski),
- laczy sie wylacznie wychodzaco (HTTPS 443) - zadnych portow do otwierania na komputerach,
- aktualizuje sie sam (podpisane wydania z serwera OVERVNC); nowe funkcje przyjda w aktualizacjach.

Sposob 1 - folder \$OEM\$ (dowolny obraz z setupem Windows)
  1. W obrazie utworz:  sources\\\$OEM\$\\\$\$\\Setup\\Scripts\\
  2. Skopiuj tam:       SetupComplete.cmd  oraz caly folder jako  OVERVNC\\
     (wynik po instalacji: C:\\Windows\\Setup\\Scripts\\SetupComplete.cmd i ...\\Scripts\\OVERVNC\\*)
  3. Jesli obraz ma juz SetupComplete.cmd - dopisz do niego linie z naszego pliku.

Sposob 2 - NTLite
  Post-Setup (Before logon): dodaj plik install-overvnc.cmd razem z overvnc-agent.exe
  (oba w tym samym folderze) - NTLite uruchomi go jako SYSTEM.

Sposob 3 - obraz referencyjny (audit mode + sysprep)
  Uruchom install-overvnc.cmd jako administrator przed sysprep. Komputer referencyjny moze sie
  zarejestrowac - po wdrozeniu obrazu kazdy klon wykryje zmiane sprzetu i zarejestruje sie jako nowy.
  Wpis komputera referencyjnego usun potem w panelu.

Sprawdzenie na zainstalowanym komputerze (cmd jako administrator)
  sc query overvnc-agent                          -> STATE: RUNNING
  type %SystemRoot%\\Temp\\overvnc-install.log      -> przebieg instalacji
  "%ProgramFiles%\\OVERVNC\\overvnc-agent.exe" version
  Podglad zdarzen > Dzienniki systemu Windows > Aplikacja, zrodlo "overvnc-agent" -> rejestracja, polaczenie, aktualizacje
  W panelu: komputer pojawia sie w Komputery w ciagu ok. minuty od polaczenia z siecia.

Bezpieczenstwo
  Token w obrazie pozwala jedynie dodawac nowe komputery (nie daje dostepu do istniejacych).
  Po zakonczeniu wdrozen mozna go usunac w panelu - zainstalowane komputery dzialaja dalej.
TXT

(cd "$OUT" && shasum -a 256 overvnc-agent.exe > SHA256SUMS.txt)
echo "Gotowe: $OUT"
ls -la "$OUT"
