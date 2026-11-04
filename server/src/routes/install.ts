import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { sha256 } from '../crypto.ts';
import { HttpError, parse } from '../errors.ts';

/**
 * Instalacja jedną komendą: skrypt (install.ps1 / install.sh) pobiera aktualne wydanie agenta dla systemu
 * i procesora, sprawdza sumę SHA-256, instaluje usługę z autostartem i rejestruje komputer.
 * Token rejestracji jest przekazywany nagłówkiem (X-Enroll-Token), nie w adresie — adresy trafiają do logów.
 */

const PLATFORMS = ['windows-amd64', 'windows-arm64', 'linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'] as const;
const PlatformParams = z.object({ platform: z.enum(PLATFORMS) });

/** Adres serwera z perspektywy instalowanego komputera (za proxy — z nagłówków X-Forwarded-*). */
function serverUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`;
}

export const INSTALL_PS1 = `# OVERVNC — instalacja agenta (Windows, PowerShell jako Administrator)
# Użycie: $env:OVERVNC_TOKEN='ovnc_…'; irm __SERVER__/install.ps1 | iex
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $server = '__SERVER__'
  $token = $env:OVERVNC_TOKEN
  Remove-Item Env:OVERVNC_TOKEN -ErrorAction SilentlyContinue
  function Blad($m) { Write-Host "BŁĄD: $m" -ForegroundColor Red }
  if (-not $token) { Blad 'brak tokenu — skopiuj całe polecenie z panelu (Dodaj komputer).'; return }
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Blad 'uruchom PowerShell jako Administrator (prawy klik -> Uruchom jako administrator).'; return
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
  $dir = Join-Path $env:ProgramFiles 'OVERVNC'
  $exe = Join-Path $dir 'overvnc-agent.exe'
  $tmp = Join-Path $env:TEMP ('overvnc-agent-' + [guid]::NewGuid() + '.exe')
  Write-Host "Pobieranie agenta OVERVNC (windows-$arch)..."
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Headers @{ 'X-Enroll-Token' = $token } -Uri "$server/api/install/agent/windows-$arch" -OutFile $tmp -PassThru
  } catch {
    Blad "pobieranie nie powiodło się: $($_.Exception.Message) — token mógł wygasnąć lub zostać wykorzystany."; return
  }
  $want = [string]$r.Headers['X-Sha256']
  $got = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
  if (-not $want -or $got -ne $want.ToLower()) { Remove-Item $tmp -Force; Blad 'suma kontrolna pliku się nie zgadza — przerwano.'; return }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $svc = Get-Service -Name 'overvnc-agent' -ErrorAction SilentlyContinue
  if ($svc) {
    Write-Host 'Agent jest już zainstalowany — aktualizacja pliku i ponowne uruchomienie usługi.'
    Stop-Service -Name 'overvnc-agent' -Force -ErrorAction SilentlyContinue
    # procesy pomocnicze (pulpit, zrzuty) mogą jeszcze chwilę trzymać plik — kilka prób
    $moved = $false
    foreach ($i in 1..10) {
      try { Move-Item -Force $tmp $exe; $moved = $true; break } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $moved) { Start-Service -Name 'overvnc-agent'; Blad 'plik agenta jest zajęty — spróbuj ponownie za chwilę.'; return }
    Start-Service -Name 'overvnc-agent'
  } else {
    Move-Item -Force $tmp $exe
    & $exe install --server $server --token $token
    if ($LASTEXITCODE -ne 0) { Blad "instalacja usługi nie powiodła się (kod $LASTEXITCODE)."; return }
  }
  Write-Host "Gotowe: agent OVERVNC $($r.Headers['X-Agent-Version']) działa i uruchamia się razem z systemem. Komputer pojawi się w panelu za kilka sekund." -ForegroundColor Green
}
`;

export const INSTALL_SH = `#!/bin/sh
# OVERVNC — instalacja agenta (Linux, macOS)
# Użycie: curl -fsSL __SERVER__/install.sh | sudo OVERVNC_TOKEN='ovnc_…' sh
set -eu
SERVER='__SERVER__'
TOKEN="\${OVERVNC_TOKEN:-}"
fail() { echo "BŁĄD: $*" >&2; exit 1; }
[ -n "$TOKEN" ] || fail "brak tokenu — skopiuj całe polecenie z panelu (Dodaj komputer)."
[ "$(id -u)" -eq 0 ] || fail "uruchom przez sudo."
case "$(uname -s)" in
  Linux) OS=linux; CFG=/etc/overvnc/agent.json ;;
  Darwin) OS=darwin; CFG="/Library/Application Support/OVERVNC/agent.json" ;;
  *) fail "nieobsługiwany system: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "nieobsługiwany procesor: $(uname -m)" ;;
esac
DEST=/usr/local/bin/overvnc-agent
TMP=$(mktemp)
HDR=$(mktemp)
trap 'rm -f "$TMP" "$HDR"' EXIT
echo "Pobieranie agenta OVERVNC ($OS-$ARCH)..."
curl -fsSL -H "X-Enroll-Token: $TOKEN" -D "$HDR" -o "$TMP" "$SERVER/api/install/agent/$OS-$ARCH" || fail "pobieranie nie powiodło się — token mógł wygasnąć lub zostać wykorzystany."
WANT=$(grep -i '^x-sha256:' "$HDR" | tr -d '\\r' | awk '{print tolower($2)}')
VER=$(grep -i '^x-agent-version:' "$HDR" | tr -d '\\r' | awk '{print $2}')
if command -v sha256sum >/dev/null 2>&1; then GOT=$(sha256sum "$TMP" | awk '{print $1}'); else GOT=$(shasum -a 256 "$TMP" | awk '{print $1}'); fi
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || fail "suma kontrolna pliku się nie zgadza — przerwano."
mkdir -p /usr/local/bin
if [ -f "$CFG" ]; then
  echo "Agent jest już zainstalowany — aktualizacja pliku i ponowne uruchomienie usługi."
  install -m 0755 "$TMP" "$DEST"
  # restart jednym poleceniem systemu — stop+start (launchctl unload/load) potrafi się „rozminąć” i usługa zostaje wyłączona
  if [ "$OS" = darwin ]; then
    launchctl kickstart -k system/overvnc-agent 2>/dev/null || launchctl load -w /Library/LaunchDaemons/overvnc-agent.plist
  else
    systemctl restart overvnc-agent 2>/dev/null || "$DEST" start
  fi
else
  install -m 0755 "$TMP" "$DEST"
  "$DEST" install --server "$SERVER" --token "$TOKEN"
fi
echo "Gotowe: agent OVERVNC $VER działa i uruchamia się razem z systemem. Komputer pojawi się w panelu za kilka sekund."
`;

export async function installRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, updates } = ctx;

  const script = (body: string, type: string) => async (req: FastifyRequest, reply: { header: (k: string, v: string) => unknown; send: (b: string) => unknown }) => {
    reply.header('Content-Type', `${type}; charset=utf-8`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(body.replaceAll('__SERVER__', serverUrl(req)));
  };
  app.get('/install.ps1', script(INSTALL_PS1, 'text/plain'));
  app.get('/install.sh', script(INSTALL_SH, 'text/x-shellscript'));

  // binarka agenta dla instalatora — tylko z ważnym tokenem rejestracji (nie zużywa użycia; zużyje je rejestracja)
  app.get('/api/install/agent/:platform', async (req, reply) => {
    if (!ctx.limits.enroll.hit(req.ip)) throw new HttpError(429, 'too_many_attempts', 'Zbyt wiele prób.');
    const { platform } = parse(PlatformParams, req.params);
    const token = String(req.headers['x-enroll-token'] ?? '');
    const t = token
      ? (db.prepare('SELECT uses_left, expires_at FROM enroll_tokens WHERE token_hash = ?').get(sha256(token)) as { uses_left: number | null; expires_at: number } | undefined)
      : undefined;
    if (!t || t.expires_at < Date.now() || (t.uses_left !== null && t.uses_left <= 0)) {
      throw new HttpError(403, 'invalid_token', 'Token jest nieprawidłowy, wygasł lub został wykorzystany.');
    }
    const rel = updates.target();
    const f = rel ? updates.filePath(rel.version, platform) : null;
    if (!rel || !f) throw new HttpError(404, 'not_found', 'Na serwerze nie ma jeszcze wydania agenta dla tego systemu.');
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(f.file.size))
      .header('Content-Disposition', `attachment; filename="${f.file.name}"`)
      .header('X-Sha256', f.file.sha256)
      .header('X-Agent-Version', rel.version)
      .header('Cache-Control', 'no-store')
      .send(updates.stream(f.path));
  });
}
