#!/usr/bin/env bash
# Podpis plików agenta dla macOS stałym certyfikatem OVERMEDIA (własnym, nie Apple).
# Zgody macOS (Nagrywanie ekranu, Dostępność, Pełny dostęp do dysku) są wtedy przypisane do certyfikatu
# i identyfikatora pl.overmedia.overvnc-agent, a nie do konkretnego pliku — przetrwają aktualizacje agenta.
# Użycie (CI): OVERVNC_MAC_SIGN_PEM="<klucz + certyfikat PEM>" scripts/sign-macos.sh dist/agents
set -euo pipefail
DIR="$1"
if [ -z "${OVERVNC_MAC_SIGN_PEM:-}" ]; then
  echo "::warning::brak sekretu OVERVNC_MAC_SIGN_PEM — pliki macOS bez stałego podpisu (zgody macOS przepadną po aktualizacji)"
  exit 0
fi
VER=0.29.0
SHA=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002 # apple-codesign-$VER-x86_64-unknown-linux-musl.tar.gz
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
if [ -n "${RCODESIGN:-}" ]; then
  RC="$RCODESIGN" # test lokalny (np. na macOS) — gotowe narzędzie zamiast pobierania
else
curl -fsSL -o "$T/rc.tgz" "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F$VER/apple-codesign-$VER-x86_64-unknown-linux-musl.tar.gz"
echo "$SHA  $T/rc.tgz" | sha256sum -c - >/dev/null
tar xzf "$T/rc.tgz" -C "$T"
RC="$T/apple-codesign-$VER-x86_64-unknown-linux-musl/rcodesign"
fi
(umask 077 && printf '%s\n' "$OVERVNC_MAC_SIGN_PEM" >"$T/sign.pem")
for f in "$DIR"/overvnc-agent-darwin-*; do
  "$RC" sign --pem-file "$T/sign.pem" --binary-identifier pl.overmedia.overvnc-agent "$f" >/dev/null
  echo "podpisano: $(basename "$f")"
done
