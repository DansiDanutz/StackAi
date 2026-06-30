#!/usr/bin/env bash
#
# Stack Ai OS — installer
#
# Installs Stack Ai OS as a persistent tool on this Mac Studio:
#   1. Builds the TypeScript → dist/
#   2. Installs a global `stackai` symlink on PATH (~/.local/bin)
#   3. Installs a launchd daemon so the dashboard auto-starts on login (:42719)
#
# Usage:
#   ./install.sh              # full install (bin + daemon)
#   ./install.sh --no-daemon  # bin only
#   ./install.sh --uninstall  # remove bin + daemon
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
PLIST_LABEL="com.danslab.stack-ai-os"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
PORT="${STACKAI_PORT:-42719}"

# Colors
G="\033[32m"; Y="\033[33m"; D="\033[90m"; R="\033[0m"

info()  { printf "${G}✓${R} %s\n" "$1"; }
warn()  { printf "${Y}!${R} %s\n" "$1"; }
step()  { printf "${D}→ %s${R}\n" "$1"; }

# ---- uninstall ----
if [[ "${1:-}" == "--uninstall" ]]; then
  step "Uninstalling Stack Ai OS..."
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  rm -f "$BIN_DIR/stackai"
  info "Removed: bin + launchd daemon"
  exit 0
fi

NO_DAEMON=0
[[ "${1:-}" == "--no-daemon" ]] && NO_DAEMON=1

# Resolve the absolute node path (launchd runs with a minimal PATH that does NOT
# include shell shims, so we must bake in node's real path).
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found. Install Node first." >&2; exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN" 2>/dev/null || realpath "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
# Verify it actually runs
"$NODE_BIN" --version >/dev/null 2>&1 || { echo "node at $NODE_BIN is not executable" >&2; exit 1; }
info "Using node: $NODE_BIN"

# ---- 1. build ----
step "Building TypeScript → dist/..."
cd "$PROJECT_DIR"
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Install Node + pnpm first." >&2; exit 1
fi
pnpm install --silent 2>/dev/null || pnpm install
pnpm build
info "Built dist/"

# ---- 2. global bin ----
step "Installing global 'stackai' bin..."
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/stackai" << EOF
#!/usr/bin/env bash
# Stack Ai OS launcher — wraps the compiled CLI so 'stackai' works from anywhere.
# Uses an absolute node path so it works under launchd's minimal PATH.
cd "$PROJECT_DIR" 2>/dev/null || true
exec "$NODE_BIN" "$PROJECT_DIR/dist/cli/index.js" "\$@"
EOF
chmod +x "$BIN_DIR/stackai"

# Ensure ~/.local/bin is on PATH (for the current + future shells)
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR is not on your PATH. Add this to your shell profile (~/.zshrc):"
    printf '  export PATH="%s:\$PATH"\n' "$BIN_DIR"
    ;;
esac
info "Installed: $BIN_DIR/stackai"

# ---- 3. launchd daemon (dashboard + MCP auto-start) ----
if [[ "$NO_DAEMON" -eq 0 ]]; then
  step "Installing launchd daemon (dashboard on :$PORT)..."
  mkdir -p "$(dirname "$PLIST_PATH")"
  cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROJECT_DIR}/dist/cli/index.js</string>
    <string>serve</string>
    <string>--port</string>
    <string>${PORT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH}:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${PROJECT_DIR}/data/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${PROJECT_DIR}/data/daemon.err.log</string>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || launchctl load "$PLIST_PATH"
  info "Daemon installed (auto-starts on login, restarts on crash)"
fi

# ---- done ----
echo ""
printf "${G}Stack Ai OS installed.${R}\n"
echo "  bin:       $BIN_DIR/stackai"
echo "  dashboard: http://127.0.0.1:${PORT}"
if [[ "$NO_DAEMON" -eq 0 ]]; then
  printf "  daemon:    ${D}launchctl list %s${R}\n" "$PLIST_LABEL"
fi
echo ""
printf "${D}Verify: ${R}stackai doctor${D}  ·  ${R}stackai --help${D}\n"
