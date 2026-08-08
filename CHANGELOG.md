# Changelog

All notable changes to syncto are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/lang/fr/).

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
