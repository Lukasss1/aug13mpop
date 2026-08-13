#!/usr/bin/env bash
# ============================================================================
# find-stage21-original.sh — hunt for the BYTE-EXACT original Stage-2.1 file
# ============================================================================
# The repo deliberately carries a SEMANTIC RECONSTRUCTION of
# supabase/migration_stage2_1_permission_closure.sql (the archive under
# remediation no longer held the original bytes). A ledger-managed upgrade
# compares each applied file's SHA-256 against its frozen ledger row, so a
# production --db-upgrade will ABORT IN PREFLIGHT until the original is
# restored. Nothing can be mis-applied; the deploy simply refuses.
#
# The original cannot be regenerated — only FOUND. It lives in whatever copy
# of the original Stage-2.1 delivery package still exists: an old download,
# an email attachment, a backup drive, a cloud folder, an older repo clone.
# This script searches those places for you, INCLUDING inside .zip archives,
# and reports any file whose checksum matches the original.
#
#   bash scripts/find-stage21-original.sh                  # scan sensible defaults
#   bash scripts/find-stage21-original.sh ~/Downloads /mnt/backup
#   MP_STAGE21_SHA256=<full 64-char sha> bash scripts/find-stage21-original.sh
#
# On a hit, copy the reported file over the repo's copy and confirm with:
#   npm run check:stage21-restoration
# ============================================================================
set -uo pipefail   # NOT -e: a permission error in one directory must not
                   # abort the whole search.

NAME="migration_stage2_1_permission_closure.sql"
PREFIX="f4715931"
SUFFIX="d796683"
FULL="${MP_STAGE21_SHA256:-}"
RECONSTRUCTION="f03023b52aab11ff3a6af08e380936da09c55102774f51310429b0808c163942"
EDITED_2_1_1="173850a7a6c603fba93111107e97343010e72283cd90a76dba955c0105704068"

sha_of() {
  if   command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl   >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else echo "NO-SHA-TOOL"; fi
}

is_original() {  # $1 = sha
  if [[ -n "$FULL" ]]; then [[ "$1" == "$FULL" ]]; return; fi
  [[ "$1" == ${PREFIX}*${SUFFIX} ]]
}

FOUND=0
RECON_SEEN=0
SCANNED=0

report() {       # $1 = sha, $2 = where, $3 = how to retrieve
  SCANNED=$((SCANNED+1))
  if is_original "$1"; then
    FOUND=$((FOUND+1))
    echo ""
    echo "  ★ ORIGINAL FOUND"
    echo "    sha256 : $1"
    echo "    at     : $2"
    echo "    restore: $3"
  elif [[ "$1" == "$RECONSTRUCTION" ]]; then
    RECON_SEEN=$((RECON_SEEN+1))
    echo "  · reconstruction (known)      $2"
  elif [[ "$1" == "$EDITED_2_1_1" ]]; then
    echo "  · edited 2.1.1 variant (known, NOT the original)  $2"
  else
    echo "  ? UNKNOWN content — verify before use: $1"
    echo "      at: $2"
  fi
}

ROOTS=("$@")
if [[ ${#ROOTS[@]} -eq 0 ]]; then
  ROOTS=("$HOME" "$PWD")
  [[ -d "$HOME/Downloads" ]] && ROOTS+=("$HOME/Downloads")
fi

echo "Searching for the original Stage-2.1 file"
echo "  target : ${FULL:-${PREFIX}…${SUFFIX}}"
echo "  roots  : ${ROOTS[*]}"
echo ""

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "— loose files named $NAME —"
for root in "${ROOTS[@]}"; do
  [[ -d "$root" ]] || continue
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    report "$(sha_of "$f")" "$f" "cp \"$f\" supabase/$NAME"
  done < <(find "$root" -type d \( -name node_modules -o -name .git \) -prune -o \
                        -type f -name "$NAME" -print 2>/dev/null)
done

if command -v unzip >/dev/null 2>&1; then
  echo ""
  echo "— inside .zip archives —"
  for root in "${ROOTS[@]}"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r z; do
      [[ -n "$z" ]] || continue
      while IFS= read -r entry; do
        [[ -n "$entry" ]] || continue
        rm -rf "${TMP:?}/x"; mkdir -p "$TMP/x"
        if unzip -p "$z" "$entry" > "$TMP/x/candidate.sql" 2>/dev/null \
           && [[ -s "$TMP/x/candidate.sql" ]]; then
          report "$(sha_of "$TMP/x/candidate.sql")" "$z :: $entry" \
                 "unzip -p \"$z\" \"$entry\" > supabase/$NAME"
        fi
      done < <(unzip -Z1 "$z" 2>/dev/null | grep -F "$NAME")
    done < <(find "$root" -type d \( -name node_modules -o -name .git \) -prune -o \
                          -type f -name '*.zip' -print 2>/dev/null)
  done
else
  echo ""
  echo "— .zip archives SKIPPED (unzip not installed) —"
fi

echo ""
echo "─────────────────────────────────────────────────────────────"
if (( FOUND > 0 )); then
  echo "✔ Found $FOUND copy/copies matching the original's checksum."
  echo "  Copy one over supabase/$NAME, then run:"
  echo "      npm run check:stage21-restoration"
  exit 0
fi

echo "✖ No copy of the ORIGINAL Stage-2.1 file was found."
echo "  Scanned $SCANNED candidate file(s); $RECON_SEEN were the known reconstruction."
echo ""
echo "  Still to try, in rough order of likelihood:"
echo "    • the original Stage-2.1 delivery package (download folder, email attachment)"
echo "    • an older clone/backup of this repo taken BEFORE the 2.1.2 remediation"
echo "    • a cloud/drive backup of that delivery, or the auditor's own copy"
echo ""
echo "  If the production database already applied the true bytes, you do not"
echo "  need the file to PROVE deployment consistency — ask the ledger itself:"
echo "      SUPABASE_DB_URL=... bash scripts/check-stage21-restoration.sh --from-ledger"
echo "  (that compares the on-disk file against the row your database recorded)."
exit 1
