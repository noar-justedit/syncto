# syncto 0.9.0

A full audit of 0.8.9 (engine, security, window, speed), and everything it
confirmed. A plan can no longer change behind the confirmation, nothing is
written through a link planted in a folder, filters keep protecting what they
name with Windows-safe names on, and the window shows what a run really does.

**1475 checks pass**, up from 1346 at 0.8.9.

## Fixed

### Data and decisions

- 🔴 **Clicking VERIFY erased the synchronization mode.** It sits in the
  modes row without being one: the job then ran, and was saved, as MIRROR,
  which deletes.
- 🔴 **Changing the mode or a comparison setting after a comparison kept the
  old plan.** Compare in MIRROR, click UPDATE: the confirmation said UPDATE
  and the MIRROR plan ran, deletions included. The engine now refuses a plan
  made with other settings (mode, comparison method, filters, move detection,
  date repair, Windows-safe names, custom directions), and the window drops
  the comparison as soon as one of them changes.
- 🔴 **The keyboard could change the plan during a run**: Tab and Enter still
  swapped a pair, changed the mode, added a pair, opened Filter or auto-sync.
  Everything that shapes the plan is out of reach during a comparison and a
  run, keyboard included, and the settings that shape it are greyed out.
- 🔴 **Windows-safe names: a filter written with an item's real name stopped
  applying.** `/Archive: old/` matched nothing once the item was known as
  `Archive_ old`, and MIRROR deleted the folder it was meant to protect. A
  filter now matches either spelling.
- **A detected move could overwrite a file that appeared at its new name
  after the comparison.** It is refused and reported, as a copy already was.
- **A live lock could be taken over when the NAS clock runs behind** (two
  machines then wrote the same folder). A lock is now judged old by the
  disk's own clock.
- **2 WAYS: deleting a file whose name was too long for the destination
  brought it back** under its short name. The short copy is now deleted, and
  moving such a file is a move again, not a copy.
- Two pairs writing to the same destination: the second one stopped, copying
  nothing, when the first had already renamed a name for Windows.
- Rows that were unticked, filtered out, in conflict or set to "do nothing"
  were renamed for Windows all the same (on the source too, in "Both
  sides").
- A name both too long and refused by Windows, created on the destination,
  was not paired again with its copy at the source.
- The checksum list kept a renamed file under its old name (Verify Folder
  called it missing), and a name holding a line break (the Mac's `Icon` file)
  broke its line in two. Such names are now escaped as `md5sum` does.
- A temporary file left inside a folder renamed in the same run stayed until
  the next run.

### Security

- 🔴 **Nothing is written through a symbolic link planted under a name
  syncto writes**: the database and its temporary copy, the checksum list,
  the recycle-bin probe, the temporary copy of a file. Anyone able to write
  in a synchronized folder (a shared NAS, a drive handed over) could make a
  run overwrite any file of yours outside it, without a word. On macOS and
  Linux a write never follows a link any more.
- Environment variables are no longer expanded in a network path
  (`\\host\share\%USERNAME%`): a job received from someone else could send
  their values to that machine.
- A server password written after a leading space
  (`␠sftp://user:pass@host`) was saved in clear in the job file and the
  preferences. It now goes to the credential store like any other.

### Window

- With many pairs, COMPARE, SYNCHRONIZE and CANCEL went below the bottom of
  the window. The pairs now scroll inside their card.
- A run stopped on an error said "Completed with 1 error". It now says it
  stopped, and why (a name that could not be changed for Windows, or an error
  with "Continue on error" off), with the reason first in the notes. With
  "Continue on error" off, the next pairs are not started.
- Lists cut short (errors, notes) say how much is missing.
- Renames for Windows are visible: in the list (blue, with the names they
  replace), a "Windows names" chip, the overview, the summary and the
  auto-sync line. A comparison planning only renames no longer says
  "Everything is in sync".
- Cancelling auto-sync's comparison no longer goes on to a run that fails
  and sends a "run failed" notification.
- Cancelling the check after a run is no longer reported as a failure.
- A failed call to the engine no longer leaves the window busy for good.
- The Errors and Notes panels show their scroll bar.
- Tooltips no longer stay on screen after their row is redrawn.
- Thousands separators in every count, in the same format whatever the
  system language.
- Pair labels with right-to-left names (Arabic, Hebrew) keep source →
  destination.
- Words: source and destination in the row tooltips, "Continue on error" as
  the setting is called, "Windows names"; shortcuts read Ctrl+ on Windows and
  Linux.
- Colours: connecting to a server is blue, excluding an item is not red, the
  size bars of the overview are neutral; sentences use the text font.
- A window that opens takes the keyboard focus and keeps it until it closes.
- Clearing leftover locks shows the countdown while each one is watched.

## Changed

- **Faster with big folders** (measured at 400 000 rows): unticking 500
  folders at once, 15.8 s → 0.06 s; scrolling the list with "show identical",
  28 ms → 4 ms a step; the database is no longer copied item by item (0.4 s)
  nor read twice when it has not changed (about 1.4 s per side); move
  detection, 0.8 s → 0.6 s; the list is filtered, not rebuilt, as files land.
  How files are read and written is unchanged.
- One fingerprint engine per lane instead of one per file.
- Leftover temporary files from an interrupted run are swept at the start of
  a run instead of the end.

## Removed

- A call between the window and the engine that had no handler, and unused
  styles.

## Upgrading

Nothing to do. Job files and databases from 0.8.9 open as they are.

- After changing the mode, the comparison method, a filter or a plan setting,
  press COMPARE again: SYNCHRONIZE stays grey until you do.
- While a comparison or a run goes on, the modes, the folders, the filter and
  the plan settings cannot be changed. The end-of-run action and the other
  settings still can.
- The checksum list may now hold lines starting with `\`: names with a line
  break or a backslash, escaped the way `md5sum` and `xxhsum` read them.

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
