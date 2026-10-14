import { describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";

describe("client", () => {
  it("sends bearer token and JSON body on capture", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 202 }));
    const c = createClient({ baseUrl: "http://h/", token: "t", fetch: f as never });
    expect(await c.capture({ kind: "text", source: "typed", text: "hi" })).toEqual({ id: "x" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://h/captures");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
  });
  it("throws on non-2xx and drops empty query params", async () => {
    const f = vi.fn(async () => new Response("no", { status: 401 }));
    const c = createClient({ baseUrl: "http://h", token: "t", fetch: f as never });
    await expect(c.context({ repo: "r" })).rejects.toThrow("401");
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("http://h/context?repo=r");
  });
});
