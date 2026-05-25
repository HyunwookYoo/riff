# Riff

Lightweight Windows desktop app for comparing two Git branches (or any two refs) file-by-file, with syntax highlighting.

Built with [Tauri 2](https://tauri.app), Svelte 5, [CodeMirror 6](https://codemirror.net) (`@codemirror/merge`), and [Shiki](https://shiki.style).

## Install

1. Download the latest `Riff_x.y.z_x64-setup.exe` from [Releases](https://github.com/HyunwookYoo/riff/releases/latest).
2. Run it. Windows SmartScreen will show a warning because the installer isn't code-signed yet — click **More info** → **Run anyway**.
3. WebView2 will be installed automatically if it's not already present.

Future updates check in-app: when an update is available, a banner appears in the top bar; click **Install and restart**.

## Usage

1. Drop a repo folder into the path bar (or click **Browse…**).
2. Type a start ref and a target ref. Branches, tags, and commit hashes are accepted; the dropdown autocompletes from local + remote refs.
3. Click **Compare**.
4. Click a file on the left to see its diff. Switch between **Split** and **Unified** in the top-right of the diff pane.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | Next / previous file |
| `n` / `p` | Next / previous chunk |
| `Ctrl+F` | Search in current file |
| `b` | Toggle blame mode |
| `Esc` | Back out of a commit drill-in |

### Other controls

- **3-dot / 2-dot** — compare modes. 3-dot uses the merge-base of start and target (GitHub PR style); 2-dot is a direct `start..target` diff.
- **ws** — toggle `-w` (ignore whitespace) for the file list.
- **Theme** — System (follows OS) / Light / Dark.
- **Tree / Flat** — switch the file list layout.
- **Language** dropdown in the diff toolbar — override auto-detected syntax highlighting.
- **Blame** — toggle blame mode in the diff toolbar (or press `b`). When ON, a thin color bar appears next to each line (color per commit), and hovering a line shows a popover with author, relative date, commit subject, and short SHA. Click the SHA to copy it; click **View commit →** to drill into that commit's full change set. `Esc` (or the **← Back** button in the breadcrumb that appears) returns to the previous compare.

## Development

Requirements: Node.js 22+, Rust stable, and git on PATH.

```sh
npm install
npm run tauri dev
```

Type-check and Rust check:

```sh
npm run check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

## Release process

Pushing a tag matching `v*` triggers `.github/workflows/release.yml`, which builds for Windows, signs the bundle for the auto-updater, drafts a GitHub Release, and publishes installer + `latest.json`.

### One-time setup (do this before the first release)

1. **Generate the updater signing key** locally — keep this safe.

   ```sh
   npx @tauri-apps/cli signer generate -w riff-updater.key
   ```

   You'll be asked for a password. Remember it — you'll need it as a GitHub secret.

2. **Back up the private key.** Save `riff-updater.key` to your password manager (e.g., 1Password / Bitwarden). GitHub Secrets is **not** a backup — losing this key permanently breaks the auto-updater for every installed copy, and the only recovery is for users to reinstall manually.

3. **Add GitHub repo secrets** (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `riff-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password from step 1

4. **Paste the public key** (printed by `signer generate`) into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, replacing the placeholder string. Commit and push.

### Cutting a release

```sh
# Bump version in src-tauri/tauri.conf.json AND package.json
git commit -am "release: v0.1.1"
git tag v0.1.1
git push origin main --tags
```

The workflow creates a **draft** release. Edit the notes on GitHub, then **Publish** it. Installed copies will detect the new `latest.json` on their next startup.

## Project layout

```
src/                     SvelteKit frontend
  lib/
    ui/                  InputBar, FileList, TreeNode, DiffView
    diff/                Shiki integration, language detection, active-view ref
    git.ts               Tauri command wrappers
    store.svelte.ts      AppState (Svelte 5 runes)
    theme.ts             Theme apply + matchMedia subscription
    updater.ts           Updater check wrapper
src-tauri/
  src/
    git/                 GitLayer trait + GitCli (shell out to `git`)
    diff/                (placeholder for future diff helpers)
    store/               Persisted state (recent repos, theme)
    lib.rs               Tauri commands + plugin init
  capabilities/          Tauri 2 permissions
  tauri.conf.json        Bundle + updater config
.github/workflows/
  ci.yml                 Lint + type-check on PR/push
  release.yml            tauri-action on tag push
PLAN.md                  Design doc
```

## License

MIT — see [LICENSE](LICENSE) once added.
