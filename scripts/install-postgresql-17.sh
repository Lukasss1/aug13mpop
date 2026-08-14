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

# GitHub-hosted runners keep /home/runner private. MilkPop's real-PostgreSQL
# harnesses intentionally execute psql as the local postgres OS user and feed it
# checked-in SQL by absolute path. Allow that unprivileged local account to
# traverse/read only the ephemeral checked-out workspace; no Actions secrets are
# written there. This is CI-only and does not alter production hosts.
if [ -n "${GITHUB_ACTIONS:-}" ] && [ "${GITHUB_ACTIONS}" = "true" ] && [ -n "${GITHUB_WORKSPACE:-}" ]; then
  cursor="$GITHUB_WORKSPACE"
  while [ "$cursor" != "/" ]; do
    sudo chmod o+x "$cursor"
    cursor="$(dirname "$cursor")"
  done
  sudo chmod -R o+rX "$GITHUB_WORKSPACE"
fi

psql --version | grep -Eq ' 17\.' || { echo 'PostgreSQL 17 psql required' >&2; exit 1; }
if [ "$MODE" = "server" ]; then
  pg_dump --version | grep -Eq ' 17\.' || { echo 'PostgreSQL 17 pg_dump required' >&2; exit 1; }
  pg_restore --version | grep -Eq ' 17\.' || { echo 'PostgreSQL 17 pg_restore required' >&2; exit 1; }
  # Some CI images already carry another PostgreSQL major. Ensure an exact
  # 17/main cluster exists. On GitHub-hosted runners PostgreSQL 16 commonly
  # occupies the default socket/port first, which makes a newly installed 17
  # choose 5433. Several historical proof harnesses intentionally call plain
  # `psql` through the postgres OS account; leaving 16 on 5432 would therefore
  # prove the migrations against the wrong SERVER even though the client binary
  # is PostgreSQL 17. In CI only, retire the preinstalled clusters and make the
  # exact 17/main cluster the default server on 5432.
  if ! pg_lsclusters --no-header 2>/dev/null | awk '$1 == "17" && $2 == "main" { found=1 } END { exit(found ? 0 : 1) }'; then
    sudo pg_createcluster 17 main --start
  fi
  if [ -n "${GITHUB_ACTIONS:-}" ] && [ "${GITHUB_ACTIONS}" = "true" ]; then
    while read -r version cluster _port _status _owner _data _log; do
      if [ "$version" != "17" ] || [ "$cluster" != "main" ]; then
        sudo pg_ctlcluster "$version" "$cluster" stop >/dev/null 2>&1 || true
      fi
    done < <(pg_lsclusters --no-header 2>/dev/null || true)
    sudo pg_ctlcluster 17 main stop >/dev/null 2>&1 || true
    sudo pg_conftool 17 main set port 5432
    sudo pg_ctlcluster 17 main start
    server_version="$(sudo -u postgres "$PG17_BIN/psql" -h /var/run/postgresql -p 5432 -X -Atqc 'show server_version_num')"
    case "$server_version" in
      17*) ;;
      *) echo "PostgreSQL 17 SERVER required on the default CI socket; got ${server_version:-unknown}" >&2; exit 1 ;;
    esac
  fi
fi
