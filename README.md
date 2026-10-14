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

Vorschläge (Aufgaben, Termine, Issues aus der Kuratierung): Tabelle `suggestions`, `GET /suggestions?status=pending|accepted|dismissed`, `POST /suggestions/{id}/accept|dismiss`. **Nur Vorschläge:** Annehmen/Verwerfen speichert die Entscheidung und löst nichts aus (kein Job, keine Mail, kein Termin, kein Todoist-Task). `GET /context?repo=&event=&sender=` liefert passende Notizen.

Mail-Eingang: `POST /captures/mail` (Bearer-Gerätetoken, `{from, subject, text, messageId?}`) legt eine importierte Notiz an (`kind: mail`, Absender in Frontmatter und als „Von:“-Zeile, `@claude` wird nie ausgeführt). Gleiche `messageId` = dieselbe Notiz. `GET /context?sender=anna@example.com` findet sie.

## Setup (lokal)

```sh
npm install
docker run -d --name picky-pg -e POSTGRES_PASSWORD=dev -p 5544:5432 pgvector/pgvector:pg16    # 5432 ist oft belegt
DATABASE_URL=postgres://postgres:dev@localhost:5544/postgres VAULT_PATH=$HOME/vault \
  ADMIN_ALLOWLIST=127.0.0.1,::1 npm start -w @pickynotes/server
curl -XPOST localhost:8787/admin/devices -H 'content-type: application/json' -d '{"name":"mac"}'   # Token, nur einmal sichtbar
```

Optional lokal dazu (alles per Umgebungsvariable abschaltbar, Defaults = aus):

```sh
# S3-kompatibler Store für Anhänge > MAX_ATTACHMENT_MB (Beispiel RustFS; MinIO-Images sind öffentlich nicht mehr verfügbar)
docker run -d --name picky-s3 -p 127.0.0.1:9000:9000 -e RUSTFS_ACCESS_KEY=key -e RUSTFS_SECRET_KEY=secret-min8 rustfs/rustfs:1.0.1
#   → S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY=key S3_SECRET_KEY=secret-min8   (Bucket wird beim ersten Upload angelegt)
# Whisper (OpenAI-kompatibel, speaches)
docker run -d --name picky-whisper -p 127.0.0.1:8000:8000 ghcr.io/speaches-ai/speaches:0.8.3-cpu
#   → WHISPER_URL=http://127.0.0.1:8000/v1/audio/transcriptions   (WHISPER_API=openai, WHISPER_MODEL=Systran/faster-whisper-small)
```

`npm run typecheck` und `npm test` brauchen weder Postgres noch Netz. Postgres-Integrationstests: `DATABASE_URL=postgres://postgres:dev@localhost:5544/picky_test npm test -w @pickynotes/server` (**löscht das Schema `public`** der angegebenen DB, nur Wegwerf-DB wie `picky_test` verwenden, nie die Dev-DB).

Editor-Test mit dem echten Atomic Editor/CodeMirror (kein Mock, jsdom): `node node_modules/vitest/vitest.mjs run --root apps/desktop src/editor.test.tsx`.

## Deployment (Hostinger-VPS hinter Tailscale)

```sh
cp .env.example .env    # POSTGRES_PASSWORD, VAULT_HOST_PATH, PUBLISH_ADDR, … ausfüllen
docker compose up -d --build
docker compose exec -it server claude   # einmalig mit der Subscription einloggen (Volume claude-auth)
# optional, lokal mitlaufend (nur 127.0.0.1; Host-Ports per SERVER_PORT/S3_PUBLISH_PORT/S3_CONSOLE_PORT/WHISPER_PUBLISH_PORT):
docker compose --profile s3 --profile whisper up -d    # danach S3_ENDPOINT=http://s3:9000 bzw. WHISPER_URL=http://whisper:8000/v1/audio/transcriptions in .env
```

- `/admin/*` antwortet nur Peers aus `100.64.0.0/10` (Tailscale) oder `ADMIN_ALLOWLIST`. Veröffentlichung auf der Tailscale-IP (`PUBLISH_ADDR`) oder hinter eigenem Proxy mit `TRUST_PROXY=true`. Admin-Sperre nach dem Deploy von außen testen.
- Geräte-Token: `POST /admin/devices` von einem Tailscale-Peer. Token wird nur gehasht (SHA-256) gespeichert.
- `POST /captures` ist pro IP rate-limitiert (`RATE_LIMIT_PER_MIN`).
- CORS: nur `CORS_ORIGINS` (Default: Tauri-Webview + Vite-Dev); Preflights (`OPTIONS`) werden vor Auth beantwortet.
- Geprüft (lokal, eigener Compose-Projektname, Host-Ports 18788/19100/18000): `docker compose build`, Start mit `--profile s3 --profile whisper`, `/health` und `/openapi.json` ok, Gerätetoken, Mail-Notiz in den Vault, 17-MB-Datei landet im Bucket und als gekürzte Notiz mit `s3://`-Link im Vault. `claude -p` im Container braucht den Login oben (ohne Login bleibt die Kuratierung `pending`). Das Embedding-Modell wird beim ersten Suchen/Embedden geladen (Netz nötig, die erste Anfrage dauert).

## Betrieb

- **Reindex:** `POST /admin/reindex` baut den Index aus dem Vault neu (read-only auf dem Vault).
- **Tageslimit:** `CLAUDE_DAILY_LIMIT`; bei Erschöpfung schlagen Jobs fehl und werden von pg-boss mit Backoff wiederholt (Notiz bleibt `pending`).
- **Konflikte:** Tabelle `conflicts` (sync-conflict, write-conflict, unreadable).
- **Große Anhänge (S3):** mit `S3_ENDPOINT` (+ `S3_ACCESS_KEY`/`S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, `S3_MAX_ATTACHMENT_MB`, Default 100) landen Dateien über `MAX_ATTACHMENT_MB` als `attachments/<id>/<name>` im Bucket statt mit 413 abgelehnt zu werden. Die Notiz enthält den `s3://`-Link plus den Extrakt; für `claude -p` wird kurz eine Temp-Datei geladen und wieder gelöscht. Ohne `S3_ENDPOINT` bleibt es bei 413. Der Upload läuft als Base64 im JSON-Body (praktische Grenze ~100 MB; größere bräuchten Multipart/Presigned-Upload).
- **Sprache:** `WHISPER_URL` leer = Sprachnotizen scheitern sichtbar und werden von der Queue wiederholt (der Desktop puffert ohnehin). `WHISPER_API=openai` (Default, `model`-Feld aus `WHISPER_MODEL`) für den lokalen speaches-Dienst, `whisperstorm` für das angenommene WhisperStorm-Format. Nicht erreichbar, Timeout (5 min) oder 5xx = Job-Retry.
- **Mail-Weiterleitung:** Der Mail-Dienst (z. B. Forwarding-Webhook) ruft `POST /captures/mail` mit einem eigenen Gerätetoken (`POST /admin/devices`, Name z. B. `mail`) auf. Der Token berechtigt zum Lesen wie jeder Gerätetoken (keine Scopes, siehe Vertagt).
- **Logs:** `docker compose logs -f server`.
- **Backup (alle drei Teile):**
  1. **Vault** (maßgeblich für Notizen). Restore: Ordner zurückspielen, `POST /admin/reindex`.
  2. **S3-Bucket** bzw. Volume `s3data`, wenn `S3_ENDPOINT` gesetzt ist: dort liegen die **einzigen Originale** großer Anhänge (der Vault hält nur Link + Extrakt). Restore: Volume/Bucket zurückspielen, gleiche Bucket-Namen und Keys (`attachments/<id>/<name>`).
  3. **`pg_dump` ist Pflicht, nicht optional.** Aus dem Vault nicht neu aufbaubar sind: Entscheidungen der Vorschlags-Queue (`suggestions`, accepted/dismissed), die Konflikt-Historie (`conflicts`), Geräte-Token, Webhooks, `@claude`-Ausführungsstand (`claude_instructions`, Exactly-once) und die Capture-Dedupe (`client_id`). Dump: `docker compose exec db pg_dump -U postgres -Fc pickynotes > picky.dump`. Restore: `pg_restore --clean --if-exists -d pickynotes picky.dump` (im `db`-Container), danach Server starten (Migrationen laufen beim Start). Die Queue-Tabellen (`pgboss`) liegen in derselben DB.
  Reihenfolge beim Restore: DB, dann Vault/Bucket, dann `POST /admin/reindex` (behält `client_id`; Zeilen auf bewegte Pfade werden korrigiert).
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

- **Embedding-Wahl (Datenmodell):** `vector(384)` fest durch multilingual-e5-small (`claude -p` liefert keine Vektoren). Wechsel = neue Migration + Reindex. Bitte bestätigen.
- Vorschlags-Status (`suggestions`) lebt nur in der DB; ein `reindex` auf leerer DB stellt Vorschläge nicht wieder her (die Liste steht weiter im Frontmatter der Notiz).
- Ein Embedding pro Notiz (erste 2000 Zeichen), keine Chunks.
- Screenshot/Datei-Extraktion läuft über `claude -p` mit `Read` nur auf genau diese Datei; Textdateien werden ohne LLM gelesen.
- Vault-Schreibzugriffe sind pro Notiz im Prozess serialisiert (Hash-Prüfung im Lock, eindeutige Temp-Datei). Compare-before-write hat gegen *externe* Schreiber (Syncthing/Obsidian) weiter ein kleines Zeitfenster zwischen letzter Prüfung und `rename`; bei Konflikten wird abgebrochen und neu gelesen, bei Bedarf Datei-Locking ergänzen.
- `@claude`-Anweisungen laufen gestuft (`claimed → callout_written → executing → executed → published`, Ergebnis in der DB); ein Retry setzt nach der letzten Stufe fort und ruft das Modell nicht erneut auf (findet er `executing`, ist der Ausgang unbekannt: die Anweisung wird als „unterbrochen“ markiert statt ein zweites Mal ausgeführt). Zwei Worker, die dieselbe Stufe gleichzeitig fortsetzen, sind nicht per Compare-and-Set abgesichert (die Queue liefert pro Notiz einen Job).
- Capture-Dedupe über `clientId` (`notes.client_id`, unique) lebt nur in der DB: nach einem Neuaufbau aus dem Vault (`reindex` auf leerer DB) sind alte `clientId`s weg. Zwei exakt gleichzeitige Erstversuche können eine verwaiste Datei in `raw/` hinterlassen (zweiter Insert scheitert, Retry löst auf).
- Wiederaufnahme von `finishNote` (Retry nach Teillauf) stellt eine fehlende DB-Zeile samt Summary aus der Datei her (die Datei ist die Wahrheit).
- Stürzt ein Text-Capture zwischen dem Schreiben der Datei und dem Anlegen der DB-Zeile ab, kennt der Retry die `clientId` noch nicht (sie steht nur in der Zeile) und legt eine zweite Notiz mit neuer id an. Enger als der gefixte `queue.send`-Fall; Abhilfe wäre die `clientId` im Frontmatter.
- Vorschläge werden vor dem Schreiben von `status: curated` in die DB gelegt (Retry-fest); stürzt `curate` zwischen DB-Insert und Webhook ab, geht das `suggestion.created`-Event für diese Vorschläge verloren (die Vorschläge selbst nicht).
- Abgelehnte Captures (4xx außer 401/429) bleiben in der Desktop-Warteschlange und sind in der Capture-Ansicht als „Abgelehnt“ mit „Erneut senden“/„Verwerfen“ sichtbar; der Entwurf im Editor bleibt erhalten.
- Postgres-Pfad (`PgRepo`, Migrationen 001–004) ist gegen `pgvector/pgvector:pg16` in der Wegwerf-DB `picky_test` geprüft (`DATABASE_URL=… npm test -w @pickynotes/server`); die Gates selbst laufen ohne DB.
- Dev-Abhängigkeiten melden `npm audit`-Funde (vitest/tinypool, sharp via transformers.js); vor produktivem Einsatz prüfen.

## Vertagt / nicht machbar

Nichts davon wurde stillschweigend weggelassen; jeder Punkt hat einen Grund und, wo möglich, die nächsten Schritte.

| Punkt | Grund | Nächster Schritt |
|:--|:--|:--|
| VPS-Deployment (Hostinger) | Kein Zugang zum VPS aus dieser Umgebung. Image und Compose-Stack sind lokal gebaut und gestartet (Health/OpenAPI ok). | Auf dem VPS: `git clone`, `cp .env.example .env` (POSTGRES_PASSWORD, VAULT_HOST_PATH, PUBLISH_ADDR=Tailscale-IP), `docker compose up -d --build`, dann `docker compose exec -it server claude` (Login), Gerätetoken per `POST /admin/devices` von einem Tailscale-Peer, Admin-Sperre von außen testen. |
| `claude -p` mit Headless-Login im Container | Braucht einen interaktiven Subscription-Login auf dem Zielsystem; lokal nicht reproduzierbar. | Login-Schritt oben; danach eine Test-Notiz erfassen und prüfen, dass sie `status: curated` bekommt. |
| Echte WhisperStorm-API | Format unbekannt, keine Doku/Zugang. Umgesetzt ist der angenommene Vertrag (`WHISPER_API=whisperstorm`), getestet nur gegen Fakes. Als verifizierte Alternative läuft der lokale speaches-Dienst (`WHISPER_API=openai`). | Gegen die echte API prüfen und `providers.ts` (`WhisperTranscription`) anpassen. |
| Echter Whisper-Lauf im Compose | Der Dienst verifiziert nur Image-Tag und Start; das Modell wird beim ersten Einsatz geladen (braucht Netz, mehrere hundert MB) und wurde hier nicht transkribiert. | `docker compose --profile whisper up -d`, Sprachnotiz senden, Logs prüfen. |
| Tauri-Build und Lauf der App | `cargo check` war ok, aber `tauri build` und ein Lauf der nativen App sind hier nicht möglich/geprüft (Rust-Toolchain, Berechtigungen für Mikrofon/Screenshot/Hotkey). Der Editor selbst ist mit dem echten CodeMirror unter jsdom getestet, nicht im Browser/Tauri-Fenster. | `npm run tauri dev -w @pickynotes/desktop` und Liste/Tab/Theme von Hand prüfen. |
| LLM-Reranking | Bewusst nicht gebaut: zusätzliche `claude -p`-Aufrufe pro Suche gegen das Tageslimit; RRF über FTS+Trigramm+Vektor liefert die Treffer. | Rerank-Pass über die Top-N in `hybridSearch`, wenn die Qualität es verlangt. |
| Gerätetoken mit Scope (z. B. nur Mail-Eingang) | Der Mail-Dienst nutzt einen normalen Gerätetoken; wer ihn hat, kann auch lesen. Für v1 (Single-User, eigener Dienst) akzeptiert. | Spalte `scope` an `devices`, Auth-Middleware je Route prüfen. |
| Mobile, Share-Sheet, Push-Kontext, Sortierdienst | Außerhalb v1 laut Briefing. | – |
| Spec-Punkte 7a/7b/13b/17b | Das Briefing nennt sie, die Spec (Claude-Docs-Artefakt) hat aber keine so nummerierten Punkte; sie enthält nur zwei offene Punkte: Produktname „pickyNotes“ bestätigen und Referenz der `wiki_*`-Kontexte. Beide änderten hier weder Architektur noch Datenmodell. | Produktname und `wiki_*`-Kontexte bestätigen. |
| Browser-Test (Playwright) des Editors | Kein Gate; Ersatz ist der jsdom-Test mit dem echten Atomic Editor (Listen, Enter, Tab). Layout-abhängiges Verhalten (Cursor-Position, Rendering) deckt jsdom nicht ab. | Manuell im Vite-Dev-Server (`npm run dev -w @pickynotes/desktop`, Port 1420). |
