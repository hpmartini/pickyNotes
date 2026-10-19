import type { SearchHit } from "@pickynotes/shared";
import { useState } from "react";

export function SearchView({ search }: { search: (q: string) => Promise<SearchHit[]> }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState("");

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    try {
      setError("");
      setHits(await search(q));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section aria-label="Suche">
      <form onSubmit={run} role="search">
        <input aria-label="Suchbegriff" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Suchen…" />
        <button type="submit">Suchen</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {hits === null && !error && <p className="hint">Tippe einen Begriff oder eine Frage; gesucht wird im Volltext und nach Bedeutung.</p>}
      {hits?.length === 0 && <p className="hint">Keine Treffer.</p>}
      <ul className="hits">
        {hits?.map((h) => (
          <li key={h.id}>
            <strong>{h.title}</strong>
            <p>{h.snippet}</p>
            <small>{h.path}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
