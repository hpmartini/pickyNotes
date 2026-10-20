import { Dialog } from "./Dialog";
import type { QueuedCapture } from "./lib/queue";

const title = (i: QueuedCapture) => (i.input.text ?? i.input.filename ?? i.input.kind).slice(0, 60);

interface Props {
  pending: QueuedCapture[];
  rejected: QueuedCapture[];
  onClose: () => void;
  onOpenAsNote?: (item: QueuedCapture) => void;
  onRetry: (key: number) => void;
  onDiscard: (key: number) => void;
  onRevealOutbox?: () => void;
}

/** Captures that have not reached the server: waiting ones can be reopened as a note or resent, rejected ones resent or discarded. */
export function PendingModal({ pending, rejected, onClose, onOpenAsNote, onRetry, onDiscard, onRevealOutbox }: Props) {
  return (
    <Dialog title="Ausstehend" closeLabel="Ausstehend schließen" onClose={onClose}>
      {pending.length > 0 && (
        <section aria-label="Wartend">
          <h3>Wartet auf Versand ({pending.length})</h3>
          <ul className="queue">
            {pending.map((i) => (
              <li key={i.key}>
                <span className="item-title">{title(i)}</span>
                {onOpenAsNote && i.input.text !== undefined && <button onClick={() => onOpenAsNote(i)}>Als Notiz öffnen</button>}
                <button onClick={() => onRetry(i.key!)}>Erneut senden</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rejected.length > 0 && (
        <section aria-label="Abgelehnt">
          <h3>Abgelehnt ({rejected.length})</h3>
          <ul className="queue">
            {rejected.map((i) => (
              <li key={i.key}>
                <span className="item-title">{title(i)}<small className="reason">{i.rejected}</small></span>
                <button onClick={() => onRetry(i.key!)}>Erneut senden</button>
                <button onClick={() => onDiscard(i.key!)}>Verwerfen</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {onRevealOutbox && <button className="link" onClick={onRevealOutbox}>Ordner zeigen</button>}
    </Dialog>
  );
}
