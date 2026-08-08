#!/bin/bash
#
# Double-click launcher for build-mac.sh — lets you run the Mac build from
# Finder instead of a terminal. The actual build logic lives in build-mac.sh;
# this file only makes it double-clickable and keeps the window open so you
# can read the result.
#
cd "$(dirname "$0")"
./build-mac.sh
status=$?
echo ""
read -p "Press Enter to close this window..."
exit $status
