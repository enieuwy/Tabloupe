#!/bin/bash
set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="$HOME/Library/Application Support/Firefox/Profiles/2t2po2ct.default-release"
EXTENSION_FILENAME="focus-tab-groups@local.xpi"
EXTENSIONS_DIR="$PROFILE_DIR/extensions"
SESSION_DIR="$PROFILE_DIR/sessionstore-backups"
BACKUP_ROOT="/tmp/focus_tab_groups_firefox_session_backup"
VENV_DIR="/tmp/focus_restore_lz4"
XPI_DIR="$REPO_DIR/web-ext-artifacts"

FIREFOX_QUIT_TIMEOUT=15  # seconds to wait for Firefox to exit
FIREFOX_START_WAIT=5     # seconds to wait after launching Firefox

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

# Count tabs in a recovery.jsonlz4 file. Outputs "windows tabs" on stdout.
count_session_tabs() {
  local lz4_file="$1"
  "$VENV_DIR/bin/python3" -c "
import lz4.block, json, sys

with open('$lz4_file', 'rb') as f:
    magic = f.read(8)          # skip mozLz4a0\\0 header
    raw = lz4.block.decompress(f.read())

data = json.loads(raw)
windows = data.get('windows', [])
num_windows = len(windows)
num_tabs = sum(len(w.get('tabs', [])) for w in windows)

print(num_windows, num_tabs)
"
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
  if ! npx -y web-ext --version &>/dev/null; then
    die "web-ext is not available via npx"
  fi
  success "  ✓ web-ext available"

  # Python venv with lz4
  if [[ ! -x "$VENV_DIR/bin/python3" ]]; then
    die "Python venv not found at $VENV_DIR (need lz4 package)"
  fi
  if ! "$VENV_DIR/bin/python3" -c "import lz4.block" 2>/dev/null; then
    die "lz4 package not installed in $VENV_DIR"
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
  node --test "$REPO_DIR/tests/background.test.js"
  success "  ✓ Tests passed"

  # Lint
  info "  Running web-ext lint…"
  (cd "$REPO_DIR" && npx -y web-ext lint)
  success "  ✓ Lint passed"
}

# ─── Step 2: Snapshot Firefox session ───────────────────────────────────────────

SNAPSHOT_DIR=""
PRE_WINDOWS=0
PRE_TABS=0

snapshot_session() {
  header "Snapshot Firefox session"

  local timestamp
  timestamp="$(date +%Y%m%d_%H%M%S)"
  SNAPSHOT_DIR="$BACKUP_ROOT/$timestamp"
  mkdir -p "$SNAPSHOT_DIR"

  if [[ ! -d "$SESSION_DIR" ]]; then
    die "Session backup dir not found: $SESSION_DIR"
  fi

  cp -a "$SESSION_DIR"/* "$SNAPSHOT_DIR"/
  success "  ✓ Session files copied to $SNAPSHOT_DIR"

  local recovery_file="$SNAPSHOT_DIR/recovery.jsonlz4"
  if [[ ! -f "$recovery_file" ]]; then
    warn "  ⚠ recovery.jsonlz4 not found in snapshot — Firefox may not be running"
    PRE_WINDOWS=0
    PRE_TABS=0
    return
  fi

  local counts
  counts="$(count_session_tabs "$recovery_file")"
  PRE_WINDOWS="$(echo "$counts" | awk '{print $1}')"
  PRE_TABS="$(echo "$counts" | awk '{print $2}')"

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
  XPI_PATH="$(ls -t "$XPI_DIR"/*.xpi 2>/dev/null | head -n1)" || true
  if [[ -z "$XPI_PATH" || ! -f "$XPI_PATH" ]]; then
    die "No .xpi found in $XPI_DIR"
  fi

  # Extract version from manifest
  NEW_VERSION="$(python3 -c "import json; print(json.load(open('$REPO_DIR/manifest.json'))['version'])")"

  info "  XPI:     $XPI_PATH"
  info "  Version: $NEW_VERSION"
}

# ─── Step 4: Install XPI ───────────────────────────────────────────────────────

install_xpi() {
  header "Install XPI"

  local dest="$EXTENSIONS_DIR/$EXTENSION_FILENAME"
  mkdir -p "$EXTENSIONS_DIR"
  cp "$XPI_PATH" "$dest"
  success "  ✓ Installed to $dest"
}

# ─── Step 5: Restart Firefox ───────────────────────────────────────────────────

restart_firefox() {
  header "Restart Firefox"

  # Graceful quit
  if pgrep -x firefox &>/dev/null; then
    info "  Quitting Firefox gracefully…"
    osascript -e 'tell application "Firefox" to quit' 2>/dev/null || true

    local elapsed=0
    while pgrep -x firefox &>/dev/null; do
      if (( elapsed >= FIREFOX_QUIT_TIMEOUT )); then
        die "Firefox did not exit within ${FIREFOX_QUIT_TIMEOUT}s — aborting (session backup: $SNAPSHOT_DIR)"
      fi
      sleep 1
      (( elapsed++ ))
    done
    success "  ✓ Firefox exited after ${elapsed}s"
  else
    info "  Firefox is not running"
  fi

  # Brief pause for file handles to flush
  sleep 2

  # Relaunch
  info "  Launching Firefox…"
  open -a Firefox
  sleep "$FIREFOX_START_WAIT"
  success "  ✓ Firefox started"
}

# ─── Step 6: Verify session ────────────────────────────────────────────────────

POST_WINDOWS=0
POST_TABS=0

verify_session() {
  header "Verify session"

  local recovery_file="$SESSION_DIR/recovery.jsonlz4"

  if [[ ! -f "$recovery_file" ]]; then
    warn "  ⚠ recovery.jsonlz4 not yet written — waiting 5 more seconds…"
    sleep 5
  fi

  if [[ ! -f "$recovery_file" ]]; then
    warn "  ⚠ recovery.jsonlz4 still not found — cannot verify session"
    POST_WINDOWS=0
    POST_TABS=0
    return
  fi

  local counts
  counts="$(count_session_tabs "$recovery_file")"
  POST_WINDOWS="$(echo "$counts" | awk '{print $1}')"
  POST_TABS="$(echo "$counts" | awk '{print $2}')"

  info "  Post-restart: ${POST_WINDOWS} window(s), ${POST_TABS} tab(s)"

  local threshold=$(( PRE_TABS - 2 ))
  if (( PRE_TABS > 0 && POST_TABS < threshold )); then
    echo ""
    warn "  ⚠ WARNING: Tab count dropped significantly!"
    warn "    Before: $PRE_TABS tabs  →  After: $POST_TABS tabs"
    warn "    Session backup: $SNAPSHOT_DIR"
    warn "    Restore manually by copying files back to:"
    warn "      $SESSION_DIR"
    exit 1
  fi

  success "  ✓ Session looks healthy"
}

# ─── Step 7: Summary ───────────────────────────────────────────────────────────

print_summary() {
  header "Deploy summary"

  echo ""
  echo -e "  ${BOLD}Version:${NC}        ${NEW_VERSION}"
  echo -e "  ${BOLD}XPI:${NC}            ${XPI_PATH}"
  echo -e "  ${BOLD}Session backup:${NC} ${SNAPSHOT_DIR}"
  echo -e "  ${BOLD}Tabs before:${NC}    ${PRE_TABS}"
  echo -e "  ${BOLD}Tabs after:${NC}     ${POST_TABS}"
  echo ""

  if $DRY_RUN; then
    success "  ✅ Dry run complete — no changes deployed"
  else
    success "  ✅ Deploy complete"
  fi
}

# ─── Main ───────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}Focus Tab Groups — Deploy${NC}"
  echo -e "${BLUE}$(date)${NC}"

  if $DRY_RUN; then
    info "Mode: --dry-run (checks + build only, no install/restart)"
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

  # Full deploy
  install_xpi
  restart_firefox
  verify_session
  print_summary
}

main
