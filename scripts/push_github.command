#!/bin/bash
#
# Publishes this folder to GitHub: after it runs, the repository's main branch
# holds exactly what is in this folder — additions, changes AND removals.
#
# Why a script and not the GitHub web upload: the upload only ever adds files
# (a file removed here stays on GitHub for ever) and stores every file without
# its executable bit, which breaks every .command and .sh on the next download.
#
# What it does, in order:
#   1. checks that version.json and package.json give the same version;
#   2. clones the repository into a temporary folder (this folder is never
#      touched, and needs no .git of its own);
#   3. refuses unless that version is strictly higher than the one on GitHub;
#   4. makes the clone identical to this folder (node_modules, dist, .git and
#      .DS_Store excepted);
#   5. holds version.json back while the GitHub Release vX.Y.Z does not exist:
#      that file is what makes every installed copy announce an update, and it
#      must not point at a release with no binaries yet. Publish the Release,
#      then run this script again: it sends version.json alone;
#   6. lists the changes and waits for "y" before sending anything;
#   7. commits and pushes to main. Never forced: if GitHub moved in the
#      meantime, the push is refused and nothing is lost.
#
# Needs git (Xcode command line tools: `xcode-select --install`) and Node.js.
# The first push asks for GitHub credentials; see README, "Publishing".
#
# For the test suite only: PUSH_GITHUB_REMOTE replaces the repository address,
# PUSH_GITHUB_RELEASE (yes/no) replaces the check of the GitHub Release.

cd "$(dirname "$0")/.." || exit 1
SRC="$(pwd)"

pause_exit() {
  echo ""
  if [ -t 0 ]; then read -p "Press Enter to close this window..." _; fi
  exit "$1"
}
fail() { echo ""; echo "✗ $1"; pause_exit 1; }

command -v git  >/dev/null 2>&1 || fail "git is not installed. Run: xcode-select --install"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed (https://nodejs.org)."
[ -f version.json ] || fail "No version.json in $SRC."
[ -f package.json ] || fail "No package.json in $SRC."

# ── Versions and address, read with Node (JSON is not a job for sed) ────────
read_json() { node -e "
  const fs = require('fs');
  try { const j = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        const v = process.argv[2].split('.').reduce((o, k) => (o == null ? o : o[k]), j);
        process.stdout.write(v == null ? '' : String(v)); } catch (e) {}
" "$1" "$2"; }

VER="$(read_json version.json version)"
PKG_VER="$(read_json package.json version)"
NAME="$(read_json package.json name)"
[ -n "$VER" ] || fail "version.json has no version."
[ "$VER" = "$PKG_VER" ] || fail "version.json says $VER but package.json says $PKG_VER. Fix the bump first."

URL="$(read_json package.json repository.url)"
[ -n "$URL" ] || URL="$(read_json package.json repository)"
[ -n "$URL" ] || URL="$(read_json version.json url)"
SLUG="$(printf '%s' "$URL" | sed -E 's#^(git\+)?https?://github\.com/##; s#^git@github\.com:##; s#\.git$##' | cut -d/ -f1-2)"
case "$SLUG" in */*) ;; *) fail "No GitHub address found in package.json or version.json." ;; esac
REMOTE="${PUSH_GITHUB_REMOTE:-https://github.com/$SLUG.git}"

echo "Project : ${NAME:-?} $VER"
echo "Folder  : $SRC"
echo "GitHub  : $SLUG (branch main)"
echo ""

# ── Temporary clone ─────────────────────────────────────────────────────────
TMP="$(mktemp -d "${TMPDIR:-/tmp}/push_github.XXXXXX")" || fail "Could not create a temporary folder."
trap 'rm -rf "$TMP"' EXIT
echo "Downloading the current state of GitHub…"
git clone --quiet --branch main "$REMOTE" "$TMP/repo" || fail "Could not download $REMOTE (network, address or permissions)."
cd "$TMP/repo" || fail "The temporary clone is missing."

PUB_VER="$(read_json version.json version)"
newer="$(node -e "
  const p = s => String(s || '0').split('.').map(n => parseInt(n, 10) || 0);
  const a = p(process.argv[1]), b = p(process.argv[2]);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) { process.stdout.write(a[i] > b[i] ? 'yes' : 'no'); process.exit(); } }
  process.stdout.write('no');
" "$VER" "$PUB_VER")"
echo "Version on GitHub: ${PUB_VER:-none}   ·   version here: $VER"
[ "$newer" = "yes" ] || fail "Every publication carries a new version: $VER is not higher than ${PUB_VER:-the published one}. Bump first."

# ── Make the clone identical to the folder ──────────────────────────────────
# Everything but .git is emptied, then the folder is copied in. Not rsync: its
# quick check skips a file whose size and date match, and a file edited within
# the same second as the download (same size: "0.8.5" → "0.8.6") stayed old.
find "$TMP/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
for e in "$SRC"/* "$SRC"/.[!.]* "$SRC"/..?*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  case "$(basename "$e")" in .git|node_modules|dist) continue ;; esac
  cp -Rp "$e" "$TMP/repo/" || fail "Copying the folder into the clone failed."
done
find "$TMP/repo" -path "$TMP/repo/.git" -prune -o -name .DS_Store -type f -exec rm -f {} +
# Scripts stay executable on GitHub, whatever the unzip tool did to them here.
find . -path ./.git -prune -o -type f \( -name '*.command' -o -name '*.sh' \) -exec chmod +x {} +

# ── version.json waits for its Release ──────────────────────────────────────
case "${PUSH_GITHUB_RELEASE:-}" in
  yes) released=yes ;;
  no)  released=no ;;
  *)   code="$(curl -s -o /dev/null -w '%{http_code}' "https://api.github.com/repos/$SLUG/releases/tags/v$VER")"
       if [ "$code" = "200" ]; then released=yes; else released=no; fi ;;
esac
held=no
if [ "$released" != "yes" ] && git cat-file -e HEAD:version.json 2>/dev/null; then
  git checkout --quiet HEAD -- version.json
  held=yes
fi

git add -A
if git diff --cached --quiet; then
  echo ""
  if [ "$held" = "yes" ]; then
    echo "✓ The code of $VER is already on GitHub."
    echo "  version.json is waiting for the GitHub Release v$VER (with its binaries)."
    echo "  Publish it, then run this script again."
  else
    echo "✓ GitHub is already identical to this folder. Nothing to send."
  fi
  pause_exit 0
fi

echo ""
echo "Changes to send (A added, M modified, D deleted, R renamed):"
git status --short | sed 's/^/  /'
echo ""
if [ "$held" = "yes" ]; then
  echo "version.json is NOT sent: the Release v$VER does not exist on GitHub yet."
  echo "Installed copies will only announce $VER once you publish the Release"
  echo "with its binaries and run this script again."
else
  echo "version.json IS sent: every installed copy will announce $VER."
fi
echo ""
read -p "Send these changes to GitHub? (y/n) " answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "Nothing sent."; pause_exit 0; }

# A commit needs a name. GitHub Desktop normally sets one; if not, the
# account's private no-reply address is used rather than a real email.
if [ -z "$(git config user.name)" ];  then git config user.name  "${SLUG%%/*}"; fi
if [ -z "$(git config user.email)" ]; then git config user.email "${SLUG%%/*}@users.noreply.github.com"; fi

if [ "$held" = "yes" ]; then MSG="${NAME:-release} $VER"
elif [ "$(git diff --cached --name-only)" = "version.json" ]; then MSG="${NAME:-release} $VER: version.json (update notice)"
else MSG="${NAME:-release} $VER"; fi
git commit --quiet -m "$MSG" || fail "The commit failed."

# The GitHub CLI, when installed and logged in, provides the credentials;
# otherwise git asks (and macOS keeps the answer in the keychain).
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin HEAD:main \
    || fail "The push was refused. Nothing was changed on GitHub."
else
  git push origin HEAD:main || fail "The push was refused. Nothing was changed on GitHub."
fi

echo ""
echo "✓ Sent: $MSG"
if [ "$held" = "yes" ]; then
  echo ""
  echo "Next: publish the GitHub Release v$VER with its binaries,"
  echo "then run this script again to send version.json."
fi
pause_exit 0
