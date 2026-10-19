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

**Abschluss-Review (Advisor).**
- Befund (real): `curate` legte Vorschläge erst nach `patchNote` an. Stürzte der Job danach ab (z. B. `syncRow`), stand `status: curated` schon in der Datei, der Retry kehrte früh zurück → Vorschläge nie in der DB. Fix: Vorschläge vor `patchNote` speichern (idempotent), Events danach. Regressionstest: Erweiterung des Resume-Tests („Kuration in der Datei, nicht in der Zeile“) prüft `listSuggestions`.
- Dokumentiert statt gebaut: Crash zwischen Datei und DB-Zeile beim Text-Capture (zweite Notiz möglich), verlorenes `suggestion.created`-Event bei Crash zwischen Insert und Webhook. README-Altlast („Summary bleibt leer“) korrigiert. Whisper-Cache-Pfad gegen das Image geprüft (User `ubuntu`, `HOME=/home/ubuntu`, Port 8000).

**Nachtrag Review-Befunde (nach Abschluss).**
- [blocker] `safeFilename('..')` lieferte `..` → S3-Key `attachments/<id>/..` normalisiert zu `attachments/`, verschiedene Captures teilten sich eine signierte PUT-URL (Überschreib-Risiko; der Vault-Pfad war durch das `<id>-`-Präfix nicht betroffen). Fix an der Wurzel in `vault.ts`: rein aus Punkten bestehende Namen werden zu `file`. Tests: Unit (`.`, `..`, `...`, `a/..`, `../..`) und zwei große Captures mit Dateiname `..` → zwei verschiedene Keys unter `attachments/<id>/`.
- [major] `finishNote` nahm `raw/<id>.md` an. Nach Verschieben/Reindex legte ein Retry (Text mit gleicher `clientId`, Mail mit gleicher `messageId`) eine zweite Rohdatei an und überschrieb Body/Tags/Summary/Status der bearbeiteten Zeile. Fix: erst `getNote(id)`; liegt die Zeile (Body nicht leer) auf einem anderen Pfad und die Datei existiert dort, wird von dort fortgesetzt, ohne `writeNew`. EEXIST-Resume bleibt. Regressionstests (Text und Mail): Notiz nach `wiki/` verschoben und bearbeitet, Reindex, Retry → keine neue `raw/<id>.md`, Zeile unverändert, genau ein `note.created`. Beide Tests schlagen ohne den Fix fehl (geprüft).
- Backup in README korrigiert: Vault + S3-Bucket/`s3data` (einzige Originale großer Anhänge) + `pg_dump` als Pflicht (Vorschlags-Entscheidungen und Konflikt-Historie sind nicht aus dem Vault rekonstruierbar), mit Restore-Hinweisen.
- Gates erneut: typecheck grün; `npm test` server 73 (+10 PG übersprungen), cli 5, shared 2, desktop 17 grün; PG auf `picky_test` 83/83; Editor-Test 5/5; `npm run openapi` ohne Diff; `docker compose config` ok.

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
| `npm test` | cli 5, server 73 (+10 PG übersprungen), shared 2, desktop 17: alle grün |
| PG auf `picky_test` | 83/83 grün |
| Editor-Test (echter Atomic Editor) | 5/5 grün |
| `npm run openapi` | ok, `openapi.json` entspricht dem Code (Test) |
| `docker compose config` / `build` / Start | ok / ok / Health + OpenAPI ok |

## Vertagt (Details und Schritte in der README)
VPS-Deployment (kein Zugang), `claude -p`-Login im Container, echte WhisperStorm-API (Format unbekannt; angenommener Vertrag + openai-Alternative), echter Whisper-Lauf, Bedienung des nativen Tauri-Fensters (Web-Teil per Playwright-Gate abgedeckt, siehe Nachtrag 3), Mobile/Share-Sheet/Push/Sortierdienst, Spec-Punkte 7a/7b/13b/17b (Spec nicht lesbar).

## Offene Punkte für dich
1. Spec-Punkte 7a/7b/13b/17b nennen/abgleichen.
2. Embedding-Wahl (384-dim multilingual-e5-small) bestätigen.
3. Mail-Dienst auswählen und mit eigenem Gerätetoken an `POST /captures/mail` hängen; entscheiden, ob Token-Scopes nötig sind.
4. WhisperStorm-API-Format liefern, oder bei `openai` + speaches bleiben.
5. VPS-Deployment nach den README-Schritten durchführen und `claude -p`-Login machen.
6. Editor einmal von Hand im Tauri-Fenster prüfen (Listen, Tab, hell/dunkel).
7. `package-lock.json`: neben `aws4fetch` wurden zwei veraltete Einträge (`@tauri-apps/plugin-dialog`, `plugin-shell`) entfernt, die in keiner `package.json` standen.

## Nachtrag 2: Abschlussprüfung nach Stop-Hook-Einwand
Der Einwand: Reranking, Browser-Prüfung und Re-Review des Sonnet-Fixes waren offen bzw. nur vertagt, obwohl machbar.
- **Reranking umgesetzt** (`rerankByLlm` in `search.ts`, `?rerank=` an `/search` und `/context`, `SEARCH_RERANK`, CLI `--rerank`). Fallback auf RRF bei Fehler/Limit/Garbage; Kandidatentext ist Daten (kein Tool, nur bekannte ids zählen). Tests: 3 Unit + 3 App-Tests; server danach 79 grün (+10 PG übersprungen).
- **Editor im echten Browser** (Playwright gegen Vite, Port 1420): zeichenweise getippt `- eins`, Enter, `zwei`, Enter, Tab, `eingerückt`. Ergebnis: Fokus blieb im Editor, Zeilen als Bullets gerendert (`•eins`, `•zwei`, `•eingerückt`), Markdown im Entwurf `- eins\n- zwei\n  - eingerückt`, Schriftfarbe rgb(36,41,47) auf Weiß, `data-theme=light`, Text nach Einstellungen→Erfassen unverändert. (Das Tauri-Fenster selbst konnte ich wegen gesperrtem Bildschirm nicht bedienen.)
- **Unabhängiger Review** (separater Agent, read-only) über `5c6a8e5..HEAD`: kein Blocker, kein Major; Sonnet-Fix 6bcf65d korrekt (reine Typänderung). Minor, dokumentiert und nicht geändert:
  1. Redelivery nach manuellem Verschieben im Vault vor `reindex` kann eine zweite `raw/<id>.md` anlegen (nur Duplikat, kein Datenverlust).
  2. Curate: Crash zwischen `addSuggestion` und `emit` → `suggestion.created` höchstens einmal; abweichende LLM-Titel bei Re-Run können zusätzliche Vorschläge erzeugen (nur Vorschläge).
  3. Große Capture ohne `clientId` kann nach `put` scheitern und ein verwaistes S3-Objekt hinterlassen.
  4. `/captures`-Limit mit Object Store ca. 141 MB im Speicher (≈3× Spitze): VPS-Speicherlimit beachten.
  5. `.env.example` enthält `change-me-*` als S3-Zugang: vor `--profile s3` ändern.
- Prozess-Fehler von mir: Fokus-, Entwurf- und Farb-Bugs wurden erst auf Zuruf behoben; die Lauf-1/2-Gates (Textarea-Mock) konnten sie nicht fangen. Seitdem echter Editor im Test und Browser-Check.

## Nachtrag 3: zweiter Stop-Hook-Einwand
Einwand: Playwright als Gate und Token-Scopes seien machbar und dürften nicht vertagt sein; Sortierdienst/Mobile nur Briefing-Umfang.
- **Playwright-Gate gebaut** (`apps/desktop/e2e/editor.spec.ts`, `npm run e2e -w @pickynotes/desktop`, in `.orchestrate.toml`): echtes Chromium gegen Vite (Port 1421): zehn Zeichen einzeln getippt, Fokus bleibt; `- eins`/Enter/`zwei`/Enter/Tab/`eingerückt` ergibt drei Bullets und Draft `- eins\n- zwei\n  - eingerückt`; Schrift/Hintergrund-Kontrast; Entwurf nach Einstellungen→Erfassen erhalten. **Negativprobe:** ohne `documentId` in `CaptureView` schlägt der Test fehl, mit Fix grün.
- **Token-Scopes gebaut:** Migration 005 (`devices.scope`), `POST /admin/devices {scope:"capture"}`; `capture`-Token darf nur `POST /captures` und `POST /captures/mail`, sonst 403. Tests (Memory + PG 91/91).
- **Nicht machbar bleibt** (nur das): Bedienung des nativen Tauri-Fensters per Skript (Bildschirm gesperrt, keine Bedienungshilfen-/Apple-Events-Berechtigung; Hotkey/Schlüsselbund/Screenshot/Mikrofon nur dort erreichbar), VPS-Zugang, `claude -p`-Login im Container, WhisperStorm-Format. README trennt jetzt „Vertagt / nicht machbar“ von „Außerhalb des Briefing-Umfangs“ (Mobile, Share-Sheet, Push, Sortierdienst, GitHub/Gmail/Calendar/Todoist).
- Stand: typecheck 4/4, Tests server 81 (+10 PG übersprungen), mit PG 91/91, cli 5, shared 2, desktop 17, e2e 1.

## Nachtrag 4: dritter Stop-Hook-Einwand, echte Prüfung statt Annahmen
Einwand: Vertagtes sei nicht auf Unmöglichkeit geprüft, nativer Lauf unbelegt.
- **WhisperStorm geprüft** (`~/PROJECTS/WhisperStorm`): native Swift-Menüleisten-App ohne Server, nur Client für OpenAI-kompatible Server. Die „REST-API“ der Spec wäre eine Änderung in jenem Repo (Guardrail: nur dieses Repo). Verifizierter Weg: `WHISPER_API=openai`. README korrigiert (vorher: „Format unbekannt“).
- **Echter Whisper-Lauf** (speaches 0.8.3-cpu, lokal): `Systran/faster-whisper-small` wurde vom OOM-Killer beendet (Docker-VM 6 GB, geteilt), Xet-Download scheiterte mit TLS-Fehlern → `HF_HUB_DISABLE_XET=1` (jetzt im Compose). Mit `faster-whisper-base` und `-m 2g`: macOS-`say`-Testaudio „Das ist ein Test. Ich muss morgen Milch kaufen.“ → „Das ist ein Test, ich muss Norge Milch kaufen.“ (HTTP 200).
- **Ende-zu-Ende lokal mit dem echten Stack** (Server aus `main`, Port 8790, Postgres 5544, Wegwerf-Vault): `POST /captures` (voice) → Whisper → `raw/<id>.md` mit Transkript und Audio-Einbettung → Embedding → Kuratierung per `claude -p` (Subscription) → `status: curated`, Tags, Titel, Vorschläge (nur als Vorschlag, keine Todoist-Aufgabe) → `GET /search?q=Milch einkaufen` findet die Notiz.
- **Dabei gefundener Fehler:** Embedding- und Curate-Jobs scheiterten mit „Unable to get model file path or buffer“. Ursache: Der Default-Cache von transformers.js (im `node_modules`) war unter `tsx` nicht nutzbar; mit explizitem `env.cacheDir` lädt das Modell (384-dim, ca. 90 s Erstdownload). Fix: `LocalEmbedding` nimmt `MODEL_CACHE_DIR` (Default `~/.cache/pickynotes/models`), Dockerfile/Compose nutzen `/models`. Docker-Image gebaut, `/models` als Nutzer `node` beschreibbar. Die Unit-/Integrationstests (Fake-Embedding) konnten das nicht zeigen.
- **VPS geprüft** (`ssh VPS-hosti`, nur lesend): erreichbar, Docker 29, geteilter Host mit vielen fremden Diensten, **kein `~/MAGOS`**, **Tailscale „NeedsLogin“**. Ein Deployment würde Vault-Pfad und Zugriffsmodell festlegen; das ist laut Briefing eine Entscheidung für dich (Vault-Struktur). Nichts auf dem VPS verändert.
- **Natives Tauri-Fenster:** Log der laufenden App ohne Fehler/Panics, Fenster startet; Bedienung per Skript nicht möglich (Bildschirm gesperrt, Apple-Events verweigert). Nicht belegt bleiben: globaler Hotkey, Schlüsselbund, `screencapture`, Mikrofon im nativen Fenster.
- Aufgeräumt: Test-Container `picky-whisper-test` und Verify-Image entfernt. Mein Test-Port 8790 statt 8787 (dort läuft dein MAGOS auf 127.0.0.1).

## Nachtrag 5: UI-Überarbeitung nach Nutzerkritik („UI ist eine Katastrophe“)
Ehrliche Einordnung: Die UI war nur funktional getestet (Tests, e2e), ich hatte sie nie gerendert angesehen. Jetzt gerendert (Playwright, 375/560/768/1280 px, hell und dunkel) und die Mängel behoben:
- Editor hatte eine **dauerhafte Scrollbar**: Atomic Editor reserviert 208 px Bottom-Padding (Scroll über das Ende); jetzt eigenes Padding, `overflow-y: auto`.
- **Keine Hierarchie:** flache Button-Tabs → Tabs mit Unterstreichung; „Speichern“/„Suchen“ als Primär-Button, Rest sekundär; Aufnahme-Zustand in Warnfarbe.
- **Leere Statuszeile** unter den Buttons → Status rechts in der Aktionsleiste (bricht auf schmalen Fenstern unter die Buttons).
- **Breite Fenster:** Text schwebte in der Mitte (Atomic zentriert 70ch), Tabs/Buttons links → eine zentrierte Spalte (max. 780 px).
- Editor-Text klebte am Rand → Innenabstand; Settings-Button war über die ganze Breite gezogen → links, natürliche Breite.
- Suche: Hinweistext im Leerzustand, Trefferkarten (Snippet auf 3 Zeilen begrenzt), Abgelehnte Captures als eigene Karte.
- Einheitliche Tokens (`--space-*`, `--radius`, Farben hell/dunkel) statt verstreuter Werte; Hover-/Fokus-Übergänge.
- **Dev-Fehler gefunden:** Vite lieferte veraltetes CSS (fsevents-Watcher verlor unter Last Änderungen), das laufende Fenster zeigte also alten Stand. Jetzt `watch.usePolling`.
- Absicherung: e2e-Layouttests bei 375/768/1280 px (kein horizontales Scrollen, keine Dauer-Scrollbar, keine überlappenden Buttons). Stand: typecheck ok, desktop 17 Unit-Tests, e2e 4/4.
- Offen: Aussehen im nativen WKWebView-Fenster nicht gesehen (Bildschirm gesperrt); Chromium-Rendering ist nah dran, aber nicht identisch.

## Nachtrag: Typecheck-Gate
Nach den Redelivery-Tests (`app.test.ts`) war `npm run typecheck` rot (TS2322): `expectUntouched` erwartete `() => Promise<Response>`, `post` liefert aber `Response | Promise<Response>` (Hono `app.request`). Fix: Parametertyp auf `() => Response | Promise<Response>` geweitet. Danach grün: typecheck (alle Workspaces), `npm test` (server 73 + 10 PG übersprungen, desktop 17, cli 5, shared 2), PG auf `picky_test` 83/83.

## Editor: keine Setext-Überschriften mehr (Obsidian/Notion-Verhalten)
**Auftrag:** Text + Enter + „-„ darf die Zeile darüber nicht in eine Überschrift verwandeln. Verhalten wie Obsidian/Notion: nur `# `-Präfix ist eine Überschrift, `---` unter Text ist eine Trennlinie, `-` unter Text bleibt Text, `=` unter Text ebenfalls Text.

**Ursache:** Atomic Editor (0.6.2) baut seinen Parser intern mit `markdown({base: markdownLanguage, extensions: [highlightMarkdown]})` (`AtomicCodeMirrorEditor.js:112`). Dieser Parser enthält `SetextHeading`, und `inline-preview.js:177` mappt `SetextHeading1/2` auf `cm-atomic-h1/h2`. Die Inline-Preview versteckt das `---`/`===` darunter, und schon wird die darüberliegende Zeile als riesige Überschrift gerendert.

**Fix:** Neue Datei `apps/desktop/src/lib/editor.ts` baut denselben Parser nochmal — mit `{remove: ["SetextHeading"]}` in den `extensions` — und reicht ihn via `Prec.high(markdown({...}).language)` durch die `extensions`-Prop des Editors. `Prec.high` schlägt die intern verdrahtete `markdown()`-Erweiterung (gleiche Facette, höhere Präzedenz). Kein `node_modules`-Patch, `markdownLanguage` und `data`-Facet bleiben geteilt, also funktionieren `isActiveAt` (Enter-Listenfortsetzung, Backspace) und `closeBrackets`-Daten weiter. Kommentar im Code: `shortcut: … drop once Atomic Editor accepts lezer extensions`.

**Verkabelung:** `CaptureView.tsx:132` reicht `extensions={editorExtensions}` durch. `CaptureView.test.tsx` erweitert den Editor-Mock um `highlightMarkdown: {}`, damit der Import in `lib/editor.ts` unter jsdom nicht scheitert. `editor.test.tsx` mountet mit den Overrides (vorher waren die List-Tests ohne Override, jetzt verifizieren sie gleichzeitig, dass die Override die List-Logik nicht kaputtmacht — Tab/Shift-Tab/Enter-Continue/Exit grün).

**Neue Tests (`editor.test.tsx`):** `syntaxTree`-basierte Asserts, kein DOM-Roundtrip — `Titel\n-`, `Titel\n- `, `Titel\n=`, `Titel\n===` dürfen kein `SetextHeading1/2`/`ATXHeading*` enthalten; `Titel\n---` muss `HorizontalRule` enthalten; `# A`/`## A`/`### A` liefern weiter `ATXHeading1-3`; `Titel\n- x` liefert `BulletList`. Realer CodeMirror, kein Mock.

**Neuer e2e-Test (`editor.spec.ts`):** Exploratives Tippen des gesamten Dokuments **zeichenweise** (`# … ###`, Absatz, der Regressionsfall „Text ↵ - ↵ ---", Bullet-Liste mit Enter/Tab/Shift-Tab/Backspace-Austritt, geordnete Liste, Aufgabenliste, **fett**/*kursiv*/`code`/Zitat/Code-Block/Link). Nach jeder Tastatureingabe per `page.evaluate` der DOM-Probe: keine Plain-Text-Zeile hat Heading-Größe (Setext-Regression), Fokus bleibt in `.cm-content`. Am Ende harte Asserts: jede Zeile mit `cm-atomic-h*` ist eine der drei ATX-Zeilen; `Eine Zeile Text` hat keine Heading-Klasse; die `---`-Zeile hat `cm-atomic-hr`; ein Screenshot vom Editor wird unter Playwrights `test-results/` abgelegt (gitignored).

**Weitere Abweichungen von Obsidian/Notion — gefunden und gefixt, alles in `apps/desktop/src/lib/editor.ts` (zusätzliche Extensions über die bestehende `editorExtensions`-Prop, kein node_modules-Patch):**
- `**fett**` / `__fett__` Zeichen für Zeichen → `**fett******`. RC (root cause): Atomic auto-clost `*`/`_` (closeBrackets) und `extendEmphasisPair` erweitert beim Tippen des schließenden `*` das Paar erneut, statt darüber zu steigen. Fix: `Prec.highest`-`inputHandler`, der `*`/`_` ohne Selektion unverändert einfügt (mit Selektion wickelt closeBrackets weiter). `* ` am Zeilenanfang startet weiter eine Liste (`startAsteriskList` greift nur, wenn ein Auto-Closer folgt; Unit-Test).
- `> zitat` ↵ ↵ → zweite ↵ hängt `>` + neue `> `-Zeile an, ` ``` ` und Link landeten im Zitat. Fix: `Prec.highest`-Enter auf leerer `> `-Zeile (nur im `Blockquote`-Knoten, nicht in Code) leert die Zeile → Zitat verlassen.
- Backspace auf leerem `- `/`1. `/`- [ ] `-Marker ließ Einrückungs-Leerzeichen stehen (`"- a\n  "`); die nächste Liste (`1. eins`, `- [ ] aufgabe`) wurde dadurch verschachtelt bzw. zu `- - [ ] aufgabe`. Fix: `Prec.highest`-Backspace löscht den ganzen leeren Marker samt Einrückung (nur in `ListItem` außerhalb von Code). Damit startet ein neues `- [ ] ` nach einem Listenende eine frische Liste.
- Geordnete Liste: `1. eins` ↵ `zwei` → `2. zwei` funktioniert bereits (markdowns `insertNewlineContinueMarkup`; `insertTightListItem` greift nur in `BulletList` und gibt sonst `false` zurück). Der frühere Befund „wird zu `- zwei`" war ein Folgefehler der Backspace-Einrückung (verschachtelt in einer Bullet-Liste). Per Unit- und e2e-Test abgesichert, kein Code nötig.
- Fenced Code: Atomic schließt die Umzäunung automatisch; der Cursor bleibt hinter dem öffnenden ` ``` ` (Infostring). Das e2e-Skript tippt deshalb ` ``` ` ↵ Code, dann ↓ End — kein Fehler im Editor, Testablauf korrigiert.

**Exploratives e2e verschärft:** Am Ende wird `localStorage['picky.draft']` exakt gegen das beabsichtigte Markdown verglichen (inkl. `1. eins\n2. zwei`, `**fett**`, `*kursiv*`, `` `code` ``, `> zitat` gefolgt von nicht zitierter Umzäunung); pro Quellzeile (DOM-Zeile i == Quellzeile i) werden Klassen geprüft: nur `#`-Zeilen haben `cm-atomic-h*`, `---` hat `cm-atomic-hr`, nur `> `-Zeilen `cm-atomic-blockquote`, Code-Zeilen `cm-atomic-fenced-code` + andere (Mono-)Schrift, Listenzeilen `cm-atomic-list-marker`/`-bullet`/`-task-checkbox`, `cm-atomic-strong`/`-em`/`-inline-code`/`-link`. Das per-Tastendruck-`assertSteady` bleibt. Unit-Tests (`editor.test.tsx`): +13 für Auto-Close, Quote-Austritt, Backspace-Marker, Fenced-Code-Schutz.

**Screenshot (`test-results/…/exploratory.png`, gitignored, angesehen):** Editor ist ans Dokumentende gescrollt: Bullets `•` mit eingerücktem Unterpunkt, `1. 2.`-Liste mit Nummern, leere Checkbox + „aufgabe", **fett**, *kursiv*, `code`-Chip, Zitat mit Balken und anschließend ein separater, nicht zitierter Codeblock (Mono, getönter Hintergrund), Link „label" mit Icon, Cursor auf der letzten leeren Zeile. Keine überdimensionierte Zeile, keine übrigen `*`/`>`-Reste.

**Stand:** typecheck ok, desktop 37 Unit-Tests (vorher 24, +13 für die editor.ts-Fixes), e2e 5/5. Mutationsprobe: ohne die neuen Extensions schlägt der explorative e2e fehl („Backspace on an empty bullet must leave a completely empty line", Received `"  "`).

*(Zwischenstand davor:)* typecheck ok, desktop 24 Unit-Tests (vorher 17, +7), e2e 5/5 (vorher 4/4, +1).

**Explorativer e2e-Test verschärft.** `step()` tippt jetzt Zeichen für Zeichen mit `inspect()`+`assertSteady()` nach jedem Tastendruck (vorher nur einmal pro `step()`). `assertSteady` lässt `cm-atomic-h*` nur auf den drei ATX-Zeilen (Index 0..2) zu und prüft, dass jede Nicht-Heading-/Nicht-HR-/Nicht-Code-Zeile die Absatz-Schriftgröße hält (Absatz-Schriftgröße und -Familie werden lazy beim ersten Auftauchen der Zeile „Eine Zeile Text" gemerkt; Code-Zeilen werden über abweichende `font-family` übersprungen). Shift+Tab wird jetzt wirklich als `Shift+Tab` gedrückt (vorher ging `shiftKey` verloren und Tab rückte nur weiter ein); nachgeprüft per Draft in `localStorage` (vor/nach: letzte Zeile ohne führende Whitespace). Backspace auf leerem „"- " beendet die Liste: nachgeprüft per DOM-Probe (`•` aus der letzten Zeile weg). `expect.fail` ersetzt durch `expect(...).toBe(true)` mit Message. Gates erneut grün: typecheck ok, server 81 + 10 PG übersprungen, cli 5, shared 2, desktop 24, e2e 5/5. Keine Änderung an `apps/desktop/src`.

## Editor: Enter auf leerem Listen-/Aufgaben-/Nummern-/Zitat-Marker (Obsidian/Notion)

**Auftrag.** Nach dem Setext-Fix aus Runde 1 immer noch falsch: auf einem leeren `- `/`- [ ] `/`1. `/`> `-Marker wird beim Drücken von Enter die Liste/das Zitat ohne Trennzeile beendet, sodass die nächste Zeile als Lazy-Continuation in das vorherige Item läuft. Obsidian/Notion verhalten sich anders: nach Enter steht eine Leerzeile, und der nächste Text beginnt einen neuen Absatz.

**Ursache (drei getrennte Bugs in Atomic Editor + `@codemirror/lang-markdown`):**
- (a) Bullet/Aufgabe: Atomic Editor registriert `Prec.highest(keymap.of([{Enter: insertTightListItem}]))` (`inline-preview.js:1009`). Auf einer leeren Top-Level-Zeile `- ` leert die Funktion nur die Zeile (`view.dispatch({ changes: { from: line.from, to: line.to, insert: "" } })`) und fügt **keine** Trennzeile ein. Der nächste Tastendruck hängt deshalb am vorherigen Item als Lazy-Continuation. Eigene Keymaps bei gleicher Präzedenz verlieren.
- (b) Nummerierte Liste: `insertNewlineContinueMarkup` (`@codemirror/lang-markdown/dist/index.js:204-248`) behandelt `2. ` (leeres nummeriertes Item) im Zweig "Move second item down" und fügt **vor** dem `2. ` eine Leerzeile plus Zeilenumbruch ein, behält aber `2. `. Der nächste Text läuft dort weiter.
- (c) Zitat: die bisherige Erweiterung in `apps/desktop/src/lib/editor.ts` (Round 1) hat Enter auf leerer `> `-Zeile nur per `clearEmptyMarker` behandelt — Zeile wird geleert, aber **keine** Leerzeile davor gesetzt. Folge: `> zitat\n> ` ⏎ ⏎ `danach` ergab `> zitat\ndanach` und `danach` war noch im Blockquote.

**Fix.** Alles in `apps/desktop/src/lib/editor.ts`, weiter über die `extensions`-Prop verdrahtet, kein node_modules-Patch. Eine Funktion `leaveEmptyMarker(view)`:
- Selektion muss leer sein und der Cursor am Zeilenende.
- Zeile matched `/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?$/` (leerer Listen-Marker, gleiche Regex wie für Backspace, mit Capture-Gruppe für die Einrückung) und liegt in `ListItem`, oder matched `/^(\s*)(>\s*)+$/` und liegt in `Blockquote`. Beide Checks durch das vorhandene `inside(state, pos, name)` geschleust, das in `FencedCode`/`CodeBlock` sofort `false` liefert.
- Eingerückter Listen-Marker (Capture-Gruppe 1 nicht leer): `indentLess(view)` aus `@codemirror/commands` (bereits Dependency). Ein weiteres Enter auf der jetzt oberen Ebene beendet die Liste.
- Oberste Ebene (oder Zitat, das ist der gleiche Pfad): Zeile wird durch `state.lineBreak` ersetzt, wenn die vorige Zeile nicht leer ist, sonst durch `''`. Cursor landet direkt nach dem Insert. `userEvent: "delete"` für korrektes Undo/Redo.

Verdrahtung: `Prec.highest(EditorView.domEventHandlers({keydown}))` nur für Enter ohne Shift/Ctrl/Meta/Alt und ohne `isComposing`, mit `event.preventDefault()` bei Treffer. Begründung (im Code-Kommentar): der Keymap-Dispatcher läuft als `Prec.default-domEventHandler` (`@codemirror/view/dist/index.js:9117`); ein `Prec.highest`-`keydown`-Handler feuert davor und kann Atomic + Markdown-Pfad abschneiden. Drop-Kommentar: „shortcut: … drop once Atomic accepts an Enter escape hatch."

Der alte Keymap-Eintrag `clearEmptyMarker(/^\s*(>\s*)+$/, "Blockquote")` für Enter ist entfernt (durch den neuen Pfad vollständig abgedeckt); der Backspace-Eintrag `clearEmptyMarker(emptyListMarker, "ListItem")` bleibt, weil Backspace bewusst keine Leerzeile einfügen soll.

**Unit-Tests (`apps/desktop/src/editor.test.tsx`):**
- `press()` schickt jetzt für `Enter` echte `keydown`-Events auf `view.contentDOM` (statt `runScopeHandlers`), damit der DOM-Handler mitläuft. Tab/Backspace bleiben auf dem bewährten `runScopeHandlers`-Pfad.
- Quote-Test raus (assertete die Lazy-Continuation). Neu: 4 exakte Draft-Asserts `it.each` für `- a`, `- [ ] a`, `1. a`, `> a` mit je 2 Enters + `danach` → exakt `- a\n\ndanach` (etc.). `noListOrQuoteAncestor(view, doc.length)` läuft die `resolveInner`-Kette hoch und prüft, dass weder `ListItem` noch `Blockquote` ein Vorfahre ist.
- Verschachtelt: `- a` ⏎ Tab `b` ⏎ ⏎ ⏎ `danach` → exakt `- a\n  - b\n\ndanach`.
- Fenced Code: `mount("- a\n```\n- \n```")`, Cursor an Position 10 (Ende der `- `-Zeile innerhalb der Umzäunung), Enter, Doc-Split enthält `- `, letzte Zeile ist immer noch ` ``` `, `hasNode("FencedCode")` weiterhin wahr. Beweist, dass der Handler innerhalb von FencedCode no-op ist und der Default-Enter (literal newline) läuft.
- „Enter on an empty item ends the list" umbenannt auf „… and inserts a blank line before the next paragraph" und auf exakten Doc `- a\n\n` gehärtet.
- Backspace-Tests (`- a\n- ` → `- a\n`, `1. a\n2. ` → `1. a\n`, …) bleiben grün.

**e2e-Tests (`apps/desktop/e2e/editor.spec.ts`):**
- Fünf neue Tests `it.each` (bullet, task, ordered, quote, nested): Type-Referenz-Absatz `para`, zwei Blank-Line-Enters, dann den Item-Text, zwei/drei Enters zum Beenden, `danach`. Pro Test: exakter `localStorage['picky.draft']`-Vergleich, danach: `danach`-DOM-Zeile darf weder `cm-atomic-(list|blockquote|bullet|task)` als Klassen- noch als inneres Klassen-Token enthalten, und ihre `padding-left` (per `getComputedStyle`) muss exakt der `padding-left` der `para`-Zeile entsprechen.
- Explorativer Test: überflüssige „blank line"-Enters nach jedem Listen-/Zitat-Ausstieg entfernt (die Trennzeile liefert jetzt der Handler). `assertSteady` ist jetzt `async`, liest den aktuellen Draft per `page.evaluate` und leitet die erlaubte Heading-Klasse aus der Draft-Zeile ab (`/^(#{1,6})/`, weil Atomic `#` schon vor dem Leerzeichen als Heading rendert) — nicht mehr aus einem hartcodierten Index `i < 3`. `step()` schreibt nach jedem Aufruf einen Screenshot nach `test-results/…/step-NNN-<slug>.png` (via `test.info().outputPath`), 51 Stück pro Lauf, plus die alte `exploratory.png` am Ende. `test.setTimeout(90_000)` für die zusätzliche Per-Step-Probe.

**Negativprobe.** `enterLeavesEmptyMarker`-Body auf `return false` zurückgebaut, nur die Editor-Unit-Tests laufen lassen: genau die 6 neuen Enter-Asserts brechen (alle vier `it.each`-Cases + nested + „inserts a blank line before the next paragraph"). Backspace-Asserts bleiben grün, Fence-Test grün. Handler wieder eingebaut, alle Tests grün. Die Tests fangen also genau das, was sie fangen sollen.

**Stand:** typecheck ok, server 81 + 10 PG übersprungen, cli 5, shared 2, desktop **42** (vorher 37, +5 für die Enter-Asserts), e2e **10** (vorher 5, +5 für die fünf Marker-Exit-Tests).

## Lauf-Journal: Editor-Run `editor-setext` (2026-10-15) — Abschluss

**Auftrag:** Text ↵ `-` machte die Zeile darüber zur Überschrift; exploratives, zeichenweises Testen mit visueller Prüfung; Verhalten wie Obsidian/Notion.

**Ergebnis:** 3 mw-Zyklen (Plan opus, Build minimax, Review sol) plus Reviewer-Agent, Verdict accept, `mw orchestrate finish` → `goal: met`. Commits auf `main` (lokal, nicht gepusht): 345f642, 3326692, 4fb0e2f, a4dc73d, 7d5413a, 0a0d9ef.

**Zuletzt gefunden und behoben (0a0d9ef):** Backspace auf leerem `- ` direkt unter Text ließ `text\n-` stehen (Lezer sieht dort kein `ListItem`). Handler prüft jetzt nur noch „nicht in Code“. Tests +2 Unit.

**Prüfstand:** tsc 0, Unit 44/44, e2e 10/10 (Playwright, Chromium). Eigene Sichtprüfung: 29 Einzelschritt-Screenshots, kein Fehl-Titel, Listen/Zitat/Task/Code/Trenner ok.

**Vertagt (Followups, dokumentiert):**
- Backspace auf leerem *verschachteltem* Marker flacht komplett statt eine Ebene; Enter auf verschachteltem leerem Zitat verlässt alle Ebenen (minor).
- `*`/`_`-Inputhandler ohne Multi-Cursor-Guard (minor).
- Duplizierter Parser verliert `codeLanguages` (minor; Entfernung, sobald Atomic Lezer-Extensions annimmt).
- Testlücken: closeBrackets-Wrap, IME, verschachtelte Zitate.
- Natives Tauri-Fenster visuell ungesehen (Bildschirm gesperrt); alle Browsertests liefen in Chromium, nicht WebKit.
- VPS-Deployment: technisch umsetzbar, aber Briefing-Guardrail verlangt Nutzerentscheidung (Option 1 isolierter Compose-Stack unter `/srv/pickynotes/vault`, 127.0.0.1 — empfohlen; 2 eigener Pfad + Tailscale; 3 vertagen). VPS nur lesend untersucht, nichts verändert. Vertagt bis zur Entscheidung.
- `git push` nur auf ausdrückliches Ja.

**Runde 3 — Editor-Features, Anhänge, Sprache:**

**WP1 Editor (`apps/desktop/src/lib/editor.ts`).**
- Fence hiding: öffnende und schließende ```-Zeile (auch 4+ Backticks) bekommen `cm-pn-fence-hidden`, solange Cursor außerhalb (`head < to`, also `head == to` zählt als nach dem Block). Decoration auf Prec.highest, damit Atomic's eigenes Rendering überschrieben wird.
- ArrowDown/Auf am Blockrand verlässt den Block (Prec.high keydown-Handler), ArrowDown am Dokumentende fügt eine neue Zeile nach dem Block ein.
- Tabellen-Toolbar: ViewPlugin erscheint, sobald der Cursor in einer `Table`-Node sitzt, mit Buttons ⊕/⊖ Zeile, ⊕/⊖ Spalte, ⇤L/⇔C/⇥R (Alignment als `:--`/`:-:`/`--:`), ◀/▶ (Spaltenbreite als Dash-Anzahl). Schreibt die Quellzeilen direkt, weil Atomic's `serializeTable` jede Zelle auf `---` normalisiert; eigener `readDelimiter`/`formatDelimiter` hält Alignment + Dash-Count durch Schreibvorgänge.
- Sub/Sup: Decoration Mark-Decoration für `~x~` (single tilde, lookbehind rejectet `~~`) und `^x^`. Lezer-Markdown liefert schon `Subscript`/`Superscript`-Knoten, aber ohne CSS-Klasse — die Decoration bringt `cm-pn-sub`/`cm-pn-sup` ins DOM.
- Emoji defect fixes: InlineCode/FencedCode/CodeBlock übersprungen, `\:joy:` (Backslash-Escape) übersprungen, Selektion *innerhalb* des Shortcodes lässt die Quelle sichtbar (kein Widget), unbekannte Namen bleiben als plain text. `:grin:` → 😁. `selTouches` prüft `head >= from && head < to`, damit Cursor am Ende nicht „innerhalb" ist.
- Pending-Attachments-Decoration: `![…](pending:<id>)` und `[…](pending:<id>)` rendert als Chip/Vorschau bis der Server die Links ersetzt.
- ATOMIC_CODE_LANGUAGES an den duplizierten Parser durchgereicht, damit Fenced Code Highlighting bekommt.
- Unit: `H~2~O` → `cm-pn-sub`, `x^2^` → `cm-pn-sup`, Fence hide bei 3- und 4-Backtick, Emoji-Code/Fence/Escape/Selektion/`:grin:`, Tabellen-Alignment-Survival.

**WP2 Anhänge.**
- `packages/shared/src/schemas.ts`: `CaptureAttachment = {id,name,mime,data}` und `CaptureInput.attachments?` (max 20).
- `packages/server/src/services.ts`: Text-Branch speichert jede Attachment via `vault.writeAttachment(noteId, name, bytes)` und schreibt `pending:<id>` im Body zu `raw/attachments/<noteId>-<safe>` (unbekannte IDs bleiben pending — Retry-fest). `openapi.json` regeneriert.
- `apps/desktop/src/lib/attachments.ts`: IndexedDB `pickynotes-attachments` für die Bytes. `stashAttachment` schreibt, `readAttachmentsForSend` liest beim Flush. IDs in Crypto-Random.
- `apps/desktop/src/lib/editor.ts`: `paste`/`drop` `domEventHandler` (Prec.highest) liest `clipboardData.files`/`dataTransfer.files`, stasht und fügt `![…](pending:<id>)` (Bild) oder `[…](pending:<id>)` (Datei) an der Position ein.
- `apps/desktop/src/CaptureView.tsx`: Screenshot- und Datei-Button gehen über denselben Pfad (Inline-Insert, nicht Standalone-Capture). `sendText` hängt `attachments` aus `readAttachmentsForSend()` an.
- Server-Tests: `text with attachments: stores each attachment and rewrites pending:<id>` + `unknown pending:<id> left as-is`.

**WP3 Sprache (WhisperStorm + Rust + TS).**
- `~/PROJECTS/WhisperStorm/Sources/App/ControlSocketServer.swift` (neu): AF_UNIX auf `~/Library/Application Support/WhisperStorm/control.sock`, chmod 0600, stale socket wird beim Start unlinked. Protokoll: `{"cmd":"start"|"stop"|"status"}\n` → `{"ok","phase","text"?,"error"?}\n`. Hop auf `@MainActor` und durch `DictationCoordinator`.
- `DictationCoordinator` bekommt `enum DeliveryMode {.hotkey, .socket}`; im Socket-Modus wird `TextInserter.insert` übersprungen, damit das Transkript nicht doppelt landet. Nach jedem Request zurück auf `.hotkey`, damit der Hotkey-Pfad weiter klebt. AppDelegate startet/stoppt den Server (start bei `applicationDidFinishLaunching`, stop bei `applicationWillTerminate`).
- `apps/desktop/src-tauri/src/lib.rs`: `whisperstorm(cmd)` mit `std::os::unix::net::UnixStream`, Read-/Write-Timeouts (5 s Request, 120 s für `stop`), camelCase-Reply-Struct. Bei `ConnectionRefused` oder fehlendem Socket: `{ok:false, error:"WhisperStorm läuft nicht"}`. `serde`/`serde_json` ergänzt.
- `cargo test --lib`: `whisperstorm_sends_and_receives_json` (per-line Handshake gegen einen temporären UnixListener) und `whisperstorm_handles_missing_socket`.
- `apps/desktop/src/lib/tauri.ts`: `whisperstorm(cmd)`-Wrapper; im Browser fallback → `WhisperStorm läuft nicht`.
- `apps/desktop/src/CaptureView.tsx`: Sprache-Button sendet `start`/`stop`, fügt das Transkript an der Cursorposition ein (via `editorHandleRef` → `EditorView.findFromDOM` → `insertTextAtCursor`).
- `scripts/whisperstorm-status.mjs`: öffnet Socket, sendet `status`, antwortet mit JSON-Zeile, exit 0 nur bei `ok:true`. Startet die App, falls Socket fehlt.

**WP4 e2e.**
- `apps/desktop/e2e/features.spec.ts` (neu): pro Feature eine Spec mit Zeichen-für-Zeichen-Tippen und Screenshot pro Schritt. Coverage: sub/sup, fence hiding (3+4 Backticks), `:rocket:` (Draft + DOM), Task-Checkbox Toggle (Draft `[ ]` ↔ `[x]`), Tabelle-Toolbar (Center Alignment), Paste-Image.

**Vertagt (mit Grund):**
- Natives Fenster visuell ungeprüft (Bildschirm gesperrt; alle e2e liefen in Chromium, nicht WebKit). Brief wie in Runde 2.
- WhisperStorm-Socket-Status-Gate (`scripts/whisperstorm-status.mjs`) braucht eine signierte Build und eine GUI-Session zum App-Start; lokal ok, automatisierter Run bleibt manuell.
- WebKit-Layout/Smoke bleibt; Coverage der bestehenden Layout-Tests reicht für Chromium.

**Nachtrag (Abschluss-Versuch VPS + natives Fenster):**
- **Native App:** gebaut (`tauri build --bundles app`, 10 MiB) und nach `/Applications/pickyNotes.app` kopiert. Start ok: Fenster rendert (Tabs Erfassen/Suche/Einstellungen, Editor, Buttons Speichern/Sprache/Screenshot/Datei). Tippen per AppleScript scheiterte: Fokus lag nicht auf der App, Eingaben gingen vermutlich ins Finder-Fenster (Auswahl dort unverändert sichtbar, Dateinamen intakt; bitte kurz prüfen). Zeichenweise Editor-Prüfung bleibt deshalb auf Chromium/Playwright beschränkt.
- **VPS:** Deployment nach Option 1 vorbereitet und vorgeprüft (Port 8791 frei, 95 GB Platz, 5,8 GB RAM frei, Docker Compose 5.0.2, `/srv/pickynotes` existiert nicht). Der Upload/Build auf dem Produktions-Host wurde vom Berechtigungssystem der Sitzung abgelehnt (Production Deploy) und nicht umgangen. Nichts auf dem VPS verändert. Ausführung: `! ssh VPS-hosti` bzw. Regel für `ssh VPS-hosti` freigeben, dann `git archive HEAD` → `/srv/pickynotes/app`, `.env` (VAULT_HOST_PATH=/srv/pickynotes/vault, SERVER_PORT=8791, PUBLISH_ADDR=127.0.0.1), `docker compose up -d --build`, einmaliger `claude`-Login im Container.

## Zyklus 2 (Branch `md-features`): Editor-Abnahme gegen HEAD bbda0dc

Mehrere Review-Funde waren veraltet (Rust-Command, CaptureView-Verdrahtung, Server-Rewrite samt Test, Toolbar, sub/sup und Emoji existierten schon). Gate-Basis war grün (typecheck, 64 Unit, 16 e2e). Gemessen statt angenommen:

| Fund | Stand HEAD | Jetzt |
|:--|:--|:--|
| Speech/WhisperStorm | vorhanden (Rust `whisperstorm`, Swift-Socket) | `node scripts/whisperstorm-status.mjs` gegen die echte App: exit 0, `{"ok":true,"phase":"idle"}`; neu: `WHISPERSTORM_SOCKET`-Override + Fake-Socket-Test, e2e mit gemocktem Tauri-`invoke` (Transkript an Cursor, Fehlermeldung); WhisperStorm baut (xcodegen + xcodebuild Release, BUILD SUCCEEDED), Swift unverändert |
| Text-Capture + Anhänge (Server) | vorhanden, Test 50/50 | unverändert |
| Paste/Drop | Bild ok, PDF/Drop ohne Test | e2e PDF-Paste, Bild-Drop, Screenshot-/Datei-Button; Anhänge bekommen eine eigene Zeile, Buttons nutzen denselben Code (`insertAttachmentAt`) |
| Task `- [` | **echt kaputt**: `- []`, keine Checkbox | Input-Regel, 5 Varianten + Link-Fall zeichenweise getestet |
| Tabellen-Ausrichtung | **echt kaputt**: kein `text-align`, Atomic schrieb `---` zurück | Zellklassen/`text-align` aus der Trennzeile, Transaction-Filter stellt sie nach Zellbearbeitung wieder her |
| Tabellen-Toolbar | **unsichtbar**: unter dem Editor von `overflow:hidden` abgeschnitten, nach Klick in eine Zelle weg | Leiste am unteren Rand, auch bei Zellfokus; Breite± beschriftet |
| 4-Backtick-Fence | Auto-Close von Atomic setzte 3 Backticks, Block blieb offen | schließende Fence wächst mit; ArrowDown ab letzter Textzeile verlässt den Block (vorher: auf die versteckte Schlusszeile) |
| `<sub>`/`<sup>` | blieb Quelltext | Tags verborgen, Inhalt tiefer/höher; `~x~`/`^x^` ohne Leerraum, Delimiter verborgen |

**Zusätzlich beim Prüfen gefunden und behoben:** `^…^` überspannte Absätze (`[^1] … [^2]`), geordnete Listen verschachtelten mit Tab nicht (2 statt 3 Leerzeichen → Geschwister), Enter auf leerem verschachteltem `1. ` ließ ` 2. ` stehen, Tabelle von Hand tippen verlor Tasten ab gültiger Trennzeile. Das alte Features-e2e für Tabellen prüfte nur `includes("---")` und hatte das verdeckt.

**Verhaltensänderungen:** (1) `[` direkt hinter einem Listenmarker wird zu `[ ] `; (2) Enter am Ende einer Pipe-Zeile außerhalb einer Tabelle baut Tabellengerüst; (3) ArrowDown verlässt einen Codeblock schon von der letzten Textzeile (editor.spec angepasst); (4) verschachtelte geordnete Ebene beginnt bei 1.; (5) Anhang-Links stehen in eigener Zeile.

**Neu implementiert:** Fußnote (Ref hochgestellt, Definitionszeile), Definitionsliste, Heading-ID (gedimmt), Inline-HTML (`b strong i em u ins s del mark kbd sub sup`), Entities (`&nbsp;` …). e2e `markdownguide.spec.ts`: 25 Features, Draft + DOM-Klassen, Screenshot je Zeile (`apps/desktop/test-results/`, Sichtprüfung per Kontaktbogen: Überschriften, Listen, Zitat, Code, Links, Task, Tabelle, Paste/Drop, Sprache, Fence).

**Vertagt / nicht gerendert (mit Grund):**
- `<br>`, `<center>`, `<p align>`, `<img width>`, `<details>`, Farbe (`<font color>`, `<p style>`), Bildunterschrift (`<figure>`), Link-Ziel (`<a target>`), HTML in Tabellenzellen, Inhaltsverzeichnis: kein HTML-Renderer im Editor; ein `<br>`-Widget würde die CM-Cursornavigation brechen. Quelltext bleibt sichtbar und unverändert (`<center>`/`<br>` getestet). Admonitions und `[![img](…)](url)` rendert Atomic nativ.
- Tabellen-Ausrichtung: Wer die Trennzeile einer ausgerichteten Tabelle von Hand markiert und durch `| --- | --- |` ersetzt, bekommt die alte zurück (der Filter erkennt nur Toolbar-Schreibvorgänge per Annotation, nicht Absicht).
- `<center>` am Zeilenanfang: Atomics Tag-Auto-Close setzt `</center>`; das Schließ-Tag von Hand zu tippen verdoppelt es (End-Taste statt tippen; Upstream-Verhalten, nicht angefasst).
- Setext-Überschriften: bewusst aus (Vorgabe).
- Tabellen: Spaltenzahl über Atomics eigenes Zellmenü ändern verliert die Ausrichtung (Filter greift nur bei gleicher Spaltenzahl); die eigene Leiste erhält sie. Breite = Dash-Anzahl, im Editor nur als `min-width` (GFM kennt keine Breite).
- Aufgabenliste: Eintrag, der direkt nach `- [` mit `x` beginnt, wird als `[x]` gelesen; Tab/Shift-Tab in gemischten Listen (Aufzählung unter geordnet) rückt weiter um 2 ein.
- Definitionsliste/Fußnote: nur Klassen/Widgets im Editor, keine Navigation Ref ↔ Definition; lezer liest `[^1]: Text` als Link-Referenz (CSS neutralisiert die Linkoptik).
- Natives Tauri-Fenster weiter nicht visuell geprüft (Chromium/Playwright, nicht WebKit). Echte Transkript-Aufnahme nicht automatisiert (Mikrofon/GUI); belegt sind Protokoll (Fake-Socket), `status` gegen die echte App, Rust-Roundtrip-Test und die gemockte UI-Strecke.

**Gates:** typecheck 0; Unit server 83 (+10 PG übersprungen) / cli 5 / shared 2 / desktop 85; e2e 55; `cargo test` 2; WhisperStorm baut.

**Review-Fixes (Zyklus 2, je ein Commit):**
- Server: Anhänge heißen `<noteId>-<attachmentId>-<name>`; zwei `screenshot.png` überschrieben sich vorher (beide Links zeigten auf die letzte Datei). Tests: zwei Dateien/zwei Links, Retry mit gleicher `clientId` ohne Duplikat. WhisperStorm: `stop` wartet auf dem Socket-Thread statt im Hauptthread (vorher blockierte das die Transkription, jede Aufnahme endete in „transcription timeout“); `deliveryMode = .socket` bis success/error. **Echt geprüft:** `start`, 2,5 s, `stop` gegen die neu gebaute App → `phase: success`, Transkript nach 1,1 s (Raumgeräusch: „Okay.“). Rust: `whisperstorm_at(path, cmd)`, beide Tests rufen den Produktionscode.
- e2e: PDF-Drop (Draft, Chip, gestashte Bytes, Screenshot); je Ausrichtung ein eigener Screenshot. Stash behält nach dem Speichern Links, die der Live-Entwurf noch enthält. Chip-Guard für Code war wirkungslos (`inside()` liefert in Code immer false) → `inCodeSpan`; Randfall Blockanfang bei eingerücktem Code behoben (betraf auch `:emoji:`).
- Gates: typecheck 0; Unit server 85 (+10 PG übersprungen) / cli 5 / shared 2 / desktop 89; e2e 56; `cargo test` 2; WhisperStorm Release baut. `npm test` war unter Node 26 rot (Node-eigenes `localStorage` überlagert jsdom): `--no-experimental-webstorage` in `vite.config.ts`. Offen: `start` antwortet mit der Phase vor dem Start (`idle`); ein Client, der nur `start` sendet, lässt die Socket-Auslieferung bis zum nächsten `stop` an.

## Zyklus 3: Review-Minors (Branch `md-features`)

| Punkt | Stand | Beleg |
|:--|:--|:--|
| Anhangsname-Kollision (Blocker) | schon in e1630ce behoben (`sha256(id)[0:16]`, doppelte ID → 400); Test prüft jetzt beide umgeschriebenen Links, Dateien und Bytes | `app.test.ts` „ids that differ only by '-'…“ |
| Anhang-ID-Zeichensatz | `CaptureAttachment.id` = `^[A-Za-z0-9_-]{1,100}$` (= Regex der Link-Umschreibung); `openapi.json` neu | „an id outside … is rejected“ |
| `whisperstorm` async | `async fn` + `spawn_blocking`, JoinError → `Err(String)`; Client liest bis `\n` statt EOF | Rust-Test „returns on the newline without waiting for eof“ |
| Fence ArrowDown | bewegt nur den Cursor; Text nur, wenn der Block das Dokumentende ist; umgebrochene Zeile außerhalb der letzten visuellen Zeile → CM bewegt selbst (`coordsAtPos`) | `editor.test.tsx` „Fence ArrowDown exit…“ |
| Paste | Anhang nur bei exakt leerem `text/plain` und textlosem `text/html` (Browser-Bildkopie bleibt Anhang). Bewusster Trade-off: Finder-Kopie (Dateiname in `text/plain`) fügt Text ein, Namensabgleich war nicht von echtem Text unterscheidbar; Dateien per Drop/Datei-Button | „Paste intercepts pure file clipboards only“ |
| Tabellen-Leiste | Zeile/Spalte aus fokussierter Widget-Zelle bzw. Quell-Cursor; vier Aktionen dort | „Table toolbar acts on the cursor's row and column“ |
| Socket-Härtung | Ordner 0700, `umask(077)` um `bind`, 64 KB, 5 s `SO_RCVTIMEO`, `\n` pro Antwort; `start` wartet auf `startDictation()` (30 s), bei Timeout wird die spät startende Aufnahme abgebrochen | echt: `stat` drwx------ / srw-------, `status`-Antwort mit `\n`, 100 KB → `request too large` |
| Leeres Transkript | „Kein Text erkannt – nichts eingefügt.“ | `CaptureView.test.tsx` (leer, nur Whitespace, Text) |
| Inline-Extraktion | Job `extract-inline` für image/* und PDF; Marker `<!-- extract:<pfad> -->`…`<!-- /extract -->`, idempotent; Text zählt nicht als eigene Eingabe (`@claude` darin läuft nie, Mutationstest) | `app.test.ts` „inline image/PDF attachments…“ |
| Review-Fix: Paste | kein trim, kein Namensabgleich (`shot.png`, `\t\n` neben Bild → Text) | `editor.test.tsx` „text/plain equal to the file name…“, „whitespace-only…“ |
| Review-Fix: Start-Timeout | `read_timeout(cmd)`: start 40 s (> Swift 30 s), stop 120 s, sonst 5 s; Sprache-Button zeigt „Starte Aufnahme…“ und ist währenddessen gesperrt | Rust `start_deadline_outlasts_the_30s_swift_start_wait`, `CaptureView.test.tsx` „pending state“ |
| Review-Fix: extract-inline Retry | Marker vorhanden → kein LLM/Append, aber `syncRow` + `embed` laufen trotzdem (Absturz nach Dateischreiben ließ die Zeile ohne Text) | `app.test.ts` „extract-inline: a retry after a failure…“ (Mutationstest: rot mit altem Code) |

**Vertagt:** Der Umbruch-Guard der Fence-Navigation braucht Layout und ist in jsdom nicht prüfbar (nur e2e/visuell). Der Idle-Timeout (5 s) des Sockets ist nicht live gemessen (gesetzt per `setsockopt`). Echtes WebKit-Clipboard (Finder-Kopie) nicht automatisiert. `extract-inline` kann nach `curate` fertig werden: der Text ist indiziert, die Zusammenfassung kennt ihn dann nicht.

**Abschluss `md-features` (2026-10-15):** Unabhängiger Re-Review der Zyklus-3-Fixes (Diff `3e86884..main`, WhisperStorm `a3075a7..HEAD`): **ACCEPT**, keine Blocker/Major. Eigene Gates auf `main`: tsc 0, Unit desktop 110 / server 92 (+10 PG übersprungen) / shared 5 / cli 2, e2e 56/56, cargo 4/4. Echter Socket-Lauf gegen das neu gebaute WhisperStorm: `start` → `recording`, `stop` → Transkript (Stille ergab „Thank you.“, eine Whisper-Halluzination).
- **Followups (minor):** Swift-Socket: 5-s-Timeout gilt pro `read`, nicht als Gesamtfrist; spätes Reply bei übergroßer Anfrage kann verloren gehen; `listen()`-Fehler lässt die Socket-Datei liegen; kein Test für die Socket-Härtung (WhisperStorm hat kein Test-Target). Server: `<!-- extract -->`-Marker stehen im indizierten Body (Suche/Embeddings); `curate` kann vor `extract-inline` laufen; zwei gleichzeitige Duplikat-Jobs könnten beide das LLM rufen (nur ein Append landet). Rust: Timeout erscheint als rohe OS-Meldung. Whisper halluziniert auf Stille („Thank you.“).
- **Nicht verifiziert:** Tippen und Sprache im nativen Tauri-Fenster (keine Bedienungshilfen-Berechtigung); Mutationsläufe des Reviewers; VPS-Deployment (Sitzungsberechtigung „Production Deploy“ verweigert, wartet auf Freigabe von `ssh`/`scp` auf `VPS-hosti`).

## WhisperStorm: Mikrofon startete nicht mehr (2026-10-15, Abend)

**Symptom:** Hotkey und Socket-`start` lieferten `capture start FAILED … avfaudio error 35` bzw. `STOP samples=0`; das Mikrofon selbst war in Ordnung (Audacity).
**Ursachen:**
1. Zweitinstanz: `scripts/whisperstorm-status.mjs` startete per `open` das Build-Verzeichnis, wenn `control.sock` fehlte (die Instanz in `/Applications` war veraltet, ohne Socket). Zwei Instanzen kämpfen um Hotkey und Mikrofon. Behoben (f07c42b): nie `open`, solange ein WhisperStorm-Prozess läuft.
2. `AVAudioEngine.start()` scheitert mit `kAUStartIO` (Fehler 35), weil die Engine das Default-Ausgabegerät (C-Media USB Audio Device) in ein CoreAudio-Aggregat zieht. Reproduziert ohne WhisperStorm (Probe `micprobe.swift`): Engine 2/2 Fehler, `AVCaptureSession` lieferte auf demselben Elgato Wave:3 ~144.000 Samples.
**Fix (WhisperStorm 9aaba4e):** `AudioCaptureEngine` auf `AVCaptureSession`/`AVCaptureAudioDataOutput` umgestellt (input-only), `start` ist async und läuft nicht auf dem Main-Actor, Buffer werden ab dem ersten Callback angenommen. Neu nach `/Applications/WhisperStorm.app` installiert.
**Beleg:** Socket-Test 3 Läufe: Fehler 35 weg, `samples=39401 / 37285` bei ~2,5 s; erster Lauf nach App-Start kann bis ~2,5 s verzögert beginnen (Wave:3-Warmup).
**Nicht verifiziert:** Hotkey-/PTT-Pfad (nur vom Nutzer auslösbar); Zusammenarbeit mit Peer-Session `whisperstorm-mic-detection` (Gegenprüfung des Diffs steht aus).

## Diktat-Hotkey Ctrl+Alt+V (2026-10-15)

- `registerHotkey()` registriert zwei Kürzel mit einem Handler: `CommandOrControl+Shift+Space` (nur nach vorn) und `Control+Alt+V` (nach vorn + Diktat umschalten). Handler: show/unminimize/setFocus, dann `CustomEvent("picky:focus-capture", {detail: {toggle}})`. Jedes Kürzel hat eigenes try/catch; ein belegtes Kürzel wird per `console.warn` geloggt, das andere läuft weiter.
- `App` hört auf das Event (CaptureView ist auf den anderen Tabs unmounted), wechselt auf „Erfassen“ und reicht `hotkey` als Prop herunter; `CaptureView` fokussiert den Editor und ruft bei `toggle` dasselbe `toggleRecording` wie der Button. Der Guard `if (starting) return;` wanderte in die Funktion, damit Hotkey und Klick ihn teilen (Doppel-`start` während der Mikrofon-Abfrage).
- **Annahmen:** Toggle statt Push-to-talk (so im Auftrag vorgegeben; Released wird ignoriert); wirkt nur, solange der App-Prozess läuft; `capabilities/default.json` unverändert (allow-register/is-registered und Fenster-Rechte waren schon da).
- **Bekannte Grenzen:** Aufnahmestatus liegt in `CaptureView`; Tabwechsel während der Aufnahme unmountet die Ansicht, der nächste Druck sendet dann `start` statt `stop` (gilt schon für den Button). Ein zweiter Druck während `stop` (Transkription) sendet erneut `stop`. `isRegistered` kennt nur eigene Registrierungen; ein stilles Verschlucken durch das OS ist nicht erkennbar.
- **Nicht verifiziert:** echtes globales Kürzel im nativen Fenster (keine Bedienungshilfen-Berechtigung); Kollision mit Eingabequellen-Kürzeln von macOS.
- **Belege:** Unit desktop 119/119 (neu: `lib/tauri.test.ts`, 4 Hotkey-Fälle in `CaptureView.test.tsx`; Mutationstest ohne Guard rot), tsc 0, e2e 57/57 (neu: Hotkey-Event von Einstellungen-Tab).

### Nachtrag: Kürzel Ctrl+Alt+V, Tabwechsel (2026-10-15)

- Kürzel von `Control+Alt+Space` auf `Control+Alt+V` geändert: Ctrl+Alt+Space kollidiert mit dem macOS-Umschalter der Eingabequelle.
- Tabwechsel-Lücke geschlossen: `CaptureView` bleibt auf allen Tabs gemountet und wird per `hidden` ausgeblendet (statt den Aufnahmestatus nach `App` zu heben). Der zweite Druck sendet so `stop` statt eines zweiten `start`; die „Bekannte Grenze“ zum Tabwechsel im Eintrag oben entfällt.
- Falle: `section { display: flex }` überstimmt das Browser-Default für `[hidden]`, daher `section[hidden] { display: none; }` in `style.css`. Ein Wrapper-div ginge nicht (`main > section { flex: 1 }`).
- Tests: App-Regressionstest in `CaptureView.test.tsx` (Start, Tab Suche, Stopp); der e2e-Hotkey-Test wechselt zwischen Start und Stopp auf Suche.

## Desktop-Shell: Einstellungen-Dialog, Notiz-Tabs, Kürzel, Dock/Menüleiste (2026-10-16)

- **Umbau:** Tabs „Erfassen/Suche/Einstellungen“ entfallen. Einstellungen = Dialog (`SettingsModal.tsx`, `Cmd/Ctrl+,`, Esc/×), Suche = Lupen-Button oben rechts mit schließbarem Panel, Tabs = offene Notizen (`lib/notes.ts`, `picky.notes`; `picky.draft` wird einmalig in den ersten Tab migriert und gelöscht). Eine einzige `CaptureView` bleibt gemountet (kontrolliert über `notes/activeId`), nur der Editor remountet pro Notiz: die Aufnahme übersteht Tabwechsel, das Transkript geht in die beim Stopp aktive Notiz. Die `hidden`-Prop und `section[hidden]` entfallen.
- **Letzter Tab:** „Speichern“/× ersetzt die letzte Notiz durch eine leere mit neuer ID. Grund: der Editor liest `markdownSource` nur beim Mount; der alte `docId`-Zähler ist dadurch überflüssig. `dropAttachments` zählt Links in anderen offenen Notizen mit, deren Bytes bleiben erhalten.
- **Kürzel:** `applyHotkeys(prev, next)` ersetzt `registerHotkey` (unregister alt, register neu, bei Fehler alt wiederherstellen, wirft nie, `isRegistered`-Skip entfällt; beim Start wird ein Rest aus einem Webview-Reload erst abgemeldet). Eingabe per Tastendruck-Feld (`keydownToAccelerator`, `e.code`, mindestens Command/Control/Alt). Gleiche Kombination für beide Kürzel wird im Dialog abgewiesen. Ein-/Ausblenden versteckt bei sichtbar+fokussiert.
- **Rust:** `ShellPrefs` (`shell-prefs.json` im App-Config-Ordner, fehlend/kaputt = Defaults), Befehle `set_dock_visible`/`set_tray_visible` wenden live an und speichern, `setup()` liest beim Start. Dock aus = `ActivationPolicy::Accessory`. Tray: `main-tray`, Standard-Fensterlogo, Linksklick toggelt, Menü Anzeigen/Verbergen, Einstellungen (Event `picky:open-settings`), Beenden. Fenster: `decorations:false`, `alwaysOnTop`, `visibleOnAllWorkspaces` in `tauri.conf.json`; unter macOS setzt `setup()` per `objc2-app-kit` zusätzlich `CanJoinAllSpaces | FullScreenAuxiliary` auf das NSWindow.
- **Belege:** tsc 0, Unit desktop 136 + shared, e2e 68 (neu `e2e/shell.spec.ts`, 11 Fälle), `cargo test` 7/7 (neu: Prefs-Defaults/Round-Trip, Menü-ID-Mapping); `cargo test` baut auch die macOS-Pfade und prüft damit Capability-IDs und `tauri.conf.json`.
- **Nicht verifiziert (nur im nativen Fenster prüfbar):** Fenster ohne Titelleiste und Ziehen an der Leiste (`data-tauri-drag-region` greift nur auf Elementen, die das Attribut selbst tragen: Leiste, Tablist, Spacer); Schweben über Vollbild-Spaces anderer Apps (**teilweise**: `alwaysOnTop` + `CanJoinAllSpaces | FullScreenAuxiliary`; unter Policy Regular (Dock an) kann macOS das Fenster trotzdem nicht über den Vollbild-Space einer anderen App legen, verlässlich ist Accessory = Dock aus; ein echtes NSPanel, `NSWindowStyleMaskNonactivatingPanel`, wurde nicht gebaut); Policy-Wechsel und Cmd+Tab; Tray-Icon, Klick und Menü (Icon ist das farbige Fensterlogo, kein Template-Bild); Neustart mit gespeicherten Dock/Tray-Werten; ein von einer anderen App belegtes Kürzel wird nur erkannt, wenn das Plugin beim Registrieren wirft (macOS tut das nicht in jedem Fall). Cmd/Ctrl+N im Tastendruck-Feld öffnet zusätzlich einen neuen Tab (der globale Listener läuft zuerst), das Kürzel wird trotzdem gesetzt. Schlägt der Start-Register eines gespeicherten Kürzels fehl, zeigt der Dialog trotzdem den gespeicherten Wert (nur `console.warn`).
- **Nebenbei:** Worktree hatte kein `node_modules` (daher rote Gates), `npm ci` behob das. `lib.rs` hat eine ältere Warnung (`unused import Read`), unberührt.

### Nachtrag: Review-Fixes Desktop-Shell (2026-10-16)

- **Blocker:** `saveNotes()` meldet jetzt per `boolean`, ob der Write klappte; `loadNotes()` löscht `picky.draft` nur nach erfolgreichem Write (vorher ging bei Quota-Fehler die einzige Kopie verloren). Tests: Quota-Fall behält Entwurf, Erfolgsfall löscht.
- **Kürzel:** `applyHotkeys` meldet erst alle geänderten alten Kürzel ab, registriert dann die neuen (Tausch zweier Kürzel klappt); scheitert eines, werden bereits registrierte neue wieder abgemeldet und die alten zurückgesetzt. Dialog sperrt Felder und „Zurücksetzen“, solange eine Änderung läuft. Tastenfelder tragen `data-shortcut-capture`; der globale Cmd/Ctrl+N/`,`-Listener ignoriert Tasten dort (Ctrl+N im Feld öffnet keinen Tab mehr).
- **Dialog:** Fokus-Falle (Tab) und Fokus-Rückgabe an das auslösende Element beim Schließen; e2e prüft Esc → Editor/Zahnrad fokussiert.
- **Tray:** nur noch ein Tray-Icon pro Lauf, Ein-/Ausschalten per `set_visible` statt Abbauen und Neubauen, damit Menü-Handler nicht mehrfach hängen. Nicht verifiziert (nur nativ prüfbar).

## Desktop Runde 2: Speichern verliert keine Notiz, Kürzel-Schalter, Suche, Textbreite, Vollbild, Listenmarker (2026-10-19)

- **Baseline (vor der Änderung, nach `npm ci`):** tsc 0, Unit 141, `cargo test` 7, e2e 71, alles grün. Der Worktree hatte kein `node_modules`.
- **Punkt 1, Root Cause:** `App.client()` wirft bei fehlender URL/Token einen einfachen `Error`. `CaptureQueue.run()` hält jeden Nicht-`ApiError` für vorübergehend und bricht still ab, `settle()` meldet dann „nicht abgelehnt = ok“, `sendText` ruft `onSent` und der Tab schließt. Die Liste zeigte nur abgelehnte Einträge, die Notiz war also unsichtbar. Offline lief über denselben Pfad. Reproduziert mit den neuen Tests (rot vor dem Fix).
- **Fix:** `CaptureQueue(name, outbox?)` schreibt in IndexedDB und in den Postausgang (Rust `outbox_write/list/delete/reveal`, `clientId` gegen `[A-Za-z0-9_-]{1,64}` geprüft, 0600, Temp-Datei + Rename). `enqueue` liefert `{key, clientId, stored}` und wirft nur, wenn beide Speicher scheitern. `restore()` läuft im Konstruktor und kopiert fehlende Postausgang-Einträge zurück (keine Duplikate; jede Operation wartet darauf). Zustellung und „Verwerfen“ löschen beide Kopien; scheitert nur das Löschen der Datei, schickt ein späteres `restore` erneut, der Server dedupliziert über `clientId`. `CaptureView`: URL/Token vor dem Speichern prüfen, Tab nur bei zugestellt oder `stored`, „Ausstehend (n)“ mit drei Aktionen, Liste aktualisiert sich über `queue.subscribe`. „Als Notiz öffnen“ legt die Anhangsbytes unter ihren alten IDs wieder in den Stash (`restoreAttachments`).
- **Bekannte Grenzen Punkt 1:** Schlägt nur die IndexedDB fehl (Datei ok), bleibt die Notiz im Editor und erst nach Neustart wird sie in die Queue zurückgelesen; speichert man sie davor erneut, entsteht ein zweiter Eintrag (anderer `clientId`). Kaputte Dateien im Postausgang werden übersprungen, nicht gelöscht und nicht angezeigt. Der Grund für „Offline gepuffert“ unterscheidet nicht zwischen offline, 401, 429 und 5xx. Die Datei ist Klartext (Notiztext und Base64-Anhänge, bis 100 MB pro Anhang).
- **Punkte 2/3:** `Hotkeys` ist jetzt `{dictation, toggle, search}` je `{key, enabled}`; alte gespeicherte Strings werden als aktiv gelesen. `applyNow` vergleicht Kombination und Flag, registriert nur aktive Kürzel und meldet bei Ablehnung wie bisher (Rollback auf den alten Zustand, auch „war aus“). Suche-Kürzel zeigt das Fenster und sendet `picky:open-search` (nicht `picky:focus-capture`, das würde das Suchpanel schließen). `Cmd/Ctrl+K` steht im bestehenden Capture-Phase-Listener von `App`; ist die Suche schon offen, fokussiert es nur das Feld. Der „aktiv“-Haken trägt den Namen „aktiv“ und hängt per `aria-describedby` am Kürzel-Namen (ein Label mit dem Namen selbst hätte `getByLabel` der bestehenden e2e-Tests doppelt getroffen). Gleiche Kombination wie ein aktives anderes Kürzel wird abgewiesen.
- **Punkt 4:** `--pn-text-width` auf `<main>`, `.editor .cm-content { max-width: var(--pn-text-width, none); margin-inline: auto }`. Eingabe wird erst übernommen, wenn sie in 400..2000 liegt (sonst kann man „800“ nicht tippen), beim Verlassen des Feldes begrenzt.
- **Punkt 5, Root Cause (Annahme, nur lesend belegt):** `float_over_fullscreen` lief einmal in `setup()` und **vor** `apply_dock`; `show()`/`unminimize()`/`set_focus()` aus JS und `show_main` setzten nichts neu. Fenster-`alwaysOnTop` und `visibleOnAllWorkspaces` standen schon in `tauri.conf.json` (daher ist „immer im Vordergrund“ keine neue Nebenwirkung). Neu: `prepare_overlay()` setzt bei jedem Zeigen (`show_main`, neues Command `show_main_window`, das die JS-Kürzel nutzen), nach Dock-Wechsel und beim Start `CanJoinAllSpaces | FullScreenAuxiliary` (löscht `MoveToActiveSpace`, `FullScreenPrimary`, `FullScreenNone`; die schließen sich aus) und `NSFloatingWindowLevel`, auf dem Main-Thread. Reine Bit-Logik in `overlay_behavior`, per `cargo test` geprüft (idempotent).
- **Punkt 5, nicht verifiziert und möglicherweise nicht ausreichend:** Schon der Eintrag „Desktop-Shell“ oben hielt fest, dass unter Policy Regular (Dock an) macOS ein normales NSWindow nicht über den Vollbild-Space einer **anderen** App legt; verlässlich ist Accessory (Dock aus) oder ein NSPanel mit `NonactivatingPanel`. Ein NSPanel (Klassenwechsel per `object_setClass` wie bei `tauri-nspanel`) wurde **nicht** gebaut: ohne natives Fenster nicht prüfbar, Absturzrisiko. Reihenfolge der Ausweichschritte, wenn die Handprobe scheitert: 1) `NSWindowCollectionBehaviorCanJoinAllApplications` (macOS 13+, schließt sich mit `FullScreenAuxiliary` aus) statt `FullScreenAuxiliary`; 2) Dock aus (Accessory); 3) `tauri-nspanel`.
- **Handprobe Vollbild (alles offen):** (a) Dock an, App auf Display A, auf Display B läuft eine App im Vollbild: Fenster per Leiste hinüberziehen, bleibt es sichtbar? (b) dasselbe mit Dock aus; (c) Fenster mit dem Ein-/Ausblenden-Kürzel verstecken und über das Kürzel auf dem Vollbild-Display zeigen, ohne dass macOS den Space wechselt; (d) dasselbe über Tray-Klick; (e) Dock-Schalter umlegen und (a) wiederholen (Policy-Wechsel darf die Einstellung nicht verlieren); (f) Cmd+Tab, Fokus und Eingabe im Editor nach dem Zeigen.
- **Punkt 6:** Lezer parst ein nacktes `-` als leeres `ListItem`, Atomic ersetzt es sofort durch das Bullet-Widget; bei `- ` verschluckt Atomic das Leerzeichen in ein Widget mit `margin-right`, das der Cursor nicht mitzählt (Cursor sitzt vor der Lücke, daher erschien sie erst mit dem nächsten Zeichen; Ursache aus Quelltext und CSS gelesen, nicht im echten Browser gemessen). Atomics Inline-Preview ist nicht konfigurierbar. `listMarkerTyping` (Plugin, `Prec.highest`) legt auf der Cursor-Zeile für dieselben Bereiche, die Atomic ersetzt, eigene `Decoration.replace` an: nackter Marker = Klartext-Widget plus Zeilenklasse `cm-pn-bare-marker` (CSS hebt Atomics Einrückung auf, auch für `1.`), `- `/`* `/`+ ` ohne Text = Bullet-Widget mit Lücke im Widget (`cm-pn-gap`, 0,9 + 0,3 em = Atomics 1,2 em, kein Sprung beim ersten Buchstaben). Nur die Cursor-Zeile; gespeicherte Listen und Marker an anderen Zeilen bleiben wie zuvor. Die Tests laufen in jsdom ohne CSS und echten Fokus: Klassen und Widgets sind belegt, die Optik nicht.
- **Nicht verifiziert (Punkt 6):** echtes Aussehen im WKWebView (Lücke, Cursor-Position, `!important` gegen Atomics Inline-Style); dass die Ersetzung gleicher Bereiche in CodeMirror Atomics Widget verdrängt, ist durch die Tests (kein `.cm-atomic-bullet` bei nacktem Marker) belegt, hängt aber an CM6-Interna.
- **Nicht verifiziert (nativ):** Ordner zeigen (`open <dir>` im Finder), Datei- und Ordnerrechte auf dem echten App-Data-Pfad (Tests laufen im Temp-Ordner), globale Kürzel (un)registrieren (Plugin im Test gemockt), Anzeige über Vollbild (oben).


### Follow-up Review-Befunde Punkt 1 (2026-10-19)

- **Blocker:** „Als Notiz öffnen“ löschte beide Kopien, obwohl `saveNotes()` (localStorage) fehlschlagen konnte (Quota) – Neustart = Notiz weg. Fix: `onOpenAsNote` liefert `boolean`; `App.openAsNote` schreibt zuerst `saveNotes(next)`, bei Fehler bleibt State und Queue/Postausgang unberührt, Status „Notiz nicht gespeichert – bleibt im Postausgang“. Test: `CaptureView.test.tsx` (rot vor dem Fix).
- **Major:** Ohne Outbox zählte `Promise.allSettled` das `undefined` als erfolgreichen Schreibvorgang; bei IndexedDB-Fehler löste `enqueue` mit `key: undefined` auf statt zu werfen. Fix: fehlender Outbox = abgelehnt; wirft, wenn kein vorhandener Speicher schrieb. Test: `queue.test.ts` (rot vor dem Fix).
- Gates: tsc 0, Unit 192 grün, e2e 77 grün. `cargo test` unverändert (kein Rust-Diff).

### Follow-up Review-Befunde R3/R4 (2026-10-19)

- **R3:** Schrieb nur der Postausgang (IndexedDB tot, `key` undefined), liefen danach `flush()`/`list()` gegen die tote DB und warfen unbehandelt; kein Status. Fix: `submit` meldet „Nur im Postausgang gesichert … Notiz bleibt im Editor offen“ direkt nach `enqueue` und gibt false zurück. Test: `CaptureView.test.tsx` (rot vor dem Fix).
- **R4:** Warf `configured()` (Keychain-Lesefehler), brach `submit` vor `enqueue` ab: Notiz nicht gespeichert, Fehler unbehandelt. Fix: `readiness()` fängt das ab (= nicht bereit); die Notiz geht in Queue und Postausgang, Status „Zugangsdaten nicht lesbar (<Meldung>) – Notiz liegt im Postausgang“. Gilt auch für „Erneut senden“. Test: `CaptureView.test.tsx` (rot vor dem Fix).
- Gates: gezielt `CaptureView.test.tsx` + `queue.test.ts` (52 grün), desktop `tsc` grün. Volle Gates (root `npm test`, e2e, `cargo test`) nicht erneut gelaufen.
