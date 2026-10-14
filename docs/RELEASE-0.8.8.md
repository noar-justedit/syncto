# syncto 0.8.8

A complete review of the code, and everything it found that could lose data,
take a wrong decision, leak something or mislead on screen. Long file names no
longer fail, auto-sync never shuts the machine down, and syncto now runs on
Electron 44, which needs **macOS 13 or later**.

**1314 checks pass**, up from 1169 at 0.8.7.

## Fixed

### Data and decisions

- 🔴 **Long file names failed with "ENOENT: no such file or directory"** on
  Windows ("name too long" elsewhere). Every filesystem caps one name at 255
  characters, and the `.syncto_tmp` suffix used while a file is written pushed
  a 246-character name past it. The temporary name is now shortened when it
  has to be, so a name that fits at the destination is copied under that very
  name. Same fix for timestamped revisions and for servers.
- 🔴 **A file that could not be read for an instant during the comparison was
  taken as absent**: MIRROR then deleted the backup copy, 2 WAYS propagated a
  "deletion". It is asked again; if it still cannot be read, the folder is
  reported and the run blocked (unless the item is filtered out or system
  litter).
- 🔴 **Pairs sharing a folder could lose an edit everywhere.** Before replacing
  or deleting a file, syncto now checks it is still the one the comparison
  saw; a file changed since is left alone and reported. A file already
  identical (written meanwhile by an overlapping pair or job) counts as done.
- 🔴 **A file the recycle bin refused was deleted for good**, with nothing said
  (and a version about to be replaced was lost on the retry). It is now kept
  and reported.
- **A new file that got a deleted file's id back was taken for a move**: the
  destination kept the old content under the new name. A move now also needs
  the same date and an unchanged copy on the other side.
- **Comparison by content, 2 WAYS / UPDATE**: a difference neither side made
  (one copy damaged) is a conflict instead of being ignored at every run.
- **Two names differing only by case** (Linux, servers): neither is
  synchronized any more. MIRROR used to overwrite the backup of one with the
  other.
- A checksum list written with another algorithm is no longer emptied; lists
  are rewritten only on the side that changed.
- The same folder reached under two spellings in one job no longer stops the
  run with "lock lost".
- The history of a re-pointed pair is carried over only when neither folder
  already has one under the new paths.
- A run cancelled before its read-back no longer records the copies as
  synchronized.
- Files named `constructor`, `__proto__`, `toString`… synchronize in 2 WAYS.

### Security

- Opening a job received from someone else no longer makes Windows connect to
  a network path it names (which presents your login to that machine).
- A password saved for a server on port 22 is no longer sent to another port
  of the same server.
- A crafted `.syncto.db` placed in a synchronized folder can no longer exhaust
  memory; checksum lists are read up to a sane size.
- Nothing is written through a symbolic link sitting in the destination
  (files, folders, moves): it could put files outside the chosen folder.
- Environment variables are no longer expanded in server addresses.
- *Reveal* shows a folder instead of opening it (a folder named
  `Something.app` would launch).

### Window

- The end of a run no longer drops the strip to 0 % / "undefined".
- Auto-sync runs show the right labels; every comparison starts from 0 %
  (CHECKING began at 99 %); PAUSED is not undone by a late update; waiting for
  another machine reads WAITING.
- Menu shortcuts (⌘T, ⌘N, ⌘O, F9) and Space do nothing during a run.
- Progress never goes past 100 %, ends at 100 % (also with the read-back off
  on a server, or a failed pair), and counts runs that only delete.
- Escape in the Filter window leaves without applying; an error card no
  longer keeps "Compared again" from the previous run; the confirmation no
  longer says both "trash" and "no trash"; the verify ring starts uncoloured.
- Disabled buttons look disabled, conflicts are orange (red is for
  deletions), ERRORS is red only above zero, "reduce motion" also stops the
  spinning ring and CANCEL's glow.
- Small windows keep the whole run strip; long file names no longer run under
  PAUSE / CANCEL; the server port field is narrow again.
- Counts have thousands separators; the Overview shows 123k with the exact
  count on hover; mode names are spelt as on their buttons; "Total ETA".
- Copying a list (errors, notes, damaged files) reports a refusal of the
  clipboard instead of saying "copied".

## Added

- **Names that fit nowhere are saved under a short name.** A name over 255
  bytes or 255 characters (an Arabic title of 130 letters, say: two bytes per
  letter) is written at the destination as
  `<beginning of the name>~<8 characters>.<ext>`, and the run says so in its
  notes, once. The 8 characters come from the full name, so every later run
  pairs the two: updates go to the short copy, 2 WAYS brings its edits back to
  the original, MIRROR deletes it with the original. Renaming the original
  ends it. Folders are handled the same way.

## Changed

- **The end-of-run action (quit, sleep, shut down) never fires while
  auto-sync is on**, whether the run was started by auto-sync or by hand.
  Auto-sync stays on and the status line says the action was skipped. Until
  now the first clean cycle turned auto-sync off and shut the machine down.
- **Electron 43 → 44** (44.7.0, Chromium 152, Node 24.21).
- **macOS 13 (Ventura) or later is required.** Electron 44 does not start on
  older systems. The disk image used to declare macOS 11, already below what
  recent Electron versions need; it now declares 13, so an older Mac refuses
  it at once instead of installing an application that cannot open.

## Removed

- The unused "open this path" channel between the window and the rest of the
  application.

## Upgrading

Nothing to do. Job files and databases from 0.8.7 open as they are.

- **Mac users on macOS 11 or 12: stay on 0.8.7.** This version will not start.
- If you combined auto-sync with *Shut down*, the machine now stays on: that
  combination used to stop auto-sync after its first clean cycle.
- A file saved under a short name is paired with its original by name. Do not
  rename the short copy at the destination: in 2 WAYS it would then be taken
  for a new file, and the original for one deleted on the other side.
- Encrypted shared folders on a Synology accept names of 143 characters at
  most. A name between 144 and 255 still fails there.

## Platforms

- **macOS 13 or later** (Apple silicon): `.dmg`, signed and notarized.
- **Windows 10 or later** (x64): portable `.zip`, and `.exe` installer. Not
  signed: SmartScreen warns on first launch.
- **Linux** (x64): AppImage and `.deb`.

## Building from source

```bash
git clone https://github.com/noar-justedit/syncto.git
cd syncto
./build_mac.command           # macOS .dmg, signed + notarized when a Developer ID is in the keychain
./build_windows.command       # Windows .zip (and .exe with Wine), from a Mac
bash scripts/build-linux.sh   # AppImage + .deb, on a Linux machine
```
