# Releasing Holos Studio (Windows)

Holos Studio ships as a small NSIS installer (~100 MB). The Python engine is **not** frozen into an executable:
the installer carries the engine *source* and `uv.exe`, and the app builds its own Python environment on first
launch. Updates come from GitHub Releases through the Tauri updater.

## What is in the installer

| Path in the install folder | What |
|---|---|
| `Holos Studio.exe` | The desktop app (Tauri v2 + the Next.js static UI) |
| `engine\` | Engine source: `pyproject.toml`, `uv.lock`, `README.md`, `LICENSE`, `src\holos\**` |
| `bin\uv.exe` | [uv](https://github.com/astral-sh/uv), pinned in `scripts/fetch-binaries.ps1` |
| `bin\ffmpeg.exe` | FFmpeg "essentials" build by Gyan Doshi (GPL, includes libx264 / libmp3lame), pinned in the same script; its licence is next to it (`FFMPEG-LICENSE.txt`) |

The installer is per-user (no admin rights): `%LOCALAPPDATA%\Holos Studio`. It is shown in Ukrainian or English,
following the Windows display language.

## Versions

[Semantic Versioning](https://semver.org) with pre-releases:

| Version | Meaning | GitHub |
|---|---|---|
| `0.3.0-beta.1`, `0.3.0-beta.2`, … | test builds of 0.3.0; every fix is the next beta | **Pre-release** |
| `0.3.0` | stable, after the betas | normal release |
| `0.3.1` | a fix for a stable version | normal release |

The app shows `0.3.0 Beta 2` and a **BETA** mark in the title bar. The Python package gets the PEP 440 form
(`0.3.0b2`); `scripts/bump-version.mjs` converts it. Allowed suffixes: `-alpha.N`, `-beta.N`, `-rc.N`.

## Release notes

Every version needs a section in [CHANGELOG.md](../CHANGELOG.md) before it is tagged — the workflow fails without
one. Format:

```markdown
## [0.3.0-beta.2] — 2026-10-20

One line about the release.

### English

#### New / Improved / Fixed / Removed / Known limitations
- …

### Українською

#### Нове / Покращено / Виправлено / Видалено / Відомі обмеження
- …
```

`scripts/release-notes.mjs <version> release|app|title` turns it into the GitHub release text (both languages), the
update-banner text (both parts; the app shows the one in the interface language under **What's new**) and the title (`Holos Studio 0.3.0 Beta 2`).

## Cutting a release

1. Make sure `main` is green (CI: engine tests, app typecheck + build).
2. Write the `CHANGELOG.md` section for the new version.
3. Bump the version everywhere:

   ```bash
   node scripts/bump-version.mjs 0.3.0-beta.2
   ```

   This updates `app/package.json` (+ lock), `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`
   (+ `Cargo.lock`), `engine/pyproject.toml` (+ `uv.lock`) and `engine/src/holos/__init__.py`.
4. Commit and push to `main`, then publish — either way works:

   - **Button (usual):** Actions → **Release** → *Run workflow* on `main` with **publish** ticked
     (or `gh workflow run release.yml --ref main -f publish=true`). The workflow creates the tag itself.
   - **Tag:** `git tag v0.3.0-beta.2 && git push origin v0.3.0-beta.2`.

5. The **Release** workflow (`.github/workflows/release.yml`) (~20 min on `windows-latest`):
   downloads uv / FFmpeg (SHA-256 checked), stages the engine source (`scripts/stage-engine.mjs`), builds the app,
   signs the update and publishes a GitHub Release (a pre-release for `-beta.N`) with the changelog text and:
   - `Holos.Studio_<version>_x64-setup.exe` — the installer (also the update payload),
   - `Holos.Studio_<version>_x64-setup.exe.sig` — its updater signature,
   - `latest.json` — the update manifest.

   It then copies `latest.json` (with the notes in both languages) to the release tagged **`updater`** — the update feed
   installed apps poll (`plugins.updater.endpoints` in `tauri.conf.json`). GitHub's "latest release" ignores
   pre-releases, so the feed has its own fixed address. Do not delete that release.

   The workflow refuses to run if the tag and `tauri.conf.json` disagree, if that version is already released, if `CHANGELOG.md` has no section for the
   version, or if the signing key secret is missing.

### Test build without a release

Actions → **Release** → *Run workflow* on any branch (or `gh workflow run release.yml --ref <branch>`).
It builds the installer, uploads it as a workflow artifact `holos-studio-windows-<sha>` (nothing is published), then
smoke-tests it on the runner (`scripts/smoke-test.ps1`): silent install, first-run setup, engine health check, and
that the engine stops both when the window closes and when the app is killed.
Without the signing secret the build skips the updater artifacts (a warning, not an error).

### Local build on Windows

```powershell
pwsh scripts/fetch-binaries.ps1
node scripts/stage-engine.mjs
cd app
npm ci
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw path\to\holos.key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<password>"
npm run tauri build      # → src-tauri\target\release\bundle\nsis\
```

Without the key, add `--config '{\"bundle\":{\"createUpdaterArtifacts\":false}}'`.

## Update signing key

Updates are verified with a minisign key pair (`npx tauri signer generate`).

- **Public key:** `plugins.updater.pubkey` in `app/src-tauri/tauri.conf.json` (committed).
- **Private key:** repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  (Settings → Secrets and variables → Actions). Keep an offline backup. **Never commit it.**

If the private key is lost, installed copies can no longer verify updates: generate a new pair, put the new public
key in `tauri.conf.json`, and users install that release manually once.

## What the app does on first run

In release builds the app manages the engine itself (`app/src-tauri/src/engine.rs`):

1. Copies the bundled engine source to `<data>\engine-src`.
2. Runs, hidden:

   ```
   uv sync --frozen --no-dev --compile-bytecode --extra asr --extra gpu --extra video
   ```

   with `UV_PROJECT_ENVIRONMENT=<data>\env`, `UV_PYTHON_INSTALL_DIR=<data>\python`, `UV_CACHE_DIR=<data>\uv-cache`
   and `UV_PYTHON_PREFERENCE=only-managed`. uv downloads Python 3.12 and every package, including ~2 GB of NVIDIA
   CUDA libraries — once. The window shows a progress screen with the live uv log; on failure (no internet, disk
   full) it shows the error and a "Спробувати ще раз" button. An interrupted setup resumes from the uv cache.
3. Records the engine-source hash in `<data>\engine-setup.json`. Setup runs again only when an update ships a
   different engine (source or `uv.lock`) — usually a quick sync from the cache.
4. Starts `<data>\env\Scripts\holos.exe serve --port <free port> --token <random>` with
   `HOLOS_FFMPEG=<install>\bin\ffmpeg.exe`, waits for `/api/health`, and hands URL + token to the UI.
5. Kills the engine when the window closes. A Windows Job Object also kills it (and its `python.exe`) if the app
   crashes or the updater closes it.

`tauri dev` (debug builds) skips all of this: start the engine yourself with `uv run holos serve --dev` in `engine/`
and the UI uses `http://127.0.0.1:8765` without a token, as before.

## Where data lives

| What | Where |
|---|---|
| App | `%LOCALAPPDATA%\Holos Studio` |
| Python, environment, uv cache, engine copy | `%LOCALAPPDATA%\com.brainfromukraine.holos\` (`python`, `env`, `uv-cache`, `engine-src`) — ~5 GB |
| Setup / engine log (last start) | `%LOCALAPPDATA%\com.brainfromukraine.holos\engine.log` |
| Projects you save, user export templates | wherever you save them; templates in `Documents\Holos Studio` (`HOLOS_HOME`) |
| Whisper models | Hugging Face cache (`%USERPROFILE%\.cache\huggingface`), downloaded on first transcription |

Uninstalling with "Delete the application data" ticked removes `%LOCALAPPDATA%\com.brainfromukraine.holos`.
Deleting that folder by hand is also safe: the next launch runs setup again.

## How updates work

On start-up the app fetches
`https://github.com/BrainFromUkraine/holos-studio/releases/latest/download/latest.json`. If it lists a newer version,
a slim banner offers "Доступна версія X — Оновити". One click downloads the new installer (progress in the banner),
verifies its signature with the public key, runs it in passive mode and restarts the app. If the new version
carries a different engine, the first-run screen appears briefly while uv syncs the changes.

Drafts and pre-releases are not picked up by `releases/latest`.

## Claude Desktop (MCP) with the installed app

The packaged engine includes the MCP server. Point Claude Desktop at the environment the app created
(Claude Desktop → Settings → Developer → Edit Config → `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "holos-studio": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\com.brainfromukraine.holos\\env\\Scripts\\holos.exe",
      "args": ["mcp"],
      "env": { "HOLOS_FFMPEG": "C:\\Users\\<you>\\AppData\\Local\\Holos Studio\\bin\\ffmpeg.exe" }
    }
  }
}
```

The app can produce this snippet with the exact paths (`mcp_config` command, `getMcpConfig()` in
`app/src/lib/engineHost.ts`). Run Holos Studio once first so the environment exists, then restart Claude Desktop.
Tools and usage: [MCP.md](MCP.md).
