# syncto 0.9.2

A ntfy button in the title bar.

**1609 checks pass**, up from 1597 at 0.9.1.

## Added

- **One click for the phone notifications.** A bell sits in the title bar:
  green when ntfy is on, struck through when it is off. A click flips it and
  saves it. If no topic is set yet, the click opens Settings on the topic
  field.
- The title bar now reads, left to right: **ntfy, Settings, end action**.

## Upgrading

Nothing to do. Your ntfy settings, jobs and saved servers open as they are.
This release also carries everything in [0.9.1](RELEASE-0.9.1.md) (FTP, FTPS,
filo's transfer engine) if you are coming from 0.9.0 or older.

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
