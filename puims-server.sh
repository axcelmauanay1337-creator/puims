#!/usr/bin/env bash
# PUIMS on your own machine — one script for everything.
#
#   ./puims-server.sh setup     first-time install (asks 3 questions, prints the Chief RT's sign-up link)
#   ./puims-server.sh start     start PUIMS (it also starts by itself after a reboot)
#   ./puims-server.sh stop      stop PUIMS (data is kept)
#   ./puims-server.sh status    is it running?
#   ./puims-server.sh update    after copying in a new PUIMS version: rebuild + apply database changes
#   ./puims-server.sh backup    make a backup now (deploy/backups/)
#   ./puims-server.sh restore FILE   restore a backup (replaces current data — asks first)
#   ./puims-server.sh cert      unit-Wi-Fi setups only: export the certificate phones/PCs must trust
#   ./puims-server.sh logs      show recent app logs (they contain no patient data)
#
# Needs: Docker (Docker Desktop on Windows/macOS, Docker Engine on Linux). Nothing else.
set -euo pipefail
cd "$(dirname "$0")"
ENV=deploy/.env
dc() { docker compose --env-file "$ENV" -f deploy/compose.yaml "$@"; }
need_env() { [ -f "$ENV" ] || { echo "Not set up yet. Run: ./puims-server.sh setup"; exit 1; }; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

wait_app() {
  for _ in $(seq 1 120); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q app)" 2>/dev/null || true)" = healthy ] && return 0
    sleep 2
  done
  echo "PUIMS did not become ready. See: ./puims-server.sh logs"; exit 1
}

case "${1:-help}" in
setup)
  command -v docker >/dev/null || { echo "Install Docker first (https://docs.docker.com/get-docker/)."; exit 1; }
  docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start Docker (Docker Desktop), then run this again."; exit 1; }
  if [ -f "$ENV" ]; then echo "Already set up (deploy/.env exists). Use: ./puims-server.sh start"; exit 1; fi
  say "PUIMS setup"
  echo "1) Web address for PUIMS."
  echo "   • A domain name that points to this machine (e.g. puims.example.com) → real certificate, works anywhere."
  echo "   • Or this computer's address on the unit Wi-Fi (e.g. 192.168.1.50) → works on that network only;"
  echo "     each phone/PC must trust PUIMS's certificate once (./puims-server.sh cert)."
  read -rp "   Address: " SITE
  [[ "$SITE" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Address: letters, digits, dots and dashes only (no https://)."; exit 1; }
  read -rp "2) Chief RT username (lowercase, e.g. chief.rt): " CHIEF_USER
  [[ "$CHIEF_USER" =~ ^[a-z0-9][a-z0-9._-]{2,39}$ ]] || { echo "Username: 3–40 lowercase letters, digits, dot, dash or underscore."; exit 1; }
  read -rp "3) Chief RT full name: " CHIEF_NAME
  [ -n "$CHIEF_NAME" ] || { echo "A name is required."; exit 1; }
  rnd() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
  hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  KEY=$(rnd 32); P1=$(hex 24); P2=$(hex 24); P3=$(hex 24)
  for v in "$KEY" "$P1" "$P2" "$P3"; do [ ${#v} -ge 40 ] || { echo "Could not generate random secrets."; exit 1; }; done
  umask 077
  cat > "$ENV" <<EOF
# PUIMS server settings — generated $(date). KEEP THIS FILE PRIVATE and keep a copy somewhere safe:
# without PUIMS_DATA_KEY, authenticator set-ups and encrypted files cannot be read.
PUIMS_SITE=$SITE
PUIMS_DB_SUPERUSER_PASSWORD=$P1
PUIMS_DB_OWNER_PASSWORD=$P2
PUIMS_DB_APP_PASSWORD=$P3
PUIMS_DATA_KEY=$KEY
EOF
  if [[ "$SITE" =~ ^[0-9.]+$ || "$SITE" != *.* || "$SITE" == *.local || "$SITE" == localhost ]]; then TLS="tls internal"; else TLS=""; fi
  printf '%s {\n  %s\n  encode gzip\n  reverse_proxy app:3000\n}\n' "$SITE" "$TLS" > deploy/Caddyfile
  mkdir -p deploy/backups
  say "Building PUIMS (first time takes a few minutes)…"
  dc build app
  dc up -d db
  say "Creating the database…"
  dc run --rm tools node scripts/migrate.mjs
  dc up -d app web backup
  wait_app
  say "Creating the Chief RT account…"
  dc run --rm tools npx tsx scripts/bootstrap-chief.ts --username "$CHIEF_USER" --name "$CHIEF_NAME"
  say "Done. PUIMS is running at https://$SITE"
  echo "Give the link above to the Chief RT in person: they set a password and an authenticator app, then add RTs under RT Staff."
  [ -n "$TLS" ] && echo "Unit Wi-Fi setup: run ./puims-server.sh cert and install the certificate on each phone/PC (see docs/SERVER_SETUP.md)."
  echo "Backups: deploy/backups (daily). Copy them off this machine regularly."
  ;;
start) need_env; dc up -d db app web backup; wait_app; echo "PUIMS is running at https://$(grep ^PUIMS_SITE= "$ENV" | cut -d= -f2)";;
stop) need_env; dc stop; echo "Stopped. Data is kept.";;
status) need_env; dc ps;;
logs) need_env; dc logs --tail 100 app;;
update)
  need_env
  dc run --rm --entrypoint sh backup -c 'pg_dump -h db -U puims_owner -d puims -Fc -f /backups/puims-before-update-$(date +%Y%m%d-%H%M).dump'
  dc build app
  dc run --rm tools node scripts/migrate.mjs
  dc up -d app web backup
  wait_app
  echo "Updated (a backup was taken first, in deploy/backups)."
  ;;
backup) need_env; dc run --rm --entrypoint sh backup -c 'f=/backups/puims-$(date +%Y%m%d-%H%M).dump; pg_dump -h db -U puims_owner -d puims -Fc -f $f && echo "backup written: deploy/backups/$(basename $f)"';;
restore)
  need_env
  [ -n "${2:-}" ] && [ -f "$2" ] || { echo "Usage: ./puims-server.sh restore deploy/backups/puims-YYYYMMDD-HHMM.dump"; exit 1; }
  read -rp "This REPLACES all current PUIMS data with $2. Type RESTORE to continue: " ok
  [ "$ok" = RESTORE ] || { echo "Cancelled."; exit 1; }
  cp "$2" deploy/backups/_restore.dump
  dc stop app
  # The btree_gist extension is created once at install (by the database superuser), so it is skipped here.
  dc run --rm --entrypoint sh backup -c 'pg_restore -l /backups/_restore.dump | grep -v " EXTENSION " > /tmp/list && pg_restore -h db -U puims_owner -d puims --clean --if-exists --no-owner --role=puims_owner -L /tmp/list /backups/_restore.dump'
  dc up -d app; wait_app; echo "Restored."
  ;;
cert)
  need_env
  dc cp web:/data/caddy/pki/authorities/local/root.crt deploy/puims-certificate.crt
  echo "Saved deploy/puims-certificate.crt — install it as a trusted certificate on each phone/PC (docs/SERVER_SETUP.md)."
  ;;
*) sed -n '2,15p' "$0";;
esac
