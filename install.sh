#!/usr/bin/env bash
#
# untacit installer — macOS / Linux
#
#   curl -fsSL https://raw.githubusercontent.com/rflvz/untacit/main/install.sh | bash
#
# What it does:
#   1. Detects the dependencies (git, Node.js >= 20, pnpm; Claude Code CLI as
#      an optional extra) — installs what it safely can (pnpm), and for
#      anything else prints the exact command to install it yourself.
#   2. Clones the repo into ~/.untacit/app (or reuses the checkout you are
#      standing in), installs the workspace and builds it.
#   3. Drops `untacit` and `untacit-mcp` launchers into ~/.untacit/bin and
#      wires that directory into your shell PATH.
#
# Flags:
#   --ref <branch|tag>   Version to install (default: main)
#   --dir <path>         Install root (default: ~/.untacit; env: UNTACIT_HOME)
#   --yes                No prompts, assume "yes" (auto when stdin is not a TTY)
#   --no-path            Do not touch shell rc files; print instructions instead
#   --uninstall          Remove the install root and the PATH block, then exit
#
set -euo pipefail

REPO_URL="https://github.com/rflvz/untacit.git"
REF="main"
ROOT="${UNTACIT_HOME:-$HOME/.untacit}"
ASSUME_YES=0
NO_PATH=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --dir) ROOT="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-path) NO_PATH=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --help|-h)
      sed -n '2,22p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $1 (try --help)"; exit 2 ;;
  esac
done

# Piped through `curl | bash` there is no interactive stdin: default to yes
# for the safe actions (pnpm install, PATH block) and never touch anything
# that would need sudo.
[ -t 0 ] || ASSUME_YES=1

# ---------------------------------------------------------------- cosmetics --
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; MAGENTA=$'\033[35m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; MAGENTA=""; RESET=""
fi

case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8*|*utf8*|*UTF8*) OK="✓"; BAD="✗"; WRN="!"; DOT="●"; ARR="→" ;;
  *) OK="+"; BAD="x"; WRN="!"; DOT="*"; ARR="->" ;;
esac

say()  { printf '%s\n' "$*"; }
ok()   { printf '    %s %s\n' "${GREEN}${OK}${RESET}" "$*"; }
bad()  { printf '    %s %s\n' "${RED}${BAD}${RESET}" "$*"; }
warn() { printf '    %s %s\n' "${YELLOW}${WRN}${RESET}" "$*"; }
head_() { printf '\n  %s %s%s%s\n' "${MAGENTA}${DOT}${RESET}" "$BOLD" "$*" "$RESET"; }

banner() {
  printf '%s' "$CYAN"
  cat <<'EOF'

               _             _ _
   _   _ _ __ | |_ __ _  ___(_) |_
  | | | | '_ \| __/ _` |/ __| | __|
  | |_| | | | | || (_| | (__| | |_
   \__,_|_| |_|\__\__,_|\___|_|\__|
EOF
  printf '%s' "$RESET"
  printf '  %styped graph of your business logic — installer%s\n' "$DIM" "$RESET"
}

confirm() { # confirm "question" -> 0/1
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '    %s %s [Y/n] ' "${CYAN}?${RESET}" "$1"
  read -r reply || reply=""
  case "$reply" in ""|y|Y|yes|s|S|si|sí) return 0 ;; *) return 1 ;; esac
}

# run_step "title" cmd args... — spinner while it runs, log dumped on failure.
STEP_LOG=""
run_step() {
  local title="$1"; shift
  STEP_LOG="$(mktemp "${TMPDIR:-/tmp}/untacit-step.XXXXXX")"
  if [ -t 1 ]; then
    local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0 pid rc=0
    case "$OK" in "+") frames='|/-\' ;; esac
    ( "$@" >"$STEP_LOG" 2>&1 ) & pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r    %s%s%s %s%s%s ' "$CYAN" "${frames:i%${#frames}:1}" "$RESET" "$DIM" "$title" "$RESET"
      i=$((i + 1)); sleep 0.08
    done
    wait "$pid" || rc=$?
    printf '\r'
  else
    printf '    %s %s ...\n' "$DOT" "$title"
    local rc=0
    "$@" >"$STEP_LOG" 2>&1 || rc=$?
  fi
  if [ "${rc:-0}" -eq 0 ]; then
    ok "$title"
    rm -f "$STEP_LOG"
    return 0
  fi
  bad "$title"
  printf '\n%s──── last lines of the log ────%s\n' "$DIM" "$RESET"
  tail -n 25 "$STEP_LOG" || true
  printf '%s───────────────────────────────%s\n' "$DIM" "$RESET"
  say "  Full log: $STEP_LOG"
  return 1
}

# ---------------------------------------------------------------- uninstall --
APP_DIR="$ROOT/app"
BIN_DIR="$ROOT/bin"

rc_file() {
  case "$(basename "${SHELL:-bash}")" in
    zsh) echo "$HOME/.zshrc" ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *) echo "$HOME/.bashrc" ;;
  esac
}

if [ "$UNINSTALL" = 1 ]; then
  banner
  head_ "Uninstalling"
  if [ -d "$ROOT" ]; then rm -rf "$ROOT"; ok "removed $ROOT"; else warn "$ROOT not found"; fi
  rc="$(rc_file)"
  if [ -f "$rc" ] && grep -q '# >>> untacit >>>' "$rc"; then
    awk '/# >>> untacit >>>/{skip=1} !skip{print} /# <<< untacit <<</{skip=0}' "$rc" > "$rc.untacit.tmp" \
      && mv "$rc.untacit.tmp" "$rc"
    ok "removed the PATH block from $rc"
  fi
  say ""
  exit 0
fi

# ------------------------------------------------------------- dependencies --
banner
head_ "Checking dependencies"

MISSING_REQUIRED=0
NOTIFY=""

notify() { NOTIFY="${NOTIFY}    ${ARR} $1"$'\n'"      ${DIM}$2${RESET}"$'\n'; }

os_hint_git() {
  if [ "$(uname -s)" = Darwin ]; then echo "xcode-select --install   (or: brew install git)"
  elif command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y git"
  elif command -v dnf >/dev/null 2>&1; then echo "sudo dnf install -y git"
  elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S git"
  else echo "https://git-scm.com/downloads"; fi
}

os_hint_node() {
  if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then
    echo "brew install node   (or LTS from https://nodejs.org)"
  else
    echo "https://nodejs.org (LTS >= 20)   or: curl -fsSL https://fnm.vercel.app/install | bash"
  fi
}

# git — required (the graph repo *is* a git repo)
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version 2>/dev/null | awk '{print $3}')"
else
  bad "git — not found (required: the graph lives in a git repo)"
  notify "Install git:" "$(os_hint_git)"
  MISSING_REQUIRED=1
fi

# Node.js >= 20 — required
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v 2>/dev/null || echo v0)"
  NODE_MAJOR="${NODE_V#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null; then
    ok "node $NODE_V (>= 20 required)"
    NODE_OK=1
  else
    bad "node $NODE_V — too old (>= 20 required)"
    notify "Update Node.js to >= 20 LTS:" "$(os_hint_node)"
    MISSING_REQUIRED=1
  fi
else
  bad "node — not found (required, >= 20)"
  notify "Install Node.js >= 20 LTS:" "$(os_hint_node)"
  MISSING_REQUIRED=1
fi

# pnpm — required, but we can install it ourselves (no sudo paths first)
PNPM_OK=0
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version 2>/dev/null || echo '?')"
  PNPM_OK=1
elif [ "$NODE_OK" = 1 ]; then
  warn "pnpm — not found"
  if confirm "Install pnpm now (corepack / npm, no sudo)?"; then
    if run_step "Installing pnpm" bash -c '
        (corepack enable pnpm 2>/dev/null && command -v pnpm) ||
        (npm install -g pnpm && command -v pnpm) ||
        { curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=10.33.0 SHELL="${SHELL:-bash}" sh -; }
      '; then
      # the standalone script installs outside PATH of this process
      export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
      export PATH="$PNPM_HOME:$PATH"
      hash -r 2>/dev/null || true
      if command -v pnpm >/dev/null 2>&1; then
        ok "pnpm $(pnpm --version) installed"
        PNPM_OK=1
      fi
    fi
  fi
  if [ "$PNPM_OK" = 0 ]; then
    notify "Install pnpm:" "npm install -g pnpm   (or: https://pnpm.io/installation)"
    MISSING_REQUIRED=1
  fi
else
  bad "pnpm — not found (will be installable once Node.js is present)"
  MISSING_REQUIRED=1
fi

# Claude Code CLI — optional (agent engine for `extract` / `interview`)
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -n1 || true) — optional agent engine"
else
  warn "claude (Claude Code) — optional, not found: 'untacit extract'/'untacit interview' need it"
  notify "Optional — install Claude Code:" "npm install -g @anthropic-ai/claude-code   (https://claude.com/claude-code)"
fi

if [ -n "$NOTIFY" ]; then
  head_ "Pending installs"
  printf '%s' "$NOTIFY"
fi

if [ "$MISSING_REQUIRED" = 1 ]; then
  say ""
  say "  ${RED}${BAD}${RESET} Required dependencies are missing — install them with the commands above"
  say "    and run this installer again."
  exit 1
fi

# ------------------------------------------------------------ fetch & build --
# Standing inside a checkout of the repo? Build in place instead of cloning.
LOCAL_MODE=0
if [ -f "$PWD/pnpm-workspace.yaml" ] && [ -f "$PWD/packages/cli/package.json" ] \
   && grep -q '"untacit-monorepo"' "$PWD/package.json" 2>/dev/null; then
  LOCAL_MODE=1
  APP_DIR="$PWD"
fi

head_ "Installing untacit"
if [ "$LOCAL_MODE" = 1 ]; then
  ok "using the local checkout: $APP_DIR"
elif [ -d "$APP_DIR/.git" ]; then
  run_step "Updating $APP_DIR ($REF)" git -C "$APP_DIR" fetch --depth 1 origin "$REF"
  run_step "Checking out $REF" git -C "$APP_DIR" checkout -q --detach FETCH_HEAD
else
  mkdir -p "$ROOT"
  run_step "Cloning rflvz/untacit ($REF)" \
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$APP_DIR"
fi

run_step "Installing workspace dependencies" \
  bash -c 'cd "$1" && { pnpm install --frozen-lockfile || pnpm install; }' _ "$APP_DIR"
run_step "Building packages" bash -c 'cd "$1" && pnpm build' _ "$APP_DIR"

CLI_JS="$APP_DIR/packages/cli/dist/bin.js"
MCP_JS="$APP_DIR/packages/mcp/dist/bin.js"
VERSION="$(node "$CLI_JS" --version 2>/dev/null || echo '?')"
ok "untacit $VERSION works"

# ------------------------------------------------------------------ launchers --
head_ "Creating launchers"
mkdir -p "$BIN_DIR"
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$CLI_JS" > "$BIN_DIR/untacit"
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$MCP_JS" > "$BIN_DIR/untacit-mcp"
chmod +x "$BIN_DIR/untacit" "$BIN_DIR/untacit-mcp"
ok "untacit, untacit-mcp ${ARR} $BIN_DIR"

PATH_NOTE=""
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "PATH already includes $BIN_DIR" ;;
  *)
    if [ "$NO_PATH" = 1 ]; then
      PATH_NOTE="export PATH=\"$BIN_DIR:\$PATH\""
      warn "PATH untouched (--no-path); add it yourself: $PATH_NOTE"
    else
      RC="$(rc_file)"
      if confirm "Add $BIN_DIR to PATH in $RC?"; then
        mkdir -p "$(dirname "$RC")"
        if ! grep -q '# >>> untacit >>>' "$RC" 2>/dev/null; then
          if [ "$(basename "${SHELL:-bash}")" = fish ]; then
            printf '\n# >>> untacit >>>\nfish_add_path %s\n# <<< untacit <<<\n' "$BIN_DIR" >> "$RC"
          else
            printf '\n# >>> untacit >>>\nexport PATH="%s:$PATH"\n# <<< untacit <<<\n' "$BIN_DIR" >> "$RC"
          fi
        fi
        ok "PATH block written to $RC"
        PATH_NOTE="source \"$RC\""
      else
        PATH_NOTE="export PATH=\"$BIN_DIR:\$PATH\""
        warn "PATH untouched; add it yourself: $PATH_NOTE"
      fi
    fi ;;
esac

# -------------------------------------------------------------------- summary --
say ""
say "  ${GREEN}────────────────────────────────────────────────${RESET}"
say "   ${BOLD}untacit $VERSION is ready${RESET}"
say ""
say "   app        $APP_DIR"
say "   launchers  $BIN_DIR"
[ -n "$PATH_NOTE" ] && say "   new shell  ${DIM}(or now: $PATH_NOTE)${RESET}"
say ""
say "   Get started:"
say "     ${CYAN}untacit init ~/my-graph${RESET}"
say "     ${CYAN}untacit --help${RESET}"
say "     ${DIM}guided demo: examples/acme-manufactura/DEMO.md${RESET}"
say "  ${GREEN}────────────────────────────────────────────────${RESET}"
say ""
