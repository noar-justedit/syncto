#!/bin/bash
#
# Double-click launcher: builds the Bitfocus Companion module that lives in
# companion/. The result, dist/justedit-syncto-X.Y.Z.tgz, is the file to attach
# to the GitHub Release; in Companion it is imported from the Modules page.
# Pure JavaScript: the same file works with Companion on Mac, Windows and Linux.
#
cd "$(dirname "$0")"

chmod +x ./*.command ./build.sh scripts/*.sh scripts/*.command 2>/dev/null

build() {
  command -v npm >/dev/null || { echo "npm is missing: install Node.js (nodejs.org), then run this again."; return 1; }
  cd companion || return 1
  rm -rf pkg ./*.tgz
  npm ci || { echo "Installing the module's dependencies failed."; return 1; }
  npx companion-module-build || { echo "Building the Companion module failed."; return 1; }
  local tgz
  tgz="$(ls ./*.tgz 2>/dev/null | head -n 1)"
  [ -n "$tgz" ] || { echo "The build made no .tgz file."; return 1; }
  mkdir -p ../dist
  mv -f "$tgz" ../dist/
  # Only the .tgz is kept: nothing built is left in companion/, so it cannot
  # end up on GitHub.
  rm -rf pkg
  echo ""
  echo "Done: dist/$(basename "$tgz")"
}

build
status=$?
echo ""
read -p "Press Enter to close this window..."
exit $status
