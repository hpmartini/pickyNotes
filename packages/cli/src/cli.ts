import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createClient, type PickyClient, type SearchHit } from "@pickynotes/shared";

export interface Env {
  client?: PickyClient;
  /** stdin text when piped, else undefined */
  readStdin?: () => Promise<string | undefined>;
  out?: (s: string) => void;
}

/** PICKY_URL / PICKY_TOKEN win over ~/.config/pickynotes/config.json ({"url","token"}). */
export function loadConfig(env = process.env, configPath = path.join(homedir(), ".config/pickynotes/config.json")) {
  let file: { url?: string; token?: string } = {};
  try {
    file = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    /* no config file */
  }
  const url = env.PICKY_URL ?? file.url;
  const token = env.PICKY_TOKEN ?? file.token;
  if (!url || !token) throw new Error("Set PICKY_URL and PICKY_TOKEN (or ~/.config/pickynotes/config.json with url + token).");
  return { url, token };
}

/** Repo name from the git remote (owner-less), falling back to the directory name. */
export function repoName(dir: string): string {
  const abs = path.resolve(dir);
  try {
    const remote = execFileSync("git", ["-C", abs, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const name = remote.replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "");
    if (name) return name;
  } catch {
    /* not a git repo / no remote */
  }
  return path.basename(abs);
}

export const formatHits = (hits: SearchHit[]) =>
  hits.length ? hits.map((h) => `${h.title}  [${h.id}]\n  ${h.snippet.replace(/\s+/g, " ").slice(0, 160)}\n  ${h.path}`).join("\n\n") : "No results.";

const stdinText = async () => {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

export function buildProgram(env: Env = {}) {
  const out = env.out ?? ((s: string) => console.log(s));
  const client = () => {
    if (env.client) return env.client;
    const c = loadConfig();
    return createClient({ baseUrl: c.url, token: c.token });
  };
  const program = new Command("note").description("pickyNotes CLI").exitOverride();

  program
    .command("add [text...]")
    .description("capture a note (text from arguments or stdin)")
    .action(async (words: string[]) => {
      const text = words.length ? words.join(" ") : await (env.readStdin ?? stdinText)();
      if (!text?.trim()) throw new Error("No text: pass it as arguments or pipe it via stdin.");
      const { id } = await client().capture({ kind: "text", source: "typed", text });
      out(`captured ${id}`);
    });

  program
    .command("search <query...>")
    .description("hybrid search")
    .option("--json", "raw JSON")
    .option("-n, --limit <n>", "max hits", "10")
    .action(async (q: string[], o: { json?: boolean; limit: string }) => {
      const { hits } = await client().search(q.join(" "), Number(o.limit));
      out(o.json ? JSON.stringify(hits, null, 2) : formatHits(hits));
    });

  program
    .command("context")
    .description("notes relevant to a repo / event / sender")
    .option("--repo <dir>", "repo directory (name from git remote or dirname)")
    .option("--event <e>")
    .option("--sender <s>")
    .option("--json", "raw JSON")
    .action(async (o: { repo?: string; event?: string; sender?: string; json?: boolean }) => {
      const { hits } = await client().context({ repo: o.repo ? repoName(o.repo) : undefined, event: o.event, sender: o.sender });
      out(o.json ? JSON.stringify(hits, null, 2) : formatHits(hits));
    });

  return program;
}

export const run = (argv: string[], env?: Env) => buildProgram(env).parseAsync(argv);
