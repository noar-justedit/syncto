# Changelog

All notable changes to syncto are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/lang/fr/).

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
