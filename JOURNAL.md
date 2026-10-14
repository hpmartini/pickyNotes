# Journal Runde 2 (2026-10-14)

Auftrag: Briefing vollständig umsetzen, Nicht-Machbares in README („Vertagt“) und hier begründen. Chronologisch, kurz.

## Plan
1. Baseline, 2. Review-Befunde (`@claude` exactly-once, Capture-Dedupe, `finishNote`-Resume), 3. Desktop-Editor, 4. Lücken (Vorschläge, Mail, Whisper, S3), 5. Postgres auf Wegwerf-DB, 6. Docker, 7. README, 8. Journal.

## Chronik

**Baseline.** `node_modules` fehlte (Ursache der roten Gates). Nach `npm ci`: Typecheck grün, 53 Tests grün (9 PG-Tests übersprungen). Kein Code-Defekt in der Baseline. `npm ci` hat nur Dateimodus von `packages/cli/src/index.ts` geändert (zurückgesetzt).

**WP1 Review-Befunde.**
- Befund (real, reproduziert): Text-Capture mit `clientId`, `queue.send` schlägt in `finishNote` fehl → Datei + Zeile existieren, keine Jobs. Der Retry fand `dup.body !== ""` und kehrte früh zurück: Notiz blieb für immer ohne embed/curate/`@claude`. Voice/Datei waren schon abgedeckt, Text nicht.
- Fix (`services.ts`): Text-Dedupe läuft jetzt durch den idempotenten Resume-Pfad von `finishNote`. Test schlägt ohne Fix fehl (verifiziert), mit Fix grün: eine Notiz, Jobs in der Queue, `@claude` genau einmal.
- Zusätzlicher Test: Absturz nach `callout_written` → ein Modellaufruf, ein Callout.
- Bereits vorhanden und geprüft (Tests aus Runde 1): Persist-Retry nach Modellaufruf, dauerhaft fehlschlagendes Persist → `executing`, Retry ruft Modell nicht erneut auf, `finishNote`-Resume (Zeile fehlt/veraltet, Kuration nur in der Datei, kein zweites `note.created`).
- Bekannte Abkürzung: Zweiter Retry, solange der erste `curate` noch in der Queue steht, schickt ein zweites `curate` (kehrt früh zurück, sobald kuratiert). Im Code kommentiert.

**WP2 Desktop.**
- Atomic Editor bringt `markdownKeymap`, `indentWithTab` und den `* `-Handler schon mit. Zusätzliche `extensions` wären totes Gewicht gewesen → keine eingebaut. Beleg: `editor.test.tsx` ohne Mock, echter `AtomicCodeMirrorEditor` unter jsdom: `- a`/`* a`/`1. a` + Enter setzt fort, Enter auf leerem Punkt beendet, Tab/Shift-Tab ein-/ausrücken (5 Tests grün).
- Nötig dafür: jsdom-Polyfills (`test-setup.ts`: ResizeObserver, `Range.getClientRects/getBoundingClientRect`, `matchMedia`) und `server.deps.inline` für `@atomic-editor/editor` (das Paket importiert ohne Dateiendung).
- Theme-Sync aus `main.tsx` in `lib/theme.ts` verschoben (gleiches Verhalten) und getestet. Light-Kontrast geprüft: Atomic setzt unter `[data-theme="light"]` eigene helle Tokens (#24292f auf #fff), Dark-Fallbacks greifen mit unseren CSS-Variablen; keine Lücke gefunden.
- Fokus/Entwurf (stabile `documentId`, localStorage): Tests aus c4e12ea vorhanden, unverändert grün.
- Playwright-Smoke: nicht gemacht (kein Gate, jsdom-Test ersetzt ihn für die Logik). Layout-abhängiges Verhalten bleibt ungeprüft (README „Vertagt“).

**WP3 Lücken.**
- Vorschlags-Queue: Migration `004_suggestions.sql`, `Repo.addSuggestion/listSuggestions/setSuggestionStatus` (Memory + PG, Vertragstest für beide), `curate` speichert idempotent pro (Notiz, Titel) und sendet `suggestion.created` nur für neue. `GET /suggestions`, `POST /suggestions/{id}/accept|dismiss`: ändern nur den Status (Test: kein Job, kein Webhook, kein LLM-Aufruf danach).
- Mail: `POST /captures/mail` (Bearer-Gerätetoken, Rate-Limit, 2-MB-Limit), `source=imported`, `kind: mail`, Absender in Frontmatter und als „Von:“-Zeile, `messageId` → `clientId` `mail:<id>`. Tests: 401, ungültiger Absender, `@claude` ignoriert (kein Job, keine Instruktion, kein Modellaufruf), doppelte `messageId` = eine Notiz, `GET /context?sender=` findet sie.
- Whisper: `WhisperTranscription` mit `WHISPER_API=openai|whisperstorm` (Default openai, sendet `model`), 5-min-Timeout; Fehler werfen → pg-boss-Retry. Tests für beide Modi, 5xx, Netzfehler, Body ohne `text`.
- S3: `object-store.ts` mit `aws4fetch` (SigV4), optional über `S3_*`. Große Anhänge → `attachments/<id>/<name>`, Job lädt per Stream in eine Temp-Datei (für `claude -p`), löscht sie danach; Notiz hat `s3://`-Link + Extrakt. Ohne Store bleibt 413. Body-Limit skaliert mit. Bucket wird beim ersten Upload angelegt (kein One-shot-Container nötig). Desktop-Clientlimit 10 → 100 MB (Server entscheidet).
- Prüfung `/context`, Webhooks (HMAC, alle drei Events), `.sync-conflict`: vorhanden und getestet (`app.test.ts`, `vault.test.ts`); nur `sender` bekam einen neuen Test.
- Kein Senden von Mails, keine Termine, keine Todoist-Tasks, auch nicht in Tests.

**WP4 Postgres.** `CREATE DATABASE picky_test` im Container `picky-pg` (Port 5544); `postgres`-DB unberührt. `DATABASE_URL=…/picky_test npm test -w @pickynotes/server`: **79/79 grün, 0 übersprungen** (inkl. Migration 004 und Vertragstests der PgRepo). Zusätzlich direkt in PG geprüft: E-Mail-Adresse trifft per `websearch_to_tsquery('german')` und `<%` (Grundlage von `/context?sender=`).

**WP5 Docker.**
- Images per Registry geprüft: `ghcr.io/speaches-ai/speaches:0.8.3-cpu` existiert (höchster Stable-Tag, Pull ok). `minio/minio` ist auf Docker Hub/Quay nicht mehr abrufbar (`pull access denied`, Manifest nicht gefunden) → Entscheidung: **RustFS** `rustfs/rustfs:1.0.1` (S3-kompatibel, Apache-2.0). Echter Lauf gegen RustFS: Bucket-Anlage, PUT/GET/Streaming-Download von 3 MB, Leerzeichen im Key.
- `docker-compose.yml`: Dienste `s3`, `whisper` hinter Profilen, nur `127.0.0.1`, Host-Ports aus Env (`SERVER_PORT`, `S3_PUBLISH_PORT`, `S3_CONSOLE_PORT`, `WHISPER_PUBLISH_PORT`); `.env` optional für `config`. `.env.example` erweitert.
- `docker compose config --quiet` ok. `docker compose build` ok (Image 1,25 GB). Lokaler Start mit eigenem Projektnamen `pickynotes-r2test` (8788 war belegt → 18788), Temp-Vault, Profile s3+whisper: `/health` → `{"ok":true}`, `/openapi.json` listet alle neuen Pfade. End-to-end im Container: Gerätetoken, Mail-Notiz im Vault (`claude: ignored`), 17,7-MB-Capture → 202, Objekt (13,3 MB) im Bucket.
- Befund beim Lauf: Die 13-MB-Textdatei wurde ungekürzt in den Notiz-Body übernommen (Schreiben in den Vault minutenlang, bei echtem Text wäre auch die tsvector-Grenze ein Risiko). Fix: Extrakt wird auf 200 000 Zeichen gekappt (wie Text-Capture) mit Marker „gekürzt, Volltext im Anhang“; Test. Neu gebaut und wiederholt: Notiz 211 KB mit `s3://`-Link.
- Nicht verifiziert: echte Transkription im Whisper-Container (Modell-Download beim ersten Einsatz), `claude -p`-Login im Container, `/context` im Container (der erste Aufruf wartete auf den Download des Embedding-Modells; Verhalten aus Runde 1, nicht neu). Alle eigenen Container/Volumes wieder entfernt (`down -v` nur mit eigenem `-p`), fremde Container unberührt.

**WP6/7.** README aktualisiert (Setup mit Port 5544, S3/Whisper/Mail/Vorschläge, „Nicht gebaut“ bereinigt, Abschnitt „Vertagt / nicht machbar“ mit Grund und nächstem Schritt je Punkt). Dieses Journal zuletzt.

## Entscheidungen
- **`aws4fetch` statt AWS-SDK/eigener Signatur:** kleine, etablierte MIT-Bibliothek (SigV4), keine Hand-Krypto, kein 100-Paket-SDK.
- **RustFS statt MinIO:** MinIO-Images sind nicht mehr abrufbar (geprüft). Server spricht generisches S3, der Dienst ist austauschbar.
- **Mail über den bestehenden Gerätetoken:** gleiche Auth wie `/captures`, keine neue Geheimnisart. Nachteil: kein Scope (ein Mail-Token kann auch lesen). Dokumentiert, Scope-Spalte als nächster Schritt.
- **Kein `CaptureKind` `mail` in `/captures`:** eigener Endpunkt mit eigenem Schema; ein zusätzlicher Kind-Wert hätte `/captures` eine halb behandelte Variante gegeben.
- **Vorschläge ändern nur den Status:** erfüllt „nie automatisch“ strukturell (kein Job, kein Client im Pfad).
- **Keine `extensions` für den Editor:** Atomic deckt Listen schon ab; durch den echten Test belegt statt angenommen.
- **jsdom statt Playwright** für den Editor-Test: reproduzierbar im Gate, kein Browser nötig.
- **S3-Bucket lazy statt `mc`-One-shot:** weniger bewegliche Teile, funktioniert mit jedem S3.

## Testergebnisse (Stand Abschluss)
| Prüfung | Ergebnis |
|:--|:--|
| `npm run typecheck` | grün (alle Workspaces) |
| `npm test` | cli 5, server 69 (+10 PG übersprungen), shared 2, desktop 17: alle grün |
| PG auf `picky_test` | 79/79 grün |
| Editor-Test (echter Atomic Editor) | 5/5 grün |
| `npm run openapi` | ok, `openapi.json` entspricht dem Code (Test) |
| `docker compose config` / `build` / Start | ok / ok / Health + OpenAPI ok |

## Vertagt (Details und Schritte in der README)
VPS-Deployment (kein Zugang), `claude -p`-Login im Container, echte WhisperStorm-API (Format unbekannt; angenommener Vertrag + openai-Alternative), echter Whisper-Lauf, Tauri-Build/App-Lauf, Browser-Test des Editors, LLM-Reranking, Token-Scopes, Mobile/Share-Sheet/Push/Sortierdienst, Spec-Punkte 7a/7b/13b/17b (Spec nicht lesbar).

## Offene Punkte für dich
1. Spec-Punkte 7a/7b/13b/17b nennen/abgleichen.
2. Embedding-Wahl (384-dim multilingual-e5-small) bestätigen.
3. Mail-Dienst auswählen und mit eigenem Gerätetoken an `POST /captures/mail` hängen; entscheiden, ob Token-Scopes nötig sind.
4. WhisperStorm-API-Format liefern, oder bei `openai` + speaches bleiben.
5. VPS-Deployment nach den README-Schritten durchführen und `claude -p`-Login machen.
6. Editor einmal von Hand im Tauri-Fenster prüfen (Listen, Tab, hell/dunkel).
7. `package-lock.json`: neben `aws4fetch` wurden zwei veraltete Einträge (`@tauri-apps/plugin-dialog`, `plugin-shell`) entfernt, die in keiner `package.json` standen.
