#!/usr/bin/env bash
# Instalacja/aktualizacja serwera OVERVNC na Ubuntu (uruchamiać jako root na serwerze).
# Oczekuje: /tmp/overvnc-release.tgz (server/ + panel/dist/ + deploy/) przesłanego przez scripts/deploy.sh.
# Idempotentny: drugi raz = aktualizacja (dane w /var/lib/overvnc zostają).
set -euo pipefail
NODE_VERSION="${NODE_VERSION:-26.3.1}"
APP=/opt/overvnc/app
ARCH=$(uname -m); [ "$ARCH" = x86_64 ] && NARCH=x64 || NARCH=arm64

id overvnc >/dev/null 2>&1 || useradd --system --home-dir /var/lib/overvnc --shell /usr/sbin/nologin overvnc
install -d -m 0755 /opt/overvnc /etc/overvnc
install -d -m 0700 -o overvnc -g overvnc /var/lib/overvnc

# własny Node — systemowy Node (używany przez OVERPANEL) zostaje nietknięty
if [ "$(/opt/overvnc/node/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  echo "→ Node $NODE_VERSION do /opt/overvnc/node"
  T=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NARCH.tar.xz" -o "$T/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$T/SHASUMS256.txt"
  (cd "$T" && grep " node-v$NODE_VERSION-linux-$NARCH.tar.xz\$" SHASUMS256.txt | sed "s/node-v$NODE_VERSION-linux-$NARCH.tar.xz/node.tar.xz/" | sha256sum -c -)
  rm -rf /opt/overvnc/node.new && mkdir /opt/overvnc/node.new
  tar -xJf "$T/node.tar.xz" -C /opt/overvnc/node.new --strip-components=1
  rm -rf /opt/overvnc/node && mv /opt/overvnc/node.new /opt/overvnc/node && rm -rf "$T"
fi

echo "→ aplikacja do $APP"
rm -rf "$APP.new" && mkdir -p "$APP.new"
tar -xzf /tmp/overvnc-release.tgz -C "$APP.new"
(cd "$APP.new/server" && PATH=/opt/overvnc/node/bin:$PATH npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$APP.new" && chmod -R go-w "$APP.new"
rm -rf "$APP.old" && { [ -d "$APP" ] && mv "$APP" "$APP.old" || true; } && mv "$APP.new" "$APP"

if [ ! -f /etc/overvnc/server.env ]; then
  echo "→ /etc/overvnc/server.env (pierwsza instalacja — uzupełnij GITHUB_TOKEN)"
  cat > /etc/overvnc/server.env <<ENV
HOST=127.0.0.1
PORT=20300
DATA_DIR=/var/lib/overvnc
PANEL_DIR=/opt/overvnc/app/panel/dist
COOKIE_SECURE=1
TRUST_PROXY=1
LOG_LEVEL=info
# Cloudflare (plan Free) przyjmuje żądania do 100 MB — większe pliki zostaną odrzucone czytelnym komunikatem
MAX_UPLOAD_MB=95
GITHUB_REPO=jurfader/overvnc
GITHUB_TOKEN=
ENV
  chmod 0640 /etc/overvnc/server.env && chgrp overvnc /etc/overvnc/server.env
fi

install -m 0644 "$APP/deploy/overvnc.service" /etc/systemd/system/overvnc.service
systemctl daemon-reload
systemctl enable overvnc >/dev/null 2>&1
systemctl restart overvnc
sleep 2
systemctl is-active --quiet overvnc && echo "✔ overvnc działa" || { journalctl -u overvnc -n 30 --no-pager; exit 1; }
curl -fsS -o /dev/null -w "✔ HTTP lokalnie: %{http_code}\n" http://127.0.0.1:20300/ || true
