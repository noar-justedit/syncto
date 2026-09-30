# Security policy

## Reporting a vulnerability

Email **contact@just-edit.fr** rather than opening a public issue. Include what
you found, how to reproduce it, and what an attacker could do with it. Expect an
acknowledgement within a few days.

## Scope, honestly stated

syncto is a desktop tool that reads and writes folders you point it at. The
areas worth scrutiny:

- **SFTP credentials.** A password typed into a folder path
  (`sftp://user:pass@host/…`) is moved into the operating system's credential
  store (macOS Keychain, Windows Credential Manager, libsecret) as soon as it is
  seen, and the path is rewritten without it. Nothing readable is written to the
  preferences or to a `.syncto` job file. Where there is no usable credential store, syncto says so and asks
  for the password each time rather than writing it down.
- **Host key verification.** Since 0.8.0 the server's key is remembered at the
  first connection and compared at every one after. A key that has changed stops
  the connection **before any credential is sent**, and the message shows both
  fingerprints. Accepting a change is a deliberate act: forget that server in the
  connection window. There is no first-use prompt — the first key seen is trusted
  — so a first connection over a network you do not control is still a first
  connection over a network you do not control.
- **What the other side sends.** A name a server returns that is really a path
  (`../../…`) is dropped before it reaches the comparison, the engine refuses any
  relative path that would resolve outside the chosen folders, and the same rule
  is applied to the entries of a `syncto-checksums.txt` read back from a folder.
- **Path handling.** Job files come from other people sometimes. syncto expands
  `%macros%` and `~` in paths; a malicious job file could therefore point at any
  folder your user account can reach. Read a job file before running it, the same
  way you would read a script.
- **Checksums.** xxHash detects accidental corruption, not tampering. Someone who
  can write to the destination can rewrite both a file and its line in the
  checksum list.

## Not in scope

syncto has no server, no telemetry and no account. It makes exactly one network
request on its own: fetching `version.json` from this repository at startup to
check for a newer release. That request can be avoided by running offline; it
sends nothing but the HTTP request itself.
