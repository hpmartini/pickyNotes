# Briefing: pickyNotes v1 und Sortierdienst

## THE JOB
Baue v1 von pickyNotes (macOS-Desktop-App + Backend) und dem **Sortierdienst als eigenem Repo**
(`hpmartini/sortierdienst`), gemäß Spec
(https://claude.ai/code/artifact/77cbb3d8-d2ff-4893-95c4-4357079f7a89).
Reihenfolge: Spikes, Sortierdienst (inkl. Herauslösung aus MAGOS), Backend, macOS-Desktop-App.

Repos:
- `hpmartini/pickyNotes` (angelegt, privat): Backend, Clients, CLI.
- `hpmartini/sortierdienst` (neu, privat): eigenständiger Prozess, eigene Tests, eigenes Deployment.

## THE GUARDRAILS
- Anfassen: nur die Repos pickyNotes und Sortierdienst. MAGOS/MCC nur über REST und Webhooks anbinden.
  Änderungen in MAGOS nur: (a) Pfad wiki/ → wiki_labs/, (b) generierter REST-Client,
  (c) **Entfernen der Sortierlogik nach erfolgter Übernahme** (siehe Herauslösung).
- WhisperStorm nur um eine REST-API erweitern.
- Der Sortierdienst ist der einzige Prozess, der aus raw/ verschiebt. MAGOS und pickyNotes liefern nur in raw/.
- Termine und Todoist-Tasks per Smart-Eingabe ohne LLM (chrono-node, Todoist Quick Add); LLM nur als Fallback.
  Mail-Entwürfe nur per @claude.
- Nichts Unumkehrbares ohne Freigabe; Löschen nie automatisch.
- Übrige Guardrails, THE WHY und DONE MEANS unverändert aus der Spec.

## HERAUSLÖSUNG DES SORTIERDIENSTS AUS MAGOS
Ausgangslage: Die Sortierlogik lebt heute in MAGOS (`scripts/einsortieren.mjs`, Regeln
`scripts/lib/ablage-regeln.mjs`, `scripts/transkripte-umsortieren.mjs`; Tests `tests/ablage-regeln.test.mjs`,
`tests/ablage-kern.test.mjs`, `tests/transkripte-umsortieren.test.mjs`; Verweise in `package.json`,
`deploy/install-macos-services.sh`, `config/verifikation.json`, `CLAUDE.md`, `frontend/.../Approvals.tsx`).
Die Kandidatenliste ist ein Startpunkt, kein Abschluss: Abgrenzung in Schritt 1 ist verbindlich.
Ablauf:
1. Im MAGOS-Repo exakt abgrenzen: Code, Tests, Konfiguration, Aufrufstellen (Cron/Routinen, Docs).
2. In `sortierdienst` übernehmen (Historie soweit praktikabel, z. B. `git filter-repo`), Tests laufen eigenständig,
   kein Import aus MAGOS.
3. Steuerung/Status per REST; Regeln als Konfiguration im Sortierdienst-Repo.
4. MAGOS erst danach umstellen: Aufrufstellen entfernen, MAGOS liefert nur noch nach raw/, bestehende MAGOS-Tests grün.
5. Verweise auf den alten Pfad in MAGOS: 0 Treffer, außer bewusst dokumentierten.
Kein Push nach MAGOS ohne Freigabe.

## THE WHY / DONE MEANS
Unverändert aus der Spec. Zusätzlich: Sortierdienst baut und testet ohne MAGOS-Code; MAGOS enthält keine Sortierlogik mehr.
