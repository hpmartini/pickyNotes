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

**Gefundene weitere Abweichungen von Obsidian/Notion — dokumentiert, nicht gefixt (Scope-Disziplin):**
- Geordnete Liste: `1. eins` ↵ `zwei` → Atomic macht daraus `- zwei` (Bullet). Obsidian/Notion würde `2. zwei` weiterführen. Ursache: `inline-preview.js:891 insertTightListItem` setzt bei nicht-Bullet-Listen einen Bullet-Marker.
- `**fett**` Zeichen für Zeichen → `****` durch `extendEmphasisPair` (Auto-Close der `**`). Obsidian/Notion schließt `**` nicht auto.
- `> zitat` ↵ ↵ — die zweite ↵ verlässt das Zitat nicht; ` ``` ` tippen erzeugt `> ``` `. Obsidian verlässt das Zitat bei ↵ auf einer leeren Zitat-Zeile zuverlässig.
- `- aufgabe` nach Listenende wird als Fortsetzung der vorherigen Liste interpretiert (Bullet statt neue Liste).

Diese Punkte würden echte Code-Änderungen im Editor-Aufruf oder am `extendEmphasisPair`/`insertTightListItem` brauchen; das wäre ein eigenes Briefing. Der Screenshot zeigt sie nebeneinander — die Setext-Regression ist behoben, der Rest ist sichtbar, aber außerhalb des Auftrags.

**Stand:** typecheck ok, desktop 24 Unit-Tests (vorher 17, +7), e2e 5/5 (vorher 4/4, +1).

**Explorativer e2e-Test verschärft.** `step()` tippt jetzt Zeichen für Zeichen mit `inspect()`+`assertSteady()` nach jedem Tastendruck (vorher nur einmal pro `step()`). `assertSteady` lässt `cm-atomic-h*` nur auf den drei ATX-Zeilen (Index 0..2) zu und prüft, dass jede Nicht-Heading-/Nicht-HR-/Nicht-Code-Zeile die Absatz-Schriftgröße hält (Absatz-Schriftgröße und -Familie werden lazy beim ersten Auftauchen der Zeile „Eine Zeile Text" gemerkt; Code-Zeilen werden über abweichende `font-family` übersprungen). Shift+Tab wird jetzt wirklich als `Shift+Tab` gedrückt (vorher ging `shiftKey` verloren und Tab rückte nur weiter ein); nachgeprüft per Draft in `localStorage` (vor/nach: letzte Zeile ohne führende Whitespace). Backspace auf leerem „"- " beendet die Liste: nachgeprüft per DOM-Probe (`•` aus der letzten Zeile weg). `expect.fail` ersetzt durch `expect(...).toBe(true)` mit Message. Gates erneut grün: typecheck ok, server 81 + 10 PG übersprungen, cli 5, shared 2, desktop 24, e2e 5/5. Keine Änderung an `apps/desktop/src`.
