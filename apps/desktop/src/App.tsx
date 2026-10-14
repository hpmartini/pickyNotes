import { createClient, type PickyClient } from "@pickynotes/shared";
import { useEffect, useMemo, useState } from "react";
import { CaptureView } from "./CaptureView";
import { CaptureQueue } from "./lib/queue";
import { registerHotkey, screenshot, token } from "./lib/tauri";
import { SearchView } from "./SearchView";

const URL_KEY = "picky.url";
type Tab = "capture" | "search" | "settings";

async function client(): Promise<PickyClient> {
  const baseUrl = localStorage.getItem(URL_KEY);
  const t = await token.get();
  if (!baseUrl || !t) throw new Error("Bitte zuerst Server-URL und Token in den Einstellungen setzen.");
  return createClient({ baseUrl, token: t });
}

export function App() {
  const [tab, setTab] = useState<Tab>("capture");
  const queue = useMemo(() => new CaptureQueue(), []);
  const send = async (i: Parameters<PickyClient["capture"]>[0]) => (await client()).capture(i);

  useEffect(() => {
    registerHotkey().catch(console.error);
    const flush = () => void queue.flush(send).catch(() => {});
    window.addEventListener("online", flush);
    const timer = setInterval(flush, 30_000);
    flush();
    return () => (window.removeEventListener("online", flush), clearInterval(timer));
  }, [queue]);

  return (
    <main>
      <nav aria-label="Ansicht">
        {(["capture", "search", "settings"] as const).map((t) => (
          <button key={t} aria-current={tab === t} onClick={() => setTab(t)}>
            {{ capture: "Erfassen", search: "Suche", settings: "Einstellungen" }[t]}
          </button>
        ))}
      </nav>
      {tab === "capture" && <CaptureView queue={queue} send={send} screenshot={screenshot} />}
      {tab === "search" && <SearchView search={async (q) => (await (await client()).search(q)).hits} />}
      {tab === "settings" && <Settings />}
    </main>
  );
}

function Settings() {
  const [url, setUrl] = useState(localStorage.getItem(URL_KEY) ?? "");
  const [tok, setTok] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <form
      aria-label="Einstellungen"
      onSubmit={async (e) => {
        e.preventDefault();
        localStorage.setItem(URL_KEY, url.trim());
        if (tok) await token.set(tok.trim());
        setTok("");
        setSaved(true);
      }}
    >
      <label>Server-URL <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://notes.example.net" /></label>
      <label>Geräte-Token <input type="password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="leer = unverändert" autoComplete="off" /></label>
      <button type="submit">Speichern</button>
      {saved && <p role="status">Gespeichert (Token im Schlüsselbund).</p>}
    </form>
  );
}
