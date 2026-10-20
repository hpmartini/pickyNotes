# pickyNotes

A capture-first note app for people who think faster than they file. Jot a thought down (typed, dictated, a screenshot, a file), it lands in your Obsidian vault as plain Markdown, gets curated in the background, and comes back when you search for it.

<p align="center">
  <img src="docs/screenshots/editor-light.png" alt="pickyNotes editor with tabs, task list and table" width="340">
  <img src="docs/screenshots/editor-dark.png" alt="pickyNotes in dark mode" width="340">
</p>

> The app UI and the technical spec are in German. This README is in English.

## Features

- **Fast capture:** a floating, frameless macOS window that also appears over fullscreen apps. Global hotkeys show or hide it, start dictation, or jump to search. Everything is configurable (`Cmd+,`) and can be switched off.
- **Live-preview Markdown editor** (Atomic Editor on CodeMirror 6): headings, lists, task lists, tables, code with highlighting, footnotes, images and file attachments by paste or drag and drop.
- **Note tabs:** `Cmd+N` opens a new note, drafts survive restarts.
- **Saving never loses a note:** every capture is stored twice (IndexedDB queue plus a plain-file outbox) before the tab closes, open drafts are mirrored to disk, and anything not yet delivered is listed under **Ausstehend** (badge in the top bar).
- **Dictation:** talks to WhisperStorm (the author's separate macOS dictation app, not public) over a local Unix socket; transcripts land at the cursor. Without it the STT button just reports that it is not running.
- **Vault is the truth:** new notes become `raw/<id>.md` and are never overwritten; Postgres only holds a rebuildable index. A curator may only touch front matter and two marked blocks.
- **Hybrid search:** Postgres full-text, trigram and pgvector embeddings (local multilingual-e5-small), merged by reciprocal rank fusion, with optional LLM re-ranking.
- **`@claude` in a note** runs a prompt once, only for typed or dictated text. Imported content is never executed. LLM calls go through the `claude -p` CLI.
- **CLI** (`note add`, `note search`, `note context --repo .`) and a REST API with OpenAPI.

| Package | What it is |
|:--|:--|
| `apps/desktop` | Tauri 2 + React 19 macOS app |
| `packages/server` | Hono REST API, Postgres + pgvector, pg-boss job queue, curator |
| `packages/cli` | `note` command line client |
| `packages/shared` | zod schemas and a small REST client |

## Screenshots

<p align="center">
  <img src="docs/screenshots/pending-light.png" alt="Pending captures dialog" width="300">
  <img src="docs/screenshots/settings-light.png" alt="Settings dialog" width="300">
</p>

## Quick start

Requirements: Node 22, Docker (for Postgres), Rust (only for the desktop app), macOS for the desktop app.

```sh
git clone https://github.com/hpmartini/pickyNotes.git && cd pickyNotes
npm install

# server (Postgres with pgvector, then the API)
docker run -d --name picky-pg -e POSTGRES_PASSWORD=dev -p 5544:5432 pgvector/pgvector:pg16
DATABASE_URL=postgres://postgres:dev@localhost:5544/postgres VAULT_PATH=$HOME/vault \
  ADMIN_ALLOWLIST=127.0.0.1,::1 npm start -w @pickynotes/server

# a device token (shown once)
curl -XPOST localhost:8787/admin/devices -H 'content-type: application/json' -d '{"name":"mac"}'

# desktop app: dev mode, or a .app bundle in apps/desktop/src-tauri/target/release/bundle
npm run tauri dev -w @pickynotes/desktop
npm run tauri build -w @pickynotes/desktop -- --bundles app
```

Enter the server URL and the token under **Settings** (`Cmd+,`). The first search downloads the embedding model.

CLI:

```sh
export PICKY_URL=http://127.0.0.1:8787 PICKY_TOKEN=pk_…
npx tsx packages/cli/src/index.ts add "a thought"
npx tsx packages/cli/src/index.ts search red car
```

Docker Compose deployment, backups, S3 attachments, Whisper and all settings: see [SPEC.md](SPEC.md) (German).

## Development

```sh
npm run typecheck
npm test                                  # unit and integration tests, no network or database needed
npm run e2e -w @pickynotes/desktop        # Playwright against the real web bundle (first: npx playwright install chromium)
cd apps/desktop/src-tauri && cargo test
npm run screenshots -w @pickynotes/desktop   # regenerates docs/screenshots from demo data
```

## Documentation

- [SPEC.md](SPEC.md): architecture, data model, operations, known shortcuts (German)
- [JOURNAL.md](JOURNAL.md): development log

## Status

Single-user, built for personal use. The desktop app targets macOS. Window behaviour over fullscreen Spaces uses AppKit APIs and is verified by hand, not by automated tests. Expect rough edges.

## License

[MIT](LICENSE) © 2026 Hans-Peter Martini
