#!/bin/bash
#
# syncto — Folder comparison and synchronization
# Copyright (C) 2026 Just Edit (Arnaud Augst)
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#

# ╔══════════════════════════════════════════════════════════╗
# ║            syncto — Build Script for macOS               ║
# ║          Just double-click to build the app!             ║
# ╚══════════════════════════════════════════════════════════╝

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR/.."
cd "$PROJECT_DIR"

VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")

echo ""
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${CYAN}         syncto v$VERSION — Build for macOS            ${NC}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── 1. Node.js ──────────────────────────────────────────────────
echo -e "${BLUE}[1/4]${NC} Checking Node.js…"
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install it from https://nodejs.org (the LTS button).${NC}"
  read -p "Press Enter to exit..."; exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

# ── 2. Dependencies ─────────────────────────────────────────────
echo -e "${BLUE}[2/4]${NC} Checking dependencies…"
if [ ! -d "node_modules" ]; then
  echo "      First run — downloading dependencies (2-3 minutes)…"
  npm install
fi
echo -e "${GREEN}✓ Dependencies ready${NC}"

# ── 3. Build ────────────────────────────────────────────────────
echo -e "${BLUE}[3/4]${NC} Building the macOS app (Apple Silicon)…"

# The .app is built first, the .dmg is wrapped around it afterwards. Those are
# two very different things to fail at: if only the packaging into a disk image
# went wrong, the application itself is finished and sitting in dist/ — so hand
# it over as a zip rather than reporting a failed build and leaving the user
# with nothing.
if npm run build:mac; then
  echo -e "${GREEN}✓ Build finished${NC}"
else
  APP="dist/mac-arm64/syncto.app"
  if [ -d "$APP" ]; then
    echo ""
    echo -e "${YELLOW}The disk image could not be assembled, but the application itself is built.${NC}"
    echo -e "${YELLOW}Packing it as a zip instead.${NC}"
    VER=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "0")
    ( cd dist/mac-arm64 && ditto -c -k --sequesterRsrc --keepParent syncto.app "../syncto-${VER}-mac-arm64.zip" )
    echo -e "${GREEN}✓ dist/syncto-${VER}-mac-arm64.zip${NC}"
    echo "  Unzip it and drag syncto.app into Applications."
  else
    echo -e "${RED}✗ The build failed before the application was produced.${NC}"
    exit 1
  fi
fi

# ── 4. Result ───────────────────────────────────────────────────
echo -e "${BLUE}[4/4]${NC} Result:"
echo ""
echo -e "  ${BOLD}Installer:${NC}  dist/syncto-$VERSION-mac-arm64.dmg"
echo ""
echo -e "  Open the .dmg and drag ${BOLD}syncto${NC} into Applications."
echo -e "  ${YELLOW}First launch (unsigned build): right-click syncto → Open.${NC}"
echo ""

if [ -t 0 ]; then
  read -p "Open the dist/ folder now? [Y/n] " answer
  if [ "$answer" != "n" ] && [ "$answer" != "N" ]; then open dist/ 2>/dev/null || true; fi
fi
