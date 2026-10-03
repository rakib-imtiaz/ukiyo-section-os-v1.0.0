# ThemeBot desktop app

The same ThemeBot UI and engine, packaged as an installable app for Windows, macOS and Linux
(Electron — the same approach as the Claude, ChatGPT and Codex desktop apps).

## How it fits together

```
ThemeBot.exe / ThemeBot.app / themebot   (Electron main: desktop/main.ts)
 ├─ window  → loads http://127.0.0.1:<port>  (the normal React UI, sandboxed; preload: desktop/preload.ts)
 └─ server  → bundled Node.js runtime running resources/server/server.mjs  (desktop/server-host.ts)
               └─ Claude Code, QA scripts, npm … (the customer's own Claude Code + Chrome)
```

- The server is the same code as `npm run dev`, started in **desktop mode** (`THEMEBOT_DESKTOP=1`):
  it serves the built UI, keeps its data in the app's data folder, and saves builds in the folder the
  user picks during setup.
- Node.js + npm ship inside the app (`resources/runtime`), so customers never install Node.
- The main process owns: single instance, the window, native folder picker, the licence screen,
  starting/restarting/stopping the server, and automatic updates.

| Where | Windows | macOS | Linux |
|---|---|---|---|
| App data (settings, licence, logs, state) | `%APPDATA%\ThemeBot` | `~/Library/Application Support/ThemeBot` | `~/.config/ThemeBot` |
| Dev runs | `%APPDATA%\ThemeBot-Dev` | `…/ThemeBot-Dev` | `~/.config/ThemeBot-Dev` |
| Builds | the folder chosen in setup (default `~/ThemeBot Builds`) | same | same |

Logs: Help → Logs folder (`server.log`, `updates.log`).

## Commands

| Command | What it does |
|---|---|
| `npm run desktop:dev` | Builds UI + main, runs the app against the repo's TypeScript server |
| `npm run desktop:build` | Builds everything into `build/` (UI, bundled server, main, Node runtime) |
| `npm run desktop:pack` | `desktop:build` + installers for **this** OS into `release/` |
| `npm run desktop:pack:dir` | Same, but only the unpacked app (`release/<os>-unpacked`) — fastest to test |

An installer can only be built on its own OS. `.github/workflows/desktop.yml` builds Windows, macOS
(Apple Silicon + Intel) and Linux on GitHub and keeps them as workflow artifacts — **it never publishes**.

## Build settings (environment variables at build time)

| Variable | Effect |
|---|---|
| `THEMEBOT_EDITION=internal` | Keeps the operator tools (Terminal, Browser, developer mode). Default: `customer` (hidden) |
| `THEMEBOT_LS_STORE_ID`, `THEMEBOT_LS_PRODUCT_IDS` | Requires a Lemon Squeezy licence key from that store/product(s). Unset = no licence needed |
| `THEMEBOT_UPDATE_URL` | Turns on automatic updates from that address (generic feed: `latest.yml` + installers) |
| `THEMEBOT_NODE_VERSION` | Node.js version to bundle (default: the version building it) |

## Licences (desktop/licence.ts)

Lemon Squeezy License API: activate on first launch (one seat per computer), re-check online every
7 days, keep working offline for 14 days. Help → "Move licence to another computer…" frees the seat.
Keys from other stores/products are refused.

## Releasing an update (only when told to deploy)

1. Bump `version` in `package.json`.
2. `THEMEBOT_UPDATE_URL=<feed url> npm run desktop:pack` on each OS (or run the CI workflow).
3. Upload the new installers **and** `latest*.yml` + `.blockmap` files to the feed address.
   Installed apps download it in the background and install on the next restart.

Publishing a release is deploying: it happens only on an explicit go-ahead.

## Still to do before selling widely

- Code signing: Windows (Azure Artifact Signing), macOS (Apple Developer ID + notarization).
  Unsigned builds show an "unknown publisher" / "unidentified developer" warning.
- Test the macOS and Linux builds on real machines (Finder launch, Keychain sign-in, Chrome profile,
  AppImage/deb).
- Cloud brain (build method on our server) — the desktop app becomes the "hands" only.
