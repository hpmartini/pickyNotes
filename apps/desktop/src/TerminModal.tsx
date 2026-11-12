import { useState } from "react";
import { Dialog } from "./Dialog";
import { terminDefaults, terminValid, type Termin } from "./lib/export";

/** Note to calendar event: the date is typed, not guessed from the text. */
export function TerminModal({ text, onClose, onCreate }: { text: string; onClose: () => void; onCreate: (t: Termin) => void }) {
  const [t, setT] = useState(() => terminDefaults(text, new Date()));
  return (
    <Dialog title="Termin aus Notiz" closeLabel="Termin schließen" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (terminValid(t)) onCreate(t);
        }}
      >
        <label>Titel<input value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} /></label>
        <label>Datum<input type="date" value={t.date} onChange={(e) => setT({ ...t, date: e.target.value })} /></label>
        <label>Beginn<input type="time" value={t.start} onChange={(e) => setT({ ...t, start: e.target.value })} /></label>
        <label>Dauer (Minuten)<input type="number" min={1} max={1440} value={Number.isNaN(t.minutes) ? "" : t.minutes} onChange={(e) => setT({ ...t, minutes: e.target.valueAsNumber })} /></label>
        <button type="submit" className="primary" disabled={!terminValid(t)}>Termin anlegen</button>
      </form>
    </Dialog>
  );
}
