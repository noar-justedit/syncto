# syncto 0.8.6

A folder picked again keeps its two-way history, and syncto's own files no
longer show up in Windows Explorer.

**1163 checks pass**, up from 1106 at 0.8.5.

## Fixed

- 🔴 **A re-pointed pair keeps its history.** syncto files the history of a
  pair (what both folders looked like after the last run) under its two paths.
  Picking a folder again (a renamed drive, a volume that came back as
  "NAS 1", the relink window) therefore started from nothing, and in
  **2 WAYS** a file deleted on one side since the last run was copied back from
  the other. syncto now remembers the paths a pair had before you changed them
  and reads the history there, only when both folders hold the very same copy
  of it. Pointing at a *different* folder still starts fresh, exactly as
  before, and swapping the two sides is never mistaken for a re-point.

## Changed

- **`.syncto.db` and `.syncto.lock` are hidden on Windows.** The leading dot
  hides them on macOS and Linux, but Windows ignores it, so both sat in plain
  sight in every synchronized folder. syncto now gives them Windows' *hidden*
  attribute. `syncto-checksums.txt` stays visible: it is the proof of the
  read-back, meant to be found.
- **Build launchers renamed**: `build_mac.command` and `build_windows.command`,
  at the top of the folder (they were in `scripts/`).

## Added

- `scripts/push_github.command`, for maintainers: publishes the folder to
  GitHub, removals included, only for a new version, and holds `version.json`
  back until the Release exists.
- `AGENTS.md` and `ETAT_PROJET.md` (in French): working rules and state of the
  project, so anyone, or any AI assistant, can pick it up from the repository
  alone.

## Upgrading

Nothing to do. Job files and databases from 0.8.5 open as they are.

- A job saved by 0.8.6 may carry the former paths of a re-pointed pair; an
  older syncto simply ignores them.
- On Windows, existing `.syncto.db` files become hidden at the next run. To
  delete a leftover `.syncto.lock` by hand, turn on **View › Show › Hidden
  items** in Explorer.

## Platforms

- **macOS** (Apple silicon): `.dmg`, signed and notarized.
- **Windows** (x64): portable `.zip`, and `.exe` installer. Not signed:
  SmartScreen warns on first launch.
- **Linux** (x64): AppImage and `.deb`.

## Building from source

```bash
git clone https://github.com/noar-justedit/syncto.git
cd syncto
./build_mac.command        # macOS .dmg, signed + notarized when a Developer ID is in the keychain
./build_windows.command    # Windows .zip (and .exe with Wine), from a Mac
bash scripts/build-linux.sh   # AppImage + .deb, on a Linux machine
```
