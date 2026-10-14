# syncto 0.9.1

The transfer engine of [filo](https://github.com/noar-justedit/filo) now drives
syncto's servers. SFTP is faster on a slow link, and syncto speaks **FTP and
FTPS**. A file copied to a server is now checked by the server itself, so it no
longer has to come back over the network.

**1597 checks pass**, up from 1475 at 0.9.0.

If you come from a release older than 0.9.0, read
[RELEASE-0.9.0](RELEASE-0.9.0.md) too: this one is built on it.

## Added

- **FTP, FTPS (explicit TLS) and FTPS (implicit TLS).** Addresses `ftp://`,
  `ftpes://` (explicit, port 21) and `ftps://` (implicit, port 990), or pick
  the protocol in the server window. FTP also has a data mode: passive (the
  default, works behind a router) or active. Saved servers keep both.
- **The server computes the checksum.** While a file is written, syncto
  also hashes it (SHA-256, or SHA-1 / MD5 when that is all the server offers).
  The verification pass asks the server for the checksum of what it holds
  (`sha256sum` over SSH, `HASH` over FTP) and compares. Nothing crosses the
  network a second time. A server that cannot answer is read back as before,
  and the run says how many files were checked by the server.
- **FTPS certificates are pinned like SSH keys.** A certificate no authority
  signed is trusted the first time and remembered. A different one is refused
  before the login is sent. Forgetting a server forgets its certificate.

## Changed

- **SFTP runs on filo's pipeline**: the read depth grows with the round trip
  and the receive window follows it. Keyboard-interactive login is accepted.
  Host-key policy, locks and saved credentials are unchanged.
- An SSH password is never offered to an FTP server of the same name.
- Dates coarser than a second (an FTP listing without MLSD) widen the
  comparison tolerance, so files are not copied again for a minute of
  difference.

## What FTP cannot do

- **Locks are best effort.** FTP has no atomic exclusive create and no
  atomic rename: two machines racing for one folder can both win. Use SFTP or
  a mounted share when several machines write the same folder.
- No symbolic links, no file ids (a renamed file is copied again), no trash
  (deletion is permanent).
- A file's date is kept only on servers that support `MFMT`. The run says so
  when one does not.
- Plain `ftp://` sends the password and the files in clear. The window says
  so.
- Up to four connections to one server.

## Upgrading

Nothing to do. Job files, saved servers and databases from 0.9.0 open as they
are. A new dependency, `basic-ftp` (MIT), is bundled in the app.

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
