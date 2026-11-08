# Bundled GitHub CLI

`gh.exe` (GitHub CLI, win-x64) is placed in this folder so Riff's PR Review
mode works without the end user installing `gh` separately.

- **Release CI** (`.github/workflows/release.yml`) downloads the pinned
  `gh_<version>_windows_amd64.zip`, verifies its SHA256, and drops
  `bin/gh.exe` here before `tauri build`.
- **Local release builds**: place a `gh.exe` here manually (from
  https://github.com/cli/cli/releases), or leave it out.
- **`tauri dev`**: this binary is usually absent; Riff uses the system `gh`
  (found on PATH or in `%ProgramFiles%\GitHub CLI`), which wins over the
  bundle anyway.

The binary and its license file are git-ignored (large, fetched at build
time). GitHub CLI is MIT-licensed (cli/cli); its `LICENSE` is shipped next to
the exe as `gh-LICENSE.txt`.
