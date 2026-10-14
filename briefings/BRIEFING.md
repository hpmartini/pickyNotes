THE JOB
Baue v1 der KI-Notiz-App „Capture & Memory“ gemäß Spec
(https://claude.ai/code/artifact/77cbb3d8-d2ff-4893-95c4-4357079f7a89),
beginnend mit Backend-Dienst und macOS-Desktop-App.

THE WHY
I'm working on mein persönliches Wissens- und Agentensystem (MAGOS/MCC)
for mich selbst (Single-User). I need: Gedanken jeder Art aus jedem Kontext
ohne Nachdenken erfassen und in jedem Kontext (App, Claude Code, MAGOS)
wiederfinden. Der Obsidian-Vault bleibt die einzige Wahrheit.

THE GUARDRAILS
- Only touch das neue Repo des Dienstes und der Clients. MAGOS/MCC nur über
  REST und Webhooks anbinden; dort höchstens einen generierten REST-Client
  ergänzen. Leave everything else alone.
- REST statt MCP, überall. Vor jeder Komponente erst nach Libraries oder
  forkbaren Open-Source-Projekten suchen (zuerst Spike: Blinko, Atomic Editor).
- Bestehende Vault-Notizen nur lesen und indexieren. Nichts löschen,
  verschieben oder umbenennen; die Inbox-Sortierung bleibt bei MAGOS.
- Keine Mails senden, keine Termine anlegen, keine Todoist-Tasks erzeugen
  ohne meine Bestätigung, auch nicht in Tests mit echten Konten.
  Keine Secrets im Repo.
- LLM über meine Claude-Subscription, hinter Provider-Abstraktion
  und mit Tageslimit.
- Make routine judgment calls yourself. Ask me only if the answer would
  change Architektur, Datenmodell oder Vault-Struktur, insbesondere bei den
  offenen Punkten 7a, 7b, 13b und 17b der Spec.

DONE MEANS
- Dienst läuft per Docker auf meinem Hostinger-VPS: REST-API mit
  veröffentlichter OpenAPI-Spec, Postgres + pgvector, Job-Queue,
  Whisper, Kurator.
- Tauri-Desktop-App erfasst Text, Sprache, Screenshot und Datei (offline
  gepuffert, globaler Hotkey). Die Notiz landet als .md in der Vault-Inbox,
  wird kuratiert und ist in App und CLI per Hybrid-Suche auffindbar.
- CLI für Claude Code: note add / note search / note context --repo .
- @claude-Anweisungen werden nur aus eigener Eingabe ausgeführt, genau
  einmal, mit Status-Callout.
- Tests grün, README mit Setup und Betrieb.
- Keep the deliverable to Code + README, as short as suitable.
- When you finish, tell me where the result is and give me 3 short bullets.
