import type { CaptureInput, ContextQuery, SearchHit } from "./schemas.js";

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Thin REST client shared by CLI and desktop app. */
export function createClient({ baseUrl, token, fetch: f = globalThis.fetch }: ClientOptions) {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await f(baseUrl.replace(/\/$/, "") + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
    });
    if (!res.ok) throw new ApiError(res.status, `${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
  const qs = (o: Record<string, string | undefined>) =>
    new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1])).toString();

  return {
    capture: (input: CaptureInput) =>
      call<{ id: string }>("/captures", { method: "POST", body: JSON.stringify(input) }),
    search: (q: string, limit = 10) =>
      call<{ hits: SearchHit[] }>(`/search?${qs({ q, limit: String(limit) })}`),
    context: (c: ContextQuery) => call<{ hits: SearchHit[] }>(`/context?${qs(c)}`),
  };
}
export type PickyClient = ReturnType<typeof createClient>;
