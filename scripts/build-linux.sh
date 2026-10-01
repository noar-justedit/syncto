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
# ║  Build the Linux packages. Run this ON a Linux machine.   ║
# ║  Same approach as ingesto: electron-builder can make an   ║
# ║  AppImage from a Mac, but the .deb it produces there is   ║
# ║  not valid — so Linux is built on Linux.                  ║
# ║  Output: dist/syncto-<version>-linux-x86_64.AppImage      ║
# ║          dist/syncto_<version>_amd64.deb                  ║
# ╚══════════════════════════════════════════════════════════╝

set -e
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR/.."
cd "$PROJECT_DIR"

# Never as root: a build run with sudo leaves the npm and Electron caches owned
# by root, and every later build fails on permissions somewhere unrelated.
if [ "$(id -u)" = "0" ]; then
  echo "✗ Do not run this build with sudo."
  echo "  If a previous one did, repair the caches once with:"
  echo "    sudo chown -R \$(whoami) ~/.npm ~/.cache/electron ~/.cache/electron-builder"
  exit 1
fi

# ── Prerequisites ─────────────────────────────────────────────────────────
# Node 20.19+ is a hard requirement of electron-builder 26: older Nodes crash
# mid-build with "ERR_REQUIRE_ESM ... @noble/hashes". Ubuntu / Pop!_OS's apt
# package is Node 18 — too old. 22 LTS is recommended.
node_ok() {
  command -v node >/dev/null 2>&1 && \
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)'
}
node_too_old() {
  echo "✗ Node.js ${1:-is missing} — this build needs Node 20.19 or newer (22 LTS recommended)."
  echo "  The version from 'apt install nodejs' is too old. Install a current one:"
  echo ""
  echo "  Option A — nvm (no sudo, recommended). Paste these three lines:"
  echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
  echo "    \\. \"\$HOME/.nvm/nvm.sh\""
  echo "    nvm install 22"
  echo ""
  echo "  Option B — NodeSource (system-wide):"
  echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo "    sudo apt install -y nodejs"
  echo ""
  echo "  Then run this script again."
  exit 1
}
# A freshly installed nvm is not loaded until the terminal restarts: load it
# here so "installed nvm, same error" does not happen.
if ! node_ok && [ -s "$HOME/.nvm/nvm.sh" ]; then
  echo "→ System Node is too old — loading nvm…"
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  \. "$NVM_DIR/nvm.sh" || true
  nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
fi
if ! command -v node >/dev/null 2>&1; then
  node_too_old "is not installed"
fi
node_ok || node_too_old "$(node -v) is too old"
echo "✓ Node.js $(node -v)"

MISSING=""
for TOOL in dpkg-deb fakeroot; do
  command -v "$TOOL" >/dev/null 2>&1 || MISSING="$MISSING $TOOL"
done
if [ -n "$MISSING" ]; then
  echo "✗ Missing build tools:$MISSING"
  echo "    sudo apt install dpkg fakeroot"
  exit 1
fi

# ── Icons ─────────────────────────────────────────────────────────────────
# electron-builder wants a folder of <size>x<size>.png for Linux. It is in the
# repository (scripts/gen-icons.py writes it from build-resources/icon.svg), so
# there is normally nothing to do.
ICONDIR="build-resources/icons"
if [ ! -f "$ICONDIR/512x512.png" ]; then
  echo "✗ $ICONDIR/512x512.png is missing."
  echo "  Regenerate the icons from the SVG:  pip install cairosvg pillow && python3 scripts/gen-icons.py"
  exit 1
fi

# ── Build ─────────────────────────────────────────────────────────────────
echo "→ Installing dependencies"
# npm ci installs exactly what package-lock.json pins, so two builds with the
# same version number carry the same dependencies.
if [ -f package-lock.json ]; then npm ci; else
  echo "  ⚠ no package-lock.json — falling back to npm install (not reproducible)"
  npm install
fi

# Start from a clean slate for THIS platform only: a Mac or Windows build
# sitting in dist/ beside it is left alone.
rm -rf dist/*.AppImage dist/*.deb dist/linux-unpacked dist/linux-* dist/latest-linux.yml

echo "→ Building AppImage + deb"
npx electron-builder --config electron-builder.yml --linux AppImage deb

if [ ! -d dist/linux-unpacked ]; then
  echo "✗ Packaging problem: no packaged app found in dist/linux-unpacked"
  exit 1
fi
if [ -z "$(ls -1 dist/*.AppImage 2>/dev/null)" ] || [ -z "$(ls -1 dist/*.deb 2>/dev/null)" ]; then
  echo "✗ The AppImage or the .deb is missing — the build did not complete."
  ls -1 dist/ 2>/dev/null
  exit 1
fi

# The .deb has to declare the keyring library: without it, a machine with no
# keyring gives Electron a "store" that is plain text, and syncto refuses to
# remember server passwords. Check what was actually written, not the config.
if ! dpkg-deb -f dist/*.deb Depends | grep -q libsecret-1-0; then
  echo "✗ The .deb does not depend on libsecret-1-0 — check deb.depends in electron-builder.yml."
  exit 1
fi

echo
echo "Done. Packages are in dist/:"
ls -1 dist/*.AppImage dist/*.deb 2>/dev/null || true
echo
echo "Install the deb:   sudo apt install ./dist/syncto_*_amd64.deb"
echo "Run the AppImage:  chmod +x dist/syncto-*.AppImage && ./dist/syncto-*.AppImage"
echo
echo "Notes:"
echo "  - AppImages need FUSE 2 to start. If one does not open:  sudo apt install libfuse2t64"
echo "    (libfuse2 on Ubuntu 22.04 and older)."
echo "  - Remembering an SFTP password needs a desktop keyring (GNOME Keyring or"
echo "    KWallet). Without one, syncto asks for the password at each connection"
echo "    instead of writing it down."
