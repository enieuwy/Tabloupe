#!/bin/bash
set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILES_INI="$HOME/Library/Application Support/Firefox/profiles.ini"
STATE_ROOT="$HOME/.local/state/tabloupe"
BACKUP_ROOT="$STATE_ROOT/session-backups"
VENV_DIR="$STATE_ROOT/lz4-venv"
# Keep only the newest complete session snapshots.
BACKUP_RETENTION_COUNT=10
LZ4_VERSION="4.4.5"
XPI_DIR="$REPO_DIR/web-ext-artifacts"

PROFILE_DIR=""
SESSION_DIR=""

# ─── Colours ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Colour

# ─── Flags ──────────────────────────────────────────────────────────────────────

DRY_RUN=false
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--skip-build]"
      echo ""
      echo "  --dry-run     Run pre-flight checks and build only (no install/restart)"
      echo "  --skip-build  Skip build step; use the latest existing XPI"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown flag: $arg${NC}" >&2
      echo "Usage: $0 [--dry-run] [--skip-build]" >&2
      exit 1
      ;;
  esac
done

# ─── Helpers ────────────────────────────────────────────────────────────────────

info()    { echo -e "${BLUE}$*${NC}"; }
success() { echo -e "${GREEN}$*${NC}"; }
warn()    { echo -e "${YELLOW}$*${NC}"; }
error()   { echo -e "${RED}$*${NC}" >&2; }
header()  { echo -e "\n${BOLD}==> $*${NC}"; }

die() {
  error "FATAL: $*"
  exit 1
}

detect_profile_dir() {
  python3 - "$PROFILES_INI" <<'PY'
import configparser
import sys
from pathlib import Path

profiles_ini = Path(sys.argv[1])
if not profiles_ini.exists():
    sys.exit(0)

parser = configparser.ConfigParser()
parser.read(profiles_ini)
root = profiles_ini.parent

def resolved_path(value, is_relative):
    path = Path(value).expanduser()
    return root / value if is_relative and not path.is_absolute() else path

def resolve(section):
    value = parser.get(section, "Path", fallback=parser.get(section, "Default", fallback="")).strip()
    if not value:
        return None
    is_relative = parser.get(section, "IsRelative", fallback="1").strip() != "0"
    return resolved_path(value, is_relative)

for section in parser.sections():
    if section.startswith("Install"):
        value = parser.get(section, "Default", fallback="").strip()
        if value:
            print(resolved_path(value, True))
            sys.exit(0)

for section in parser.sections():
    if section.startswith("Profile") and parser.get(section, "Default", fallback="0").strip() == "1":
        path = resolve(section)
        if path is not None:
            print(path)
            sys.exit(0)
PY
}

# Count tabs in a recovery.jsonlz4 file. Outputs "windows tabs" on stdout.
count_session_tabs() {
  local lz4_file="$1"
  "$VENV_DIR/bin/python3" - "$lz4_file" <<'PY'
import json
import sys
from pathlib import Path

import lz4.block

with Path(sys.argv[1]).open("rb") as handle:
    handle.read(8)  # skip mozLz4a0\0 header
    raw = lz4.block.decompress(handle.read())

data = json.loads(raw)
windows = data.get("windows", [])
num_windows = len(windows)
num_tabs = sum(len(window.get("tabs", [])) for window in windows)

print(num_windows, num_tabs)
PY
}

# ─── Step 1: Pre-flight checks ─────────────────────────────────────────────────

preflight_checks() {
  header "Pre-flight checks"

  # Required tools
  for cmd in node python3; do
    if ! command -v "$cmd" &>/dev/null; then
      die "$cmd is not installed or not on PATH"
    fi
  done
  success "  ✓ node, python3 found"

  # web-ext available via npx
  if ! npx --no-install web-ext --version &>/dev/null; then
    die "web-ext is not available — run 'npm ci --ignore-scripts' first to install pinned devDependencies"
  fi
  success "  ✓ web-ext available"

  PROFILE_DIR="$(detect_profile_dir)"
  if [[ -z "$PROFILE_DIR" || ! -d "$PROFILE_DIR" ]]; then
    die "Firefox profile not found from $PROFILES_INI"
  fi
  SESSION_DIR="$PROFILE_DIR/sessionstore-backups"
  success "  ✓ Firefox profile: $PROFILE_DIR"

  # Python venv with lz4
  if [[ ! -x "$VENV_DIR/bin/python3" ]]; then
    info "  Creating Python venv for lz4 at $VENV_DIR..."
    mkdir -p "$STATE_ROOT"
    chmod 700 "$STATE_ROOT"
    python3 -m venv "$VENV_DIR"
  fi
  if ! "$VENV_DIR/bin/python3" -c "import lz4.block" 2>/dev/null; then
    info "  Installing lz4 in venv..."
    "$VENV_DIR/bin/python3" -m pip install "lz4==$LZ4_VERSION" --quiet
  fi
  success "  ✓ lz4 venv ready"

  # Syntax checks
  info "  Checking background.js syntax…"
  node --check "$REPO_DIR/background.js"
  success "  ✓ background.js OK"

  info "  Checking options.js syntax…"
  node --check "$REPO_DIR/options.js"
  success "  ✓ options.js OK"

  # Unit tests
  info "  Running tests…"
  if ! (cd "$REPO_DIR" && node --test); then
    die "Tests failed"
  fi
  success "  ✓ Tests passed"

  # Lint
  info "  Running web-ext lint…"
  (cd "$REPO_DIR" && npx --no-install web-ext lint)
  success "  ✓ Lint passed"
}

# ─── Step 2: Snapshot Firefox session ───────────────────────────────────────────

SNAPSHOT_DIR=""
SNAPSHOT_TMP_DIR=""
PRE_WINDOWS=0
PRE_TABS=0

prune_session_backups() {
  local snapshots=()
  local snapshot
  for snapshot in "$BACKUP_ROOT"/*; do
    [[ -d "$snapshot" ]] || continue
    case "$(basename "$snapshot")" in
      # Leftover staging dirs from an interrupted run are never valid snapshots.
      # A dot-prefixed name would be invisible to this glob, so staging dirs are
      # named "partial-*" and swept here.
      partial-*) rm -rf -- "$snapshot" ;;
      *) snapshots+=("$snapshot") ;;
    esac
  done

  local stale_count=$((${#snapshots[@]} - BACKUP_RETENTION_COUNT))
  if ((stale_count <= 0)); then
    return
  fi

  local index
  for ((index = 0; index < stale_count; index += 1)); do
    rm -rf -- "${snapshots[index]}"
  done
  info "  Pruned $stale_count old session backup(s)"
}

cleanup_snapshot_staging() {
  if [[ -n "$SNAPSHOT_TMP_DIR" && -d "$SNAPSHOT_TMP_DIR" ]]; then
    rm -rf -- "$SNAPSHOT_TMP_DIR"
  fi
  SNAPSHOT_TMP_DIR=""
}

copy_session_files() {
  python3 - "$SESSION_DIR" "$SNAPSHOT_TMP_DIR" <<'PY'
import shutil
import sys
from pathlib import Path

source = Path(sys.argv[1])
destination = Path(sys.argv[2])

for child in source.iterdir():
    target = destination / child.name
    if child.is_dir():
        shutil.copytree(child, target, dirs_exist_ok=True)
    else:
        shutil.copy2(child, target)
PY
}

abandon_snapshot() {
  cleanup_snapshot_staging
  # Retention must run even on a failed attempt, or a persistently failing
  # snapshot grows the private state directory without bound.
  prune_session_backups
  die "$*"
}

snapshot_session() {
  header "Snapshot Firefox session"

  local timestamp
  timestamp="$(date +%Y%m%d_%H%M%S)"
  mkdir -p "$STATE_ROOT"
  chmod 700 "$STATE_ROOT"
  mkdir -p "$BACKUP_ROOT"
  chmod 700 "$BACKUP_ROOT"

  if [[ ! -d "$SESSION_DIR" ]]; then
    die "Session backup dir not found: $SESSION_DIR"
  fi

  # Stage into a temp dir, validate the recovery payload, then rename into place:
  # a timestamped snapshot directory therefore only ever exists if it is complete
  # and its session data actually parsed. Firefox rewrites these files while it
  # runs, so a torn copy is expected occasionally — retry once before failing.
  SNAPSHOT_TMP_DIR="$BACKUP_ROOT/partial-$timestamp.$$"
  rm -rf -- "$SNAPSHOT_TMP_DIR"
  mkdir -p "$SNAPSHOT_TMP_DIR"
  chmod 700 "$SNAPSHOT_TMP_DIR"
  trap cleanup_snapshot_staging EXIT

  if ! copy_session_files; then
    abandon_snapshot "Could not copy the Firefox session files from $SESSION_DIR"
  fi

  local recovery_file="$SNAPSHOT_TMP_DIR/recovery.jsonlz4"
  local counts=""
  if [[ -f "$recovery_file" ]]; then
    if ! counts="$(count_session_tabs "$recovery_file" 2>/dev/null)"; then
      warn "  ⚠ Snapshot session data did not parse (Firefox rewrote it mid-copy) — retrying once…"
      rm -rf -- "$SNAPSHOT_TMP_DIR"
      mkdir -p "$SNAPSHOT_TMP_DIR"
      chmod 700 "$SNAPSHOT_TMP_DIR"
      if ! copy_session_files; then
        abandon_snapshot "Could not copy the Firefox session files from $SESSION_DIR"
      fi
      if ! counts="$(count_session_tabs "$recovery_file" 2>/dev/null)"; then
        abandon_snapshot "Firefox session snapshot is unreadable (corrupt recovery.jsonlz4). Quit Firefox and retry."
      fi
    fi
  else
    warn "  ⚠ recovery.jsonlz4 not found in snapshot — Firefox may not be running"
  fi

  SNAPSHOT_DIR="$BACKUP_ROOT/$timestamp"
  rm -rf -- "$SNAPSHOT_DIR"
  if ! mv "$SNAPSHOT_TMP_DIR" "$SNAPSHOT_DIR"; then
    abandon_snapshot "Could not finalize the session snapshot at $SNAPSHOT_DIR"
  fi
  SNAPSHOT_TMP_DIR=""
  trap - EXIT
  success "  ✓ Session files copied to $SNAPSHOT_DIR"
  prune_session_backups

  if [[ -z "$counts" ]]; then
    PRE_WINDOWS=0
    PRE_TABS=0
    return
  fi
  read -r PRE_WINDOWS PRE_TABS <<< "$counts"

  info "  Snapshot: ${PRE_WINDOWS} window(s), ${PRE_TABS} tab(s)"
  info "  Path:     $SNAPSHOT_DIR"
}

# ─── Step 3: Build & sign ──────────────────────────────────────────────────────

XPI_PATH=""
NEW_VERSION=""

build_and_sign() {
  header "Build & sign"

  if $SKIP_BUILD; then
    info "  --skip-build: skipping build step"
  else
    info "  Running ./build.sh …"
    (cd "$REPO_DIR" && bash ./build.sh)
    success "  ✓ Build complete"
  fi

  # Find the latest XPI by modification time
  XPI_PATH="$(python3 - "$XPI_DIR" <<'PY'
import sys
from pathlib import Path

artifact_dir = Path(sys.argv[1])
files = sorted(artifact_dir.glob("*.xpi"), key=lambda path: path.stat().st_mtime, reverse=True)
print(files[0] if files else "")
PY
)"
  if [[ -z "$XPI_PATH" || ! -f "$XPI_PATH" ]]; then
    die "No .xpi found in $XPI_DIR"
  fi

  # Extract version from manifest
  NEW_VERSION="$(python3 - "$REPO_DIR/manifest.json" <<'PY'
import json
import sys
from pathlib import Path

with Path(sys.argv[1]).open() as handle:
    print(json.load(handle)["version"])
PY
)"

  info "  XPI:     $XPI_PATH"
  info "  Version: $NEW_VERSION"
}


# ─── Step 5: Summary (dry-run only) ────────────────────────────────────────────

print_summary() {
  header "Deploy summary"

  echo ""
  echo -e "  ${BOLD}Version:${NC}        ${NEW_VERSION}"
  echo -e "  ${BOLD}XPI:${NC}            ${XPI_PATH}"
  echo -e "  ${BOLD}Session backup:${NC} ${SNAPSHOT_DIR}"
  echo -e "  ${BOLD}Tabs snapshot:${NC}  ${PRE_WINDOWS} window(s), ${PRE_TABS} tab(s)"
  echo ""

  success "  ✅ Dry run complete — no changes deployed"
}

# ─── Main ───────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}Tabloupe — Deploy${NC}"
  echo -e "${BLUE}$(date)${NC}"

  if $DRY_RUN; then
    info "Mode: --dry-run (checks + build only, no manual-install prompt)"
  fi
  if $SKIP_BUILD; then
    info "Mode: --skip-build (using latest existing XPI)"
  fi

  # Always run
  preflight_checks
  snapshot_session
  build_and_sign

  if $DRY_RUN; then
    print_summary
    exit 0
  fi

  # Do not copy into the Firefox profile. Standard Firefox requires the user
  # to install the signed XPI through about:addons so it can validate the add-on.
  header "Next steps"
  echo ""
  echo -e "  ${BOLD}Version:${NC}        ${NEW_VERSION}"
  echo -e "  ${BOLD}XPI:${NC}            ${XPI_PATH}"
  echo -e "  ${BOLD}Session backup:${NC} ${SNAPSHOT_DIR}"
  echo -e "  ${BOLD}Tabs snapshot:${NC}  ${PRE_WINDOWS} window(s), ${PRE_TABS} tab(s)"
  echo ""
  echo -e "  ${YELLOW}To activate the new version:${NC}"
  echo -e "    1. Open ${BOLD}about:addons${NC} in Firefox"
  echo -e "    2. Click ⚙️ → ${BOLD}Install Add-on From File...${NC}"
  echo -e "    3. Select: ${BOLD}${XPI_PATH}${NC}"
  echo -e "    4. Firefox will replace the old version automatically"
  echo ""
  success "  ✅ Build complete — activate manually in Firefox"
}

main
