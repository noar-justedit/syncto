# syncto 0.8.9

Names a Mac accepts and Windows refuses can now be cleaned during the
synchronization, on the destination only or on both sides.

**1346 checks pass**, up from 1314 at 0.8.8.

## Added

- **Windows-safe names** (Settings › Main). A Mac lets you put `:` `?` `*`
  `"` `<` `>` `|` in a name, end it with a space or a dot, or call a file
  `CON` or `NUL`. Windows refuses all of these. Written to a share by a Mac,
  they come out on a PC as boxes or odd symbols (`Industry⍰ Digitalisation`).
  With the option on:
  - each refused character becomes `_`, including the private character a Mac
    writes in its place on a share;
  - a trailing space or dot is dropped;
  - a device name gets `_` (`CON.txt` → `CON_.txt`, `COM1.mov` → `COM1_.mov`).

  Parentheses, commas, `&`, apostrophes, `#` and accents are legal on Windows
  and are kept.

  Three settings:
  - **Off** (default): nothing changes.
  - **Destination only**: names created at the destination are clean, and
    names already there are renamed in place, without copying anything. The
    source is never touched; `Forum: Day 1` at the source and `Forum_ Day 1` at
    the destination stay paired at every run, in every mode, 2 WAYS included.
  - **Both sides**: the source is renamed too, before anything else. The
    confirmation lists the source items about to be renamed and warns that
    projects using them (Premiere, Resolve, After Effects…) will lose their
    links.

  Every rename is listed in the run's notes. Two names that become the same
  once cleaned (`a:b` and `a_b`) are both left out and reported, never merged.
  A rename that cannot be done stops the run before anything else happens.
- **The Mac's custom-icon file is left out** while the option is on. A folder
  with a custom icon holds a hidden file called `Icon` followed by a carriage
  return; on a PC it shows as "Icon" and a strange symbol, and it carries
  nothing useful there. It is neither copied, renamed nor deleted.

## Upgrading

Nothing to do. Job files and databases from 0.8.8 open as they are, and the
option is off until you turn it on.

- Turning it on changes how items are identified (by their cleaned name). On
  the first run after that, an item whose name gets cleaned has no history
  yet: syncto copies rather than deletes for it, as for a first run.
- Turning it off again: items cleaned earlier are no longer paired with their
  original. The cleaned copy is removed and the original copied again under
  its own name, which a Windows destination refuses. Keep the option on for a
  destination it has already cleaned.
- Do not rename a cleaned copy by hand at the destination: it would be taken
  for a new file, and in 2 WAYS its original for one deleted on that side.

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
