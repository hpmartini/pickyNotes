import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../../../../scripts/whisperstorm-status.mjs");
let dir = "";
let server: Server | undefined;

afterEach(async () => {
  server?.close();
  server = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

const run = (socket: string) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [SCRIPT], { env: { ...process.env, WHISPERSTORM_SOCKET: socket } }, (err, stdout, stderr) =>
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr }),
    );
  });

/** Fake WhisperStorm: answers each JSON line with `reply(request)`. */
async function fake(reply: (req: { cmd: string }) => unknown): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "ws-"));
  const sock = join(dir, "c.sock");
  server = createServer((c) => c.on("data", (d) => c.end(JSON.stringify(reply(JSON.parse(d.toString()))) + "\n")));
  await new Promise<void>((r) => server!.listen(sock, r));
  return sock;
}

describe("scripts/whisperstorm-status.mjs", () => {
  it("sends {cmd:status}, prints the reply and exits 0 on ok:true", async () => {
    const sock = await fake((req) => ({ ok: req.cmd === "status", phase: "idle", text: null }));
    const r = await run(sock);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, phase: "idle", text: null });
  });
  it("exits 1 and names the reply when ok is false", async () => {
    const r = await run(await fake(() => ({ ok: false, error: "busy" })));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("reply not ok");
  });
  it("exits 1 with a clear error when no socket exists (and never launches the app)", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-"));
    const r = await run(join(dir, "missing.sock"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no WhisperStorm socket");
  });
});
