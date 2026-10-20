import { useEffect, useId, useRef, type ReactNode } from "react";

/** Keeps Tab inside the dialog: wraps from the last control to the first and back. */
function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "Tab") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button, input, [tabindex]")].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0);
  const edge = items[e.shiftKey ? 0 : items.length - 1];
  if (document.activeElement === edge || document.activeElement === e.currentTarget) {
    e.preventDefault();
    items[e.shiftKey ? items.length - 1 : 0]?.focus();
  }
}

/** Shared modal shell (Einstellungen, Ausstehend): backdrop, focus in and back to the opener, Esc and backdrop click close, Tab trapped. */
export function Dialog({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // once: onClose changes identity on every App render and must not steal focus again
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => opener?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog" onKeyDown={trapTab}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button onClick={onClose} aria-label={closeLabel}>×</button>
        </header>
        {children}
      </div>
    </div>
  );
}
