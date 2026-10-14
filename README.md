# pickyNotes

KI-Notiz-App „Capture & Memory“ (v1, Single-User): Gedanken erfassen (Text, Sprache, Screenshot, Datei), im Obsidian-Vault ablegen, automatisch kuratieren, per Hybrid-Suche in App und CLI wiederfinden.

| Paket | Inhalt |
|:--|:--|
| `packages/shared` | zod-Schemas + schlanker REST-Client (geteilt von CLI und App) |
| `packages/server` | Hono-REST-API, OpenAPI (`packages/server/openapi.json`), Postgres+pgvector+pg_trgm, pg-boss-Queue, Kurator, `@claude` |
| `packages/cli` | `note add` / `note search` / `note context --repo .` |
| `apps/desktop` | Tauri 2 + React + Atomic Editor (CodeMirror 6), globaler Hotkey, IndexedDB-Offline-Queue |

## Spike-Ergebnis: Blinko vs. Eigenbau mit Atomic Editor

**Entscheidung: Eigenbau mit Atomic Editor.**

- Blinko (GPL-3.0, Prisma/Postgres) hält Notizen in der **eigenen DB**. Hier ist der Vault die einzige Wahrheit, die DB nur ein neu aufbaubarer Index. Fork hieße, diese Umkehrung gegen das Datenmodell durchzusetzen, plus GPL-3 auf dem ganzen Dienst.
- Atomic Editor (`@atomic-editor/editor`, MIT, React, CodeMirror 6, Obsidian-artige Live-Preview, Raw-Markdown bleibt Wahrheit) ist eine Komponente statt einer App und passt direkt in das Tauri-Fenster.
- Geprüft per GitHub-/npm-Metadaten und READMEs; Blinko nicht lokal gebaut.

## Architektur

1. Vault (Obsidian, `.md`+Frontmatter) = Wahrheit. Neue Notizen: `raw/<id>.md` (nie überschrieben). Bestehende Notizen: nur gelesen und indexiert; keine Funktion zum Löschen/Verschieben/Umbenennen.
2. Kurator darf nur Frontmatter und die markierten Blöcke `<!-- picky:summary -->…` und `<!-- picky:claude -->…` ändern, compare-before-write (Hash). `*.sync-conflict-*` werden erkannt, in `conflicts` protokolliert, nicht indexiert.
3. `POST /captures` antwortet sofort (202 + id). Transkription, Extraktion, Embedding, Kuratierung, `@claude`, Webhooks laufen als pg-boss-Jobs mit Retry/Backoff.
4. Hybrid-Suche: Postgres-FTS (german) + pg_trgm + pgvector (multilingual-e5-small, 384 Dim., lokal in-process), gemerged per RRF (Reciprocal Rank Fusion).
5. LLM nur über `claude -p` (Subscription, `ANTHROPIC_API_KEY` wird dem Kindprozess entzogen) hinter `LlmProvider`, Tageslimit als DB-Zähler (`CLAUDE_DAILY_LIMIT`).

`@claude`: nur in `source=typed|dictated`; importierte Inhalte (Screenshot/Datei/OCR/PDF/Web) werden nie ausgeführt und im Frontmatter mit `claude: ignored` markiert. Genau einmal durch `UNIQUE(note_id, instruction_hash)`. Ergebnis als Callout `> [!claude] id:<id> status:<pending|done|failed>`.

Webhooks `note.created`, `note.curated`, `suggestion.created`: `POST /admin/webhooks`, Signatur `X-Picky-Signature: sha256=<HMAC-SHA256(body, secret)>`.

## Setup (lokal)

```sh
npm install
docker run -d --name picky-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 pgvector/pgvector:pg16
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres VAULT_PATH=$HOME/vault \
  ADMIN_ALLOWLIST=127.0.0.1,::1 npm start -w @pickynotes/server
curl -XPOST localhost:8787/admin/devices -H 'content-type: application/json' -d '{"name":"mac"}'   # Token, nur einmal sichtbar
```

`npm run typecheck` und `npm test` brauchen weder Postgres noch Netz. Postgres-Integrationstests: `DATABASE_URL=… npm test -w @pickynotes/server` (**löscht das Schema `public`** der angegebenen DB, nur Wegwerf-DB verwenden).

## Deployment (Hostinger-VPS hinter Tailscale)

```sh
cp .env.example .env    # POSTGRES_PASSWORD, VAULT_HOST_PATH, PUBLISH_ADDR, … ausfüllen
docker compose up -d --build
docker compose exec -it server claude   # einmalig mit der Subscription einloggen (Volume claude-auth)
```

- `/admin/*` antwortet nur Peers aus `100.64.0.0/10` (Tailscale) oder `ADMIN_ALLOWLIST`. Veröffentlichung auf der Tailscale-IP (`PUBLISH_ADDR`) oder hinter eigenem Proxy mit `TRUST_PROXY=true`. Admin-Sperre nach dem Deploy von außen testen.
- Geräte-Token: `POST /admin/devices` von einem Tailscale-Peer. Token wird nur gehasht (SHA-256) gespeichert.
- `POST /captures` ist pro IP rate-limitiert (`RATE_LIMIT_PER_MIN`).
- Das Image (`Dockerfile`) wurde gebaut und gestartet (Health ok); `claude -p` im Container braucht den Login oben.

## Betrieb

- **Reindex:** `POST /admin/reindex` baut den Index aus dem Vault neu (read-only auf dem Vault).
- **Tageslimit:** `CLAUDE_DAILY_LIMIT`; bei Erschöpfung schlagen Jobs fehl und werden von pg-boss mit Backoff wiederholt (Notiz bleibt `pending`).
- **Konflikte:** Tabelle `conflicts` (sync-conflict, write-conflict, unreadable).
- **Logs:** `docker compose logs -f server`.
- **Backup:** Vault (maßgeblich). `pg_dump` optional, die DB ist neu aufbaubar. Die Queue-Tabellen (`pgboss`) liegen in derselben DB.
- **Spec:** `GET /openapi.json`; `npm run openapi` schreibt `packages/server/openapi.json` (ein Test prüft, dass die eingecheckte Datei dem Code entspricht).

## CLI

```sh
export PICKY_URL=https://notes.example.net PICKY_TOKEN=pk_…   # oder ~/.config/pickynotes/config.json {"url","token"}
npx tsx packages/cli/src/index.ts add "Gedanke"       # oder per stdin; bin: `note`
note search rotes Auto [--json] [-n 5]
note context --repo .     # Repo-Name aus git remote, sonst Ordnername
```

## Desktop (macOS)

```sh
npm run tauri dev -w @pickynotes/desktop     # braucht Rust (rustup)
npm run tauri build -w @pickynotes/desktop   # .app/.dmg
```

Hotkey `Cmd+Shift+Space` holt das Fenster nach vorn (Schließen versteckt nur). Jede Erfassung landet zuerst in der IndexedDB-Queue und wird in Reihenfolge gesendet (`online`-Event + alle 30 s). Dauerhaft abgelehnte Captures (4xx außer 401/429) werden geparkt statt zu blockieren. Token im macOS-Schlüsselbund, Screenshot via System-`screencapture` (Bildschirmaufnahme-Berechtigung), Mikrofon-Berechtigung für Sprache.

## Offene Punkte / bewusste Abkürzungen

- **Spec-Punkte 7a/7b/13b/17b:** Die Spec (Claude-Docs-Artefakt) war nicht lesbar (kein Docs-Connector). Gearbeitet wurde nur nach Briefing + Kurzfassung. Nichts davon wurde geraten; bitte gegen die Spec abgleichen.
- **Embedding-Wahl (Datenmodell):** `vector(384)` fest durch multilingual-e5-small (`claude -p` liefert keine Vektoren). Wechsel = neue Migration + Reindex. Bitte bestätigen.
- **WhisperStorm-API** unbekannt: angenommen `POST` multipart `file` → `{"text"}` an `WHISPER_URL` (`WHISPER_TOKEN` als Bearer). Gegen die echte API prüfen.
- **Nicht gebaut:** S3-kompatibler Store (Anhänge > `MAX_ATTACHMENT_MB` werden mit 413 abgelehnt), LLM-Reranking (nur RRF), Mobile/Share-Sheet/Push-Kontext/Sortierdienst (außerhalb v1).
- Ein Embedding pro Notiz (erste 2000 Zeichen), keine Chunks.
- Screenshot/Datei-Extraktion läuft über `claude -p` mit `Read` nur auf genau diese Datei; Textdateien werden ohne LLM gelesen.
- Compare-before-write hat ein kleines Zeitfenster zwischen Prüfung und `rename`; bei gleichzeitig schreibenden Sync-Tools ggf. Locking ergänzen.
- Tauri/Rust-Teil: `cargo check` ok, aber weder `tauri build` noch Lauf der App geprüft; Mikrofon-/Screenshot-/Hotkey-Pfade sind nicht von den Test-Gates abgedeckt (nur Queue-Logik und Capture-Komponente).
- `claude -p` mit Headless-Subscription-Login auf dem VPS ist nicht verifiziert.
- Dev-Abhängigkeiten melden `npm audit`-Funde (vitest/tinypool, sharp via transformers.js); vor produktivem Einsatz prüfen.
