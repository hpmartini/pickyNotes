/**
 * Vault-Eingang (MAGOS#569): notes go to `POST <MAGOS>/api/vault/eingang` with a per-device Bearer token.
 * Text/Markdown as JSON, attachments (audio, images) as raw bodies. `ref` = note id, so MAGOS can show which note went where.
 * The token lives in the OS keychain and is added by the transport (Rust `vault_post`); nothing in here ever sees it.
 */
import { vaultFile } from "./export";

export interface VaultConfig {
  /** MAGOS base URL, e.g. http://100.x.y.z:8787 */
  url: string;
  /** Device name in the vault log (1-60 chars: letters, digits, space, . _ @ -). */
  geraet: string;
  /** Send a voice note on its own once it is transcribed. */
  auto: boolean;
}

export const VAULT_CONFIG_KEY = "picky.vault";
export const VAULT_STATE_KEY = "picky.vaultState";
const APP = "pickynotes";
const GERAET_RE = /^[\p{L}\p{N} ._@-]{1,60}$/u;

export const validGeraet = (g: string): boolean => GERAET_RE.test(g);

export function loadVaultConfig(): VaultConfig {
  try {
    const p = JSON.parse(localStorage.getItem(VAULT_CONFIG_KEY) ?? "null") as Partial<VaultConfig> | null;
    return { url: typeof p?.url === "string" ? p.url : "", geraet: typeof p?.geraet === "string" ? p.geraet : "mac", auto: p?.auto === true };
  } catch {
    return { url: "", geraet: "mac", auto: false };
  }
}

export function saveVaultConfig(c: VaultConfig): void {
  try {
    localStorage.setItem(VAULT_CONFIG_KEY, JSON.stringify({ ...c, url: c.url.trim().replace(/\/+$/, ""), geraet: c.geraet.trim() }));
  } catch {
    /* storage unavailable: applies for this session only */
  }
}

/** Transport: POST with the keychain token. HTTP error statuses are a normal reply; only a failed connection rejects. */
export type VaultPost = (url: string, contentType: string, body: Uint8Array) => Promise<{ status: number; body: string }>;

export interface VaultAttachment {
  id: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface VaultDeps {
  post: VaultPost;
  hasToken: () => Promise<boolean>;
  /** Bytes of a local attachment, undefined once they are gone. */
  attachment: (id: string) => Promise<VaultAttachment | undefined>;
  now?: () => Date;
}

/** Per note (key = note id) or per attachment (key = `<note id>#<attachment id>`): what was sent, or what is still to send. */
export interface VaultEntry {
  sha: string;
  status: "sent" | "queued" | "error";
  /** ms since epoch of the last attempt. */
  at: number;
  /** Delivery receipt of MAGOS. */
  eingangId?: string | number;
  pfad?: string;
  error?: string;
  /** Payload of a queued text, so it is sent exactly as it was. */
  name?: string;
  text?: string;
}

type State = Record<string, VaultEntry>;

export function loadVaultState(): State {
  try {
    const p = JSON.parse(localStorage.getItem(VAULT_STATE_KEY) ?? "null") as State | null;
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
export const subscribeVault = (l: () => void): (() => void) => (listeners.add(l), () => void listeners.delete(l));

function patchState(key: string, entry: VaultEntry): void {
  const s = loadVaultState();
  s[key] = entry;
  try {
    localStorage.setItem(VAULT_STATE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the entry is lost on restart */
  }
  listeners.forEach((l) => l());
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type VaultOutcome = "sent" | "duplicate" | "queued" | "error";
export interface VaultResult {
  outcome: VaultOutcome;
  message: string;
}

const inFlight = new Set<string>();

interface Reply {
  outcome: Exclude<VaultOutcome, "duplicate">;
  message: string;
  entry: Partial<VaultEntry>;
}

/** Maps the HTTP answer of the inbox to what the app does next. 500 and friends: send again later; 401/403/413/400: the user must act. */
export function interpret(status: number, body: string): Reply {
  let json: { id?: string | number; pfad?: string; error?: string } = {};
  try {
    json = JSON.parse(body) ?? {};
  } catch {
    /* not JSON */
  }
  const detail = typeof json.error === "string" ? json.error : "";
  if (status === 201 || status === 200) {
    return { outcome: "sent", message: `In den Vault gesendet${json.pfad ? `: ${json.pfad}` : ""}`, entry: { status: "sent", eingangId: json.id, pfad: json.pfad, error: undefined } };
  }
  if (status === 401 || status === 403) return fail("Token ungültig – in den Einstellungen ein neues Token eintragen");
  if (status === 413) return fail("Zu groß für den Vault-Eingang (max. 25 MB)");
  if (status === 400) return fail(`Vault lehnt die Notiz ab${detail ? ` (${detail})` : ""}`);
  if (status >= 500) {
    const message = status === 503 ? "Vault-Eingang nicht bereit (503) – wird erneut versucht" : `Vault-Fehler ${status} – wird erneut versucht`;
    return { outcome: "queued", message, entry: { status: "queued", error: message } };
  }
  return fail(`Unerwartete Antwort des Vault (${status})`);
}

function fail(message: string): Reply {
  return { outcome: "error", message, entry: { status: "error", error: message } };
}

const netError = (e: unknown): Reply => {
  const message = `Vault nicht erreichbar (${e instanceof Error ? e.message : String(e)}) – wird erneut versucht`;
  return { outcome: "queued", message, entry: { status: "queued", error: message } };
};

function endpoint(cfg: VaultConfig, query?: Record<string, string>): string {
  const base = `${cfg.url.trim().replace(/\/+$/, "")}/api/vault/eingang`;
  return query ? `${base}?${new URLSearchParams(query)}` : base;
}

async function configError(cfg: VaultConfig, deps: VaultDeps): Promise<string | null> {
  if (!/^https?:\/\//.test(cfg.url.trim())) return "Vault nicht eingerichtet: URL fehlt (Einstellungen)";
  if (!validGeraet(cfg.geraet.trim())) return "Vault: Gerätename ungültig (1–60 Zeichen: Buchstaben, Ziffern, Leerzeichen, . _ @ -)";
  if (!(await deps.hasToken())) return "Vault nicht eingerichtet: Token fehlt (Einstellungen)";
  return null;
}

/** One HTTP attempt for a text; records the result under `key`. */
async function postText(cfg: VaultConfig, deps: VaultDeps, key: string, noteId: string, sha: string, name: string, text: string): Promise<VaultResult> {
  const body = new TextEncoder().encode(JSON.stringify({ text, name, geraet: cfg.geraet.trim(), app: APP, ref: noteId }));
  let r: Reply;
  try {
    const res = await deps.post(endpoint(cfg), "application/json", body);
    r = interpret(res.status, res.body);
  } catch (e) {
    r = netError(e);
  }
  // Only a queued text keeps its payload; a sent one is not kept.
  patchState(key, { sha, at: Date.now(), name, ...(r.outcome === "queued" ? { text } : {}), ...r.entry } as VaultEntry);
  return { outcome: r.outcome, message: r.message };
}

async function postFile(cfg: VaultConfig, deps: VaultDeps, key: string, noteId: string, sha: string, att: VaultAttachment): Promise<VaultResult> {
  const url = endpoint(cfg, { name: att.name, geraet: cfg.geraet.trim(), app: APP, ref: `${noteId}/${att.id}` });
  let r: Reply;
  try {
    const res = await deps.post(url, att.mime || "application/octet-stream", att.bytes);
    r = interpret(res.status, res.body);
  } catch (e) {
    r = netError(e);
  }
  patchState(key, { sha, at: Date.now(), ...r.entry } as VaultEntry);
  return { outcome: r.outcome, message: r.message };
}

const pendingIds = (text: string): string[] => [...new Set([...text.matchAll(/pending:([a-zA-Z0-9-]+)/g)].map((m) => m[1]!))];

/**
 * Sends a note: its text as JSON, then each referenced local attachment as a raw body.
 * The same note version (sha256) is not sent twice; one that failed or is queued is tried again. Result = the worst outcome of the parts.
 */
export async function sendNote(cfg: VaultConfig, deps: VaultDeps, noteId: string, text: string): Promise<VaultResult> {
  const err = await configError(cfg, deps);
  if (err) return { outcome: "error", message: err };
  const state = loadVaultState();
  const results: VaultResult[] = [];

  const textKey = noteId;
  const sha = await sha256Hex(text);
  const prev = state[textKey];
  if (prev?.sha === sha && prev.status === "sent") results.push({ outcome: "duplicate", message: "Schon im Vault (unveränderte Notiz)" });
  else if (!inFlight.has(textKey)) {
    inFlight.add(textKey);
    try {
      const { name, markdown } = vaultFile(text, (deps.now ?? (() => new Date()))());
      results.push(await postText(cfg, deps, textKey, noteId, sha, prev?.sha === sha && prev.name ? prev.name : name, markdown));
    } finally {
      inFlight.delete(textKey);
    }
  }

  for (const id of pendingIds(text)) {
    const key = `${noteId}#${id}`;
    const att = await deps.attachment(id);
    if (!att) continue; // gone (or the link is not an attachment of this device)
    const asha = await sha256Hex(att.bytes);
    const p = loadVaultState()[key];
    if (p?.sha === asha && p.status === "sent") {
      results.push({ outcome: "duplicate", message: "Schon im Vault (Anhang)" });
      continue;
    }
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    try {
      results.push(await postFile(cfg, deps, key, noteId, asha, att));
    } finally {
      inFlight.delete(key);
    }
  }

  const order: VaultOutcome[] = ["error", "queued", "sent", "duplicate"];
  return results.sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome))[0] ?? { outcome: "duplicate", message: "Nichts zu senden" };
}

/** Tries every queued entry again (start, timer, manual). Returns how many were delivered. A token or size error stops being "queued" and waits for the user. */
export async function retryQueued(cfg: VaultConfig, deps: VaultDeps): Promise<number> {
  if (await configError(cfg, deps)) return 0;
  let sent = 0;
  for (const [key, e] of Object.entries(loadVaultState())) {
    if (e.status !== "queued" || inFlight.has(key)) continue;
    inFlight.add(key);
    try {
      const [noteId, attId] = key.split("#") as [string, string | undefined];
      let r: VaultResult | undefined;
      if (attId === undefined) {
        if (e.text !== undefined && e.name) r = await postText(cfg, deps, key, noteId, e.sha, e.name, e.text);
      } else {
        const att = await deps.attachment(attId);
        if (att) r = await postFile(cfg, deps, key, noteId, e.sha, att);
        else patchState(key, { sha: e.sha, status: "error", at: Date.now(), error: "Anhang nicht mehr lokal vorhanden" });
      }
      if (r?.outcome === "sent") sent++;
    } finally {
      inFlight.delete(key);
    }
  }
  return sent;
}

/** One line per note for the status display, or null when nothing was ever sent for it. */
export function vaultStatusLine(noteId: string, state: State = loadVaultState()): string | null {
  const parts = Object.entries(state).filter(([k]) => k === noteId || k.startsWith(`${noteId}#`));
  if (!parts.length) return null;
  const bad = parts.find(([, e]) => e.status === "error");
  if (bad) return `Vault: Fehler – ${bad[1].error}`;
  const queued = parts.filter(([, e]) => e.status === "queued").length;
  if (queued) return `Vault: ${queued} in Warteschlange${parts.find(([, e]) => e.status === "queued")?.[1].error ? ` (${parts.find(([, e]) => e.status === "queued")![1].error})` : ""}`;
  const t = state[noteId];
  return `Vault: gesendet${t?.pfad ? ` → ${t.pfad}` : ""}${t?.eingangId !== undefined ? ` (Eingang ${t.eingangId})` : ""}`;
}

/** What the capture view needs from the vault connection (Tauri only). */
export interface VaultSync {
  send: (noteId: string, text: string) => Promise<VaultResult>;
  /** Send voice notes on their own once transcribed. */
  auto: () => boolean;
  status: (noteId: string) => string | null;
}
