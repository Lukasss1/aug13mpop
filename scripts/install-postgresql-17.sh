#!/usr/bin/env bash
# Install the PostgreSQL 17 client/server used by MilkPop production proof.
# Ubuntu 24.04 snapshots an older PostgreSQL major, so use PostgreSQL's
# official PGDG APT repository. `client` installs client tooling only.
set -euo pipefail

MODE="${1:-server}"
case "$MODE" in
  server|client) ;;
  *) echo "usage: $0 [server|client]" >&2; exit 2 ;;
esac

sudo apt-get update
sudo apt-get install -y curl ca-certificates
sudo install -d -m 0755 /usr/share/postgresql-common/pgdg
sudo curl --fail --silent --show-error \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc

# shellcheck disable=SC1091
. /etc/os-release
: "${VERSION_CODENAME:?Linux distribution codename unavailable}"
ARCH="$(dpkg --print-architecture)"
printf '%s\n' \
  'Types: deb' \
  'URIs: https://apt.postgresql.org/pub/repos/apt' \
  "Suites: ${VERSION_CODENAME}-pgdg" \
  "Architectures: ${ARCH}" \
  'Components: main' \
  'Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc' \
  | sudo tee /etc/apt/sources.list.d/pgdg.sources >/dev/null

sudo apt-get update
if [ "$MODE" = "client" ]; then
  sudo apt-get install -y postgresql-client-17
else
  sudo apt-get install -y postgresql-17 postgresql-client-17
fi

PG17_BIN=/usr/lib/postgresql/17/bin
[ -x "$PG17_BIN/psql" ] || { echo 'PostgreSQL 17 psql not installed' >&2; exit 1; }
export PATH="$PG17_BIN:$PATH"
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$PG17_BIN" >> "$GITHUB_PATH"
fi

psql --version | grep -Eq ' 17\.' || { echo 'PostgreSQL 17 psql required' >&2; exit 1; }
if [ "$MODE" = "server" ]; then
  pg_dump --version | grep -Eq ' 17\.' || { echo 'PostgreSQL 17 pg_dump required' >&2; exit 1; }
  pg_restore --version | grep -Eq ' 17\.' || { echo 'PostgreSQL 17 pg_restore required' >&2; exit 1; }
  # Some CI images already carry another PostgreSQL major. Ensure an exact
  # 17/main cluster exists so service-based tests never attach to the wrong one.
  if ! pg_lsclusters --no-header 2>/dev/null | awk '$1 == "17" && $2 == "main" { found=1 } END { exit(found ? 0 : 1) }'; then
    sudo pg_createcluster 17 main --start
  fi
fi
