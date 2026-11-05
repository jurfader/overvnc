#!/usr/bin/env bash
# Pliki agenta dla macOS: podpis stałym certyfikatem OVERMEDIA (własnym, nie Apple) i pakiety aplikacji.
#  - overvnc-agent-darwin-<arch>      — pojedynczy plik (dla agentów ≤ 0.16, które aktualizują się plikiem)
#  - overvnc-agent-darwin-<arch>-app.zip — „OVERVNC Agent.app” (pl.overmedia.overvnc-agent): macOS zapamiętuje
#    zgody i decyzje „Zezwól” dla aplikacji z identyfikatorem; zgody przetrwają aktualizacje (ten sam certyfikat)
# Użycie (CI): OVERVNC_MAC_SIGN_PEM="<klucz + certyfikat PEM>" scripts/sign-macos.sh dist/agents 0.17.0
set -euo pipefail
DIR="$(cd "$1" && pwd)"
VERSION="${2:-0.0.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
RC=""
if [ -n "${OVERVNC_MAC_SIGN_PEM:-}" ]; then
  if [ -n "${RCODESIGN:-}" ]; then
    RC="$RCODESIGN" # test lokalny (np. na macOS) — gotowe narzędzie zamiast pobierania
  else
    VER=0.29.0
    SHA=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002 # apple-codesign-$VER-x86_64-unknown-linux-musl.tar.gz
    curl -fsSL -o "$T/rc.tgz" "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F$VER/apple-codesign-$VER-x86_64-unknown-linux-musl.tar.gz"
    echo "$SHA  $T/rc.tgz" | sha256sum -c - >/dev/null
    tar xzf "$T/rc.tgz" -C "$T"
    RC="$T/apple-codesign-$VER-x86_64-unknown-linux-musl/rcodesign"
  fi
  (umask 077 && printf '%s\n' "$OVERVNC_MAC_SIGN_PEM" >"$T/sign.pem")
else
  echo "::warning::brak sekretu OVERVNC_MAC_SIGN_PEM — pliki macOS bez stałego podpisu (zgody macOS przepadną po aktualizacji)"
fi

for f in "$DIR"/overvnc-agent-darwin-amd64 "$DIR"/overvnc-agent-darwin-arm64; do
  [ -f "$f" ] || continue
  arch="${f##*-}"
  if [ -n "$RC" ]; then
    "$RC" sign --pem-file "$T/sign.pem" --binary-identifier pl.overmedia.overvnc-agent "$f" >/dev/null 2>&1
    echo "podpisano: $(basename "$f")"
  fi
  # pakiet aplikacji
  W="$T/app-$arch"
  B="$W/OVERVNC Agent.app"
  mkdir -p "$B/Contents/MacOS" "$B/Contents/Resources"
  cp "$f" "$B/Contents/MacOS/overvnc-agent"
  chmod 755 "$B/Contents/MacOS/overvnc-agent"
  sed "s/__VERSION__/$VERSION/g" "$ROOT/deploy/macos/Info.plist" >"$B/Contents/Info.plist"
  cp "$ROOT/deploy/macos/AppIcon.icns" "$B/Contents/Resources/AppIcon.icns"
  if [ -n "$RC" ]; then
    "$RC" sign --pem-file "$T/sign.pem" "$B" >/dev/null 2>&1
  fi
  rm -f "$DIR/overvnc-agent-darwin-$arch-app.zip"
  (cd "$W" && zip -qrX "$DIR/overvnc-agent-darwin-$arch-app.zip" "OVERVNC Agent.app")
  echo "pakiet: overvnc-agent-darwin-$arch-app.zip${RC:+ (podpisany)}"
done
