# Changelog

All notable changes to syncto are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/lang/fr/).

## [0.3.0] — 2026-08-22

Reaching a server no longer means typing an `sftp://` URL from memory into a
field that otherwise expects a local path. And passwords are no longer stored
in a readable file.

Jobs (`.syncto`), sync databases (`.syncto.db`) and checksum lists are
unchanged. The preferences file changes shape once, on first launch.

### Added

- **A server button in every folder field.** The Lucide *server* glyph, beside
  **Browse**, in Source, in Destination, and in every additional pair. It opens
  a window that asks for the address, the port, the login, the password or a
  private key — and then lets you walk the server's folders and pick one. The
  field still ends up holding an `sftp://` URL, so existing jobs and the engine
  are untouched; nobody has to write one any more.
- **A remote folder browser.** One level at a time, with a clickable path and a
  **New folder…** button, because "the destination does not exist yet" is the
  normal state of a new backup target. Only folders are listed — a destination
  is a folder, and listing the files of a rushes directory would mean tens of
  thousands of unpickable rows.
- **Saved servers.** Named, listed at the top of the window, one click to fill
  everything in. This is what actually removes the friction: without it, typing
  a URL would just have become filling five boxes.
- **A private key field**, next to the password. The engine already accepted
  one; there was no way to enter it. Only the path is stored, never the key.
- **Connection errors in plain language.** ssh2 says "All configured
  authentication methods failed"; syncto now says which login was refused and
  what to check. Same for a wrong port, an unreachable host, and a timeout.

### Changed — worth knowing

- **Passwords move to the operating system's credential store.** Up to 0.2.6
  they sat in `preferences.json` in plain text. They are now encrypted through
  Electron's `safeStorage`, which is backed by the **macOS Keychain** and by
  **DPAPI on Windows**. On first launch, any password already in that file is
  moved and the readable copy deleted; a `password` key cannot survive a write
  from then on, whatever puts it there.
  **The deliberate limit:** if a machine has no usable credential store, syncto
  does *not* fall back to writing the password down. It says so in the window
  and asks each time.
  **Why not keytar,** the usual answer to this: it is a compiled native module.
  syncto has none, and that is precisely why a Windows build can be produced
  from a Mac. One native dependency would have ended cross-building — for a
  password field.
- **A remembered password never reaches the interface.** It is decrypted in the
  main process, used for the connection, and dropped. The window only ever
  learns that a password exists.
- The URL written into the field carries the login and the host, never the
  password — it is displayed, saved into `.syncto` files, and printed in
  reports.
- The placeholder in both fields no longer advertises URL syntax.

### Fixed

- `SftpFs` gained `realpath`, so the browser opens in the login directory
  instead of at `/` on an archive server with two hundred entries at the root.

### Tests

268 checks, up from 244.

---

## [0.2.6] — 2026-08-22

Two interface fixes. Nothing in the synchronization engine changed, so 0.2.5
jobs, databases and checksum lists carry over untouched.

### Fixed

- **"Show identical" came back ticked at every launch.** Clicking the
  *identical* chip in the statistics bar switched it on behind the user's back
  — the window's way of making those rows visible — and the next write to
  `preferences.json` made that permanent. Nothing ever switched it off again,
  and nothing said it had happened, so the setting looked like it defaulted to
  on. Filtering on that chip now tells the engine to include those rows
  directly, and the switch stays exactly where you left it. On first launch of
  0.2.6, a value stored by the old behaviour is cleared once (the preferences
  file carries a revision number for this); anything you set deliberately
  afterwards is kept.
- **The overview listed every folder even when there was nothing to do.** Zone
  2 walked the whole compared tree, so two folders already in sync still filled
  it with rows and percentage bars describing work that did not exist. A folder
  now has to carry actual work to appear, and its size is the data that will
  really cross — not the size of what is already sitting there, which made the
  bars meaningless. Two folders in sync leave the panel empty, with one line
  saying so. Ticking **Show identical** puts the whole tree back, for when you
  want to click a folder that is *not* changing and find it in the grid.
  A deletion still shows its folder, at zero bytes: it is work, but nothing
  travels.

### Tests

244 checks, up from 228. Six cover the overview and the switch.

---

## [0.2.5] — 2026-08-20

A full audit of 0.2.4 and the repair of everything it found: 36 issues, six of
which could lose data. The engine test suite grows from 179 to 228 checks;
every fix below has a regression test that fails on 0.2.4.

Jobs (`.syncto`), sync databases (`.syncto.db`) and checksum lists carry over
untouched.

### Fixed — data loss

- **An unmounted source folder made a mirror delete the whole target.** The
  comparison recorded "Left folder not found — it will be created" without
  marking it fatal, so an absent base folder (ENOENT — an ejected drive, a
  dropped share) read as an empty side, every file on the healthy side became
  one-sided, and mirror removed the lot. A missing base folder now stops the
  run whenever the plan would delete anything on the other side, and says which
  side is gone. Creating a missing *target* still works exactly as before.
- **Overwriting destroyed the replaced version in silence.** `archiveExisting`
  returned quietly where the delete path throws: with "keep every version"
  selected and a revision folder set on one side only — which `migrateJob`
  allows, since it only falls back to the trash when *both* are empty — the
  file being replaced was simply gone. Same hole when the location has no
  recycle bin (SFTP, most NAS) or the bin refused the item: the return value
  was never checked. An overwrite is a deletion with a copy on top, and it now
  gets the same guarantees — if the previous version cannot be kept, the copy
  is refused and the target keeps its content.
- **Swapping the two sides did not invalidate the comparison.** The engine
  looped over the folder pairs memorised at the last comparison and never
  looked at the ones on screen, while the confirmation dialog read the new
  ones. Swapping the sides to restore B onto A therefore mirrored A onto B.
  Same for editing a path or loading another job — which also brought that
  job's `deletion` setting, turning planned trash removals into permanent ones.
  The engine refuses a plan whose folders have changed, and the window clears
  the plan as soon as they do.
- **A machine was identified by hostname and user name.** Two Windows PCs
  deployed from one image, or two Macs on their factory name, matched — so each
  read the other's *live* lock, checked that process id against its own process
  table, found nothing and took the folder. Both then wrote the same files.
  Every installation now carries an id of its own (`~/.syncto/install-id`); a
  lock that cannot be proved ours takes the slow, always-correct path of
  watching for twelve seconds of silence.
- **A dropped SFTP connection froze the run for ever.** ssh2 discards requests
  issued on a closed channel without ever calling back, so the first operation
  after a sleeping laptop or a lost Wi-Fi blocked the request queue — and with
  it the whole run — with no error, no progress, and an Abort button that could
  not fire. The channel is now watched, every request carries a deadline,
  transfers in flight are torn down with a real error, and a connection that
  never became usable is closed instead of being left running.
- **The heartbeat never re-checked ownership, and release deleted whatever was
  there.** If the share went away for longer than the abandonment window,
  another machine legitimately took over — and the old owner carried on
  writing, its blind append feeding the *new* owner's lock file, then deleted
  that lock at the end of its run and let a third machine in. The heartbeat now
  verifies the lock is still ours and stops the run when it is not; release
  only removes a lock it still owns.

### Fixed — silent failures

- **`preserveTimes: false` made two-way jobs copy the same file for ever.** The
  database recorded the source's date as the target's, so both sides looked
  changed at every run and the file bounced back and forth — and became a
  permanent conflict if it was edited in between.
- **A cancelled comparison was presented as a complete one.** The byte-for-byte
  comparison returned "different" for files it had not finished reading, the
  walker left the tree truncated, and the timestamp was set anyway, so
  SYNCHRONIZE came back enabled on a partial plan and the summary said
  "Completed successfully". An interrupted comparison is now marked as such,
  the grid says the list is partial, and synchronizing is refused.
- **"Ignore errors" was never read.** The checkbox was saved, loaded and passed
  to the engine, which referenced it nowhere: the run always carried on.
  **Behaviour change worth knowing:** the setting is off by default, so a run
  now stops at the first error instead of pushing through. Stopping is
  graceful — the database and the report are still written from what really
  happened. Tick "ignore errors" for the old behaviour.
- **A database that could not be written was a footnote.** It was recorded as a
  note, not an error, so the report showed "Completed successfully" — and the
  next two-way run, reading yesterday's state, put back the file you had just
  deleted. It is now an error, counted and reported.
- **`.syncto.db` was rewritten in place.** The stream truncated it on open, and
  a single file holds the history of every pair based in that folder, so an
  interrupted write silently reset all of them to "no database yet". It is
  written beside and renamed, like everything else the engine writes. A
  database that exists but cannot be read is now reported as damaged rather
  than as missing.
- **Deleting a folder through the recycle bin took the filtered files with
  it.** The trash path bypassed the sweep that removes only OS litter and lets
  `rmdir` fail loudly on anything else, so files hidden by an exclude filter —
  excluded precisely so syncto would not touch them — went to the bin inside
  their parent folder.
- **A truncated file could replace a good one at the fast copy level.** ssh2
  reports a write as finished before the server has acknowledged the close, and
  a quota or disk-full error arrives in that acknowledgement. The size check
  before the rename now runs at every level; one stat against a whole file copy
  costs nothing.
- **Verification could not report that it had not verified anything.** The
  cache flush swallowed its own failure, including the EACCES it hit whenever
  `copyPermissions` had just made the file read-only. It reports now, and the
  run says so once. Worth knowing, and deliberately not overstated in the
  interface: fsync guarantees the data left the write cache; it does not
  invalidate the read cache, and Node offers no portable way to do that. The
  secure level catches a truncated or mis-written file. It is not a media test.
- **Replacing a file over SFTP deleted the target before renaming.** Between
  the two there is a full network round trip; a connection that dropped in that
  window left nothing at the destination — old version deleted, new one still
  under its temporary name. The old file is moved aside instead, and put back
  if the rename does not go through.
- **A stray takeover file blocked every lock, for ever.** The takeover always
  renamed to the same name and deleted it best-effort; one interruption left
  the file behind, and since SFTPv3's rename refuses an existing target, every
  later takeover failed silently and the window sat on "Waiting for…" until
  someone deleted the file by hand on the server. Several slots are tried now,
  a stale one is cleared, and a takeover that genuinely cannot proceed says so
  with the path to fix.
- **`renameStrict` was a plain rename**, which overwrites the target silently on
  both POSIX and Windows — so the "exactly one machine wins" guarantee the lock
  is built on was not true. It uses a hard link and fails with EEXIST, falling
  back to check-then-rename only where links do not exist.
- **A folder that could not be listed was synchronized without a lock.** A
  catch-all treated a permission error or a network hiccup as "does not exist
  yet" and skipped the lock in silence. Real errors surface, and a folder that
  genuinely is not there yet is created and locked — two machines starting
  their first backup into the same new share were both unprotected until the
  second run.
- **Accented file names were duplicated on Linux servers and Windows shares.**
  macOS hands back decomposed names (NFD); the destination path was built from
  the source spelling, so a file already there in composed form (NFC) got a
  twin — and the run after that reported the pair as differing only by case and
  stopped synchronizing one of them. Each side now keeps the spelling it really
  has on disk, and the key shared by the two sides is the composed form.
- **A failed SFTP connection stayed alive.** Ten attempts against a
  misconfigured server left ten sockets and their keepalive timers running
  until the app quit, and the server started refusing everyone. The failure is
  no longer cached either, so a retry after the network comes back is a real
  retry.
- **Symlinks were re-copied at every run.** The recreated link carried today's
  date and there was no `lutimes` to fix it, so it looked newer for ever — and
  under versioning, a revision was archived every night. The date is set on the
  link itself now, and where that is impossible (SFTP) the comparison asks what
  the two links point at before calling one newer.

### Fixed — the application itself

- **No content security policy, no navigation guard.** The window holds the
  whole IPC bridge — reading any folder, running a file with its default
  application, the stored SFTP credentials — and Electron's default for a
  window-open handler is "allow", so a child window would have inherited the
  preload. Dropping an `.html` file on the window during the moment before the
  drop zones are installed navigated the main view, and the page that loaded
  kept the bridge. A policy is now applied as both a meta tag and a response
  header, navigation is confined to syncto's own page, external links go to the
  browser, and `<webview>` is refused outright.
- **`shell.openExternal` accepted any scheme, from a remote JSON.** The update
  notice passed the URL out of `version.json` straight to the operating
  system's "open this" machinery; a `file://` or UNC value there means "run
  this program". Only http and https are opened, the notice always points at
  the releases page, the response body is capped, redirects may not leave the
  host, and the callback can no longer fire twice.
- **`preferences.json` and `.syncto` files were written in place.** An
  interruption left a truncated file: a blank application on the next launch —
  recent jobs, window size and SFTP credentials gone with no message — or the
  user's own job file destroyed. Both are written beside and renamed.
- **Resizing the window wrote the whole configuration to disk on every pixel.**
  No debounce, a deep merge and a *synchronous* write, in the process that runs
  the synchronization: dragging a corner during a large transfer stalled the
  event loop, the progress updates and the throughput. Debounced to 400 ms.
- **Saving could replace an existing job without asking.** The dialog checked
  the name typed, then the code appended `.syncto` to it — so the system's
  overwrite warning never applied to the file actually written. syncto asks.
- **The re-comparison after a run left the buttons live.** It never claimed the
  busy flag, so a second comparison could start and close the filesystem pool
  underneath the first one.
- **Any failure to open a recent job deleted it from the list.** An unmounted
  share or a damaged file was read as "the file is gone" and the entry vanished
  without a word. Only a genuine ENOENT drops an entry; anything else is
  reported and the entry kept.
- **A hand-edited job file could freeze the window.** A `null` section replaced
  a whole default and the redraw threw halfway through, with the path fields
  already updated and the rest still showing the previous job. Sections are
  validated on load.
- **`lastJobPath` was written and never read**, so a restart detached the
  settings from their file: the title said "not saved yet" and Ctrl+S asked for
  a name again — the short road to overwriting a different job.
- **Failed copies were counted as copies.** Reports read "Files copied: 10 ·
  Errors: 3" with the number that actually landed appearing nowhere. The
  summary shows "Files not copied" separately.
- **Leftover `.syncto_tmp` files were never removed.** Invisible to the
  comparison by design, swept by nothing: an interrupted 180 GB copy sat on a
  NAS for ever and the space disappeared with no explanation in the app. They
  are removed at the end of the next run, and the run says how much it
  reclaimed.
- **The size filter judged a two-sided file on the left copy alone**, so a file
  edited yesterday on the right was dropped because the left copy was a year
  old. Either side passing is enough.
- **An interrupted revision kept a good version's name.** `pipe` does not
  forward errors, so a broken read left a truncated file in the revision store,
  indistinguishable from a valid one when restoring. Revisions are written
  beside, size-checked, then renamed.
- **Windows long paths.** `.syncto_tmp` adds twelve characters, enough to push
  a legal name past 260 and fail the copy with ENOENT on a path plainly visible
  in Explorer. Long paths get the `\\?\` prefix.
- **A file named `a\b.txt` on a Linux server was treated as a path.** The SFTP
  backend translated every backslash into a separator. It no longer does —
  these are POSIX paths.

### Files

Two new names to know: `~/.syncto/install-id`, the per-installation identifier
the lock uses, and `*.syncto_old`, a target parked for a moment while its
replacement is renamed over it on SFTP. A stray one is swept like any leftover.

### Documentation

`docs/AUDIT-0.2.4.md` records the audit itself: every issue with its file, its
line and the situation that triggers it.

---

## [0.2.4] — 2026-08-10

### Fixed
- **The first folder pair could not be removed.** Pairs 2 and beyond had a ✕
  button; pair 1 — the big SOURCE/DESTINATION fields — did not, so a
  multi-pair job could never drop back below its original first pair. Pair 1
  now shows the same ✕ as every other pair, hidden only when it is the job's
  last remaining pair (exactly like the others). Removing it promotes pair 2
  into the main fields, same as removing any other pair shifts the ones below
  it up.

---

## [0.2.3] — 2026-08-09

### Changed
- **New application icon.** The Lucide-derived glyph on a dark rounded square is
  replaced by the Just Edit artwork: a violet folder with the sync arrows, drawn
  as a shape on a transparent background. Every embedded asset is regenerated
  from `build-resources/icon.svg` — `icon.icns` (10 representations up to
  1024 px), `icon.ico` (16 → 256 px), the 1024 px master and the Linux set.
  Nothing else in the build configuration changes.
  **Worth knowing:** macOS caches application icons aggressively. If the old one
  survives an upgrade, move the `.app` or run `killall Dock`.

### Fixed
- **Warning text was broken mid-word.** The warning block in the confirmation
  dialogs (auto-sync, copy errors) used `word-break: break-all`, which is right
  for file paths and wrong for sentences: the auto-sync warning read
  `with th / e current settings` and `as a r / eminder`. It now uses
  `overflow-wrap: anywhere`, which only breaks a word that genuinely does not
  fit, so paths still wrap and prose reads normally.

### Tooling
- `scripts/gen-icons.py` regenerates every icon asset from the SVG on any
  platform (needs `cairosvg` and `pillow`); `scripts/make-icon.sh` stays the
  macOS path and now prefers `rsvg-convert` over `qlmanage`, which could flatten
  the transparent background into white.
- `scripts/shots.js`, `scripts/shot-steps.js` and `scripts/shot-dataset.sh`
  produce the README screenshots by driving the real application through the
  DevTools protocol. No screenshot is retouched and nothing in the shipped code
  is modified to accommodate them.

### Documentation
- Screenshots retaken at 1440×900 @2×, on a two-pair job with realistic paths
  and file names. Three new ones: the copy phase, the verification pass and the
  end-of-run summary.

---

## [0.2.2] — 2026-08-08

### Changed
- **Verification is now a second pass, like ingesto.** Every file is copied
  first; only once the whole copy phase is finished does syncto read everything
  back and compare fingerprints. It used to verify each file inline, before
  giving it its final name.
  **Consequence worth knowing:** a file that fails verification already carries
  its final name, so it has already replaced the previous version. It is
  reported as an error, excluded from the checksum list, and deliberately *not*
  recorded in the synchronization database — the next run looks at it again. The
  cheap size check still runs before the rename, so a truncated copy never lands
  under a good name.

### Fixed
- **The verification pass was invisible.** Only the written bytes counted
  towards the progress, so the ring froze during the read-back and nothing said
  why. Verification is now half of the planned work and has its own phase,
  styled like ingesto: the title reads `VERIFYING · SECURE` and the ring, the
  top bar and the label turn blue. Speed and ETA include the verification I/O,
  which is what actually determines how long a secure run takes.
- The summary now reports how many files were verified.

### Fixed by the full-code review (32 regression tests added)

*Data safety*
- **An unreadable folder was treated as an empty one.** A permission error or a
  dropped network share during the comparison made every file on the healthy
  side look one-sided — and a mirror would have deleted them. Unreadable
  directories are now a fatal comparison error: the affected subtree is left
  out entirely, and synchronizing on top of a broken comparison is refused (the
  auto-sync skips it too). The same rule now applies to `stat` on both backends:
  "permission denied" is an error, never "absent".
- **A name-only include filter synchronized almost nothing.** Include `*.jpg`
  pruned every folder (no folder is named `*.jpg`), so files in subfolders were
  never reached. Name-only include masks no longer prune folders.
- **Two-way: a file identical on both sides but unknown to the database was an
  unresolvable conflict** ("both sides have changed", forever, since conflicts
  are skipped and skipping preserves the stale entry). Identical-right-now is
  now in sync, whatever the database believed.
- **Two-way: folder mtime drift produced perpetual folder conflicts.** Folder
  dates carry no sync meaning and are now ignored by the database check.
- **Cancelling a run threw everything away.** The database and the report were
  skipped, so the next two-way run re-discovered (and could mis-judge) work
  that had actually completed. A cancelled run now ends cleanly: partial
  results, report and database are all written.
- The failure of a "preserve the date" step is now noted, and the database
  records the target's real date — it used to record the wish, guaranteeing a
  spurious re-copy.
- The move fallback (when a rename is refused) now goes through the fail-safe
  temp file like every other copy.

*Locking*
- The takeover of an abandoned lock over SFTP could fall back to a
  delete-and-retry rename, breaking the one guarantee the rename provides (a
  single winner). Takeovers now use a strict rename on every backend.
- Locking a destination folder that does not exist yet made the first sync into
  it fail; such folders are now skipped (the run creates them).
- A generic SFTP failure during lock creation (reported as "exists" by SFTPv3)
  caused a sleepless retry loop; the acquire now paces itself and gives up with
  the real error after a few attempts.
- The heartbeat could recreate the lock file just after release; release now
  waits for the in-flight beat.

*Correctness & robustness*
- Legacy jobs: `copyLevel: "pro"` now maps to `secure` (it silently degraded to
  a FAST copy); `deletion: "versioning"` with no revision folder falls back to
  the trash.
- The checksum sidecar is merged run after run instead of being overwritten
  with only the latest run's files.
- Database entries hidden by the current include/exclude filter keep their
  history instead of being erased.
- Overwriting a symlink no longer fails with EEXIST (and a dangling symlink at
  the destination is no longer mistaken for an absent file).
- A folder containing only OS litter (`.DS_Store`, `Thumbs.db`…) can now be
  deleted permanently.
- Two names differing only by upper/lower case are reported instead of silently
  colliding.
- Multi-pair: errors were counted twice; one failing pair discarded the results
  of the pairs already done; the progress ring mixed two byte units during a
  secure run and could jump backwards; a job-level pair id made pairs sharing a
  base folder overwrite each other's database session. All fixed.
- A failed or cancelled comparison no longer leaves the previous "compared"
  state standing.
- Interface: quotes in file names could break out of HTML attributes; Escape
  now goes through each dialog's own close logic (settings persist, filter
  re-compares, verify cancels); the cleanup phase no longer claims to be
  copying; the row selection is dropped when the tree is re-compared.

### Removed
- **The PRO copy level**, and everything that existed only for it: the
  xxHash128 / MD5 / SHA-256 selector and the always-on checksum sidecar. SECURE
  covers the same ground with xxHash64, and the checksum list stays available as
  a switch in the settings. Jobs saved with `copyLevel: "pro"` are migrated to
  SECURE automatically.
- Dead code swept out: unused backend methods (`statFollow`, `freeSpace`),
  unused exports (`ALGOS`, `VARIANTS`), orphan CSS rules, a stale preference
  key, and the `--pro` colour variable (renamed `--violet`, which is what it
  is).

## [0.2.1] — 2026-08-08

### Added
- **Directory locking.** A `.syncto.lock` file at the root of each synchronized
  folder means one machine at a time. Ported from FreeFileSync's design, which
  needs no OS locking primitive and therefore works over SMB, AFP, NFS and SFTP:
  a heartbeat appends one byte every 5 s, a waiting machine polls every 2 s and
  presumes the owner dead after 12 s of silence. A lock left behind by a crash on
  the same machine is reclaimed immediately (the process id is checked directly);
  taking over an abandoned lock goes through an atomic rename to
  `Delete.0.<name>` so two waiting machines can never both proceed. The interface
  shows which machine and user is holding the run. Switchable off in the settings.

## [0.2.0] — 2026-08-08

### Added
- **Multi-pair jobs.** One job synchronizes any number of folder pairs, all
  sharing the same settings, in a single compare/synchronize. Each pair has its
  own row of SOURCE/DESTINATION fields; the merged grid separates them with a
  header line, and statistics, overview and report are aggregated.
- **Moved-file detection.** A renamed or moved file is recognized by its file id
  and replayed as a rename on the other side — a folder reorganization costs
  seconds instead of a full re-copy. Requires one previous run of the pair and a
  filesystem exposing inodes (not SFTP).
- **Auto-sync.** Compare + synchronize every N minutes, armed only after an
  explicit confirmation, with the window framed in red while it runs. Never arms
  itself: a restart always starts disarmed.
- **Per-job filters** behind a funnel button, with a clarified anchoring rule —
  a pattern without `/` matches the item's name at any depth, a pattern starting
  with `/` matches one exact path.
- **Context menu** on grid and overview rows: exclude temporarily (Space),
  include via filter, exclude via filter — with ready-made patterns.
- **FreeFileSync converter** (`scripts/ffs-convert.js`): `.ffs_gui` / `.ffs_batch`
  to `.syncto`, all folder pairs included.
- Update check against `version.json` on this repository, with a dismissible
  notice.
- Resizable panels, drag and drop of a volume or folder anywhere in the window,
  version shown in the footer.

### Changed
- Job files use the `.syncto` extension; the file name IS the job name.
- Interface reorganized into four zones (jobs, overview, source, destination)
  with the synchronization modes on top and the copy modes at the bottom, in the
  ingesto button style.
- Colour code across the grid: green added, orange updated, red struck-through
  deleted, violet renamed — applied to the full path.
- Excluding a folder now excludes its whole subtree.
- Checksum list and report are off by default.

### Removed
- Versioning (revision folders), time tolerance, time shifts, symlink policy and
  the size filter are no longer exposed in the settings. The engine keeps safe
  defaults for the comparison ones.

## [0.1.0] — 2026-08-08

Initial release. Comparison (time & size, content, size), four synchronization
variants (2 Ways, Mirror, Update, Custom), synchronization database for two-way,
four copy levels up to xxHash128 with checksum sidecar, fail-safe copy,
include/exclude filters, HTML/CSV/JSON reports, SFTP support, folder verification
against a checksum list.
