import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

// The spec only depends on route schemas, so no real dependencies are needed to generate it.
const app = createApp({ adminAllowlist: [], trustProxy: false, corsOrigins: [], rateLimitPerMin: 1, maxAttachmentBytes: 0 } as never);
const res = await app.request("/openapi.json");
if (!res.ok) throw new Error(`openapi.json -> ${res.status}`); // never overwrite the published spec with an error body
const spec = await res.text();
const out = fileURLToPath(new URL("../openapi.json", import.meta.url));
await writeFile(out, JSON.stringify(JSON.parse(spec), null, 2) + "\n");
console.log(`wrote ${out}`);
