#!/bin/bash
# -----------------------------------------------------------------------------
# syncto — Build script (run from macOS)
# -----------------------------------------------------------------------------
#   ./build.sh              macOS Apple Silicon (arm64) .dmg
#   ./build.sh --universal  macOS Universal (arm64 + x86_64) .dmg
#   ./build.sh --win        Windows x64: .zip (always) + NSIS .exe (needs Wine)
#   ./build.sh --all        macOS arm64 + Windows x64
#   ./build.sh --dev        run without building
#   ./build.sh --test       run the engine test suite
# -----------------------------------------------------------------------------
# NOTE ON THE WINDOWS BUILD FROM A MAC
#   syncto has no compiled native module (hash-wasm is pure WebAssembly, ssh2 is
#   pure JavaScript), so cross-building for Windows from macOS IS realistic.
#   The portable .zip needs nothing extra. The NSIS installer (.exe) is produced
#   by Wine — install it once with:  brew install --cask wine-stable
#   The result is unsigned: Windows SmartScreen will warn on first launch
#   ("More info" -> "Run anyway"). Same for macOS: right-click -> Open.
# -----------------------------------------------------------------------------

set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

APP="syncto"
VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")

BOLD=$'\033[1m'; CYAN=$'\033[0;36m'; GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'

echo ""
echo "${BOLD}${CYAN}  $APP  v$VERSION${NC}"
echo "  ---------------------------------"

if ! command -v node &>/dev/null; then
  echo "${RED}  Node.js not found. Install it from https://nodejs.org${NC}"; exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install
fi

case "$1" in
  --dev)
    echo "  Dev mode..."
    npm run dev
    ;;
  --test)
    echo "  Running engine tests..."
    npm test
    ;;
  --universal)
    echo "  Building macOS Universal..."
    npm run build:mac-universal
    echo "${GREEN}  Done -> dist/${NC}"
    ;;
  --win)
    echo "  Building Windows x64 from macOS..."
    if ! command -v wine &>/dev/null && ! command -v wine64 &>/dev/null; then
      echo "${YELLOW}  Wine not found: the NSIS .exe will fail, the .zip will still be produced.${NC}"
      echo "${YELLOW}  Install once with: brew install --cask wine-stable${NC}"
    fi
    npm run build:win
    echo ""
    echo "${GREEN}  Installer: dist/$APP-Setup-$VERSION.exe${NC}"
    echo "${GREEN}  Portable:  dist/$APP-$VERSION-win-x64.zip${NC}"
    ;;
  --all)
    npm run build:mac
    npm run build:win
    echo "${GREEN}  Done -> dist/${NC}"
    ;;
  *)
    echo "  Building macOS Apple Silicon (arm64)..."
    npm run build:mac
    echo ""
    echo "${GREEN}  Installer: dist/$APP-$VERSION-mac-arm64.dmg${NC}"
    echo "  Open the .dmg, drag $APP into Applications."
    echo "  First launch (unsigned): right-click $APP -> Open."
    ;;
esac
echo ""
