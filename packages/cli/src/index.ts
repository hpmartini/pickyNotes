#!/usr/bin/env -S npx tsx
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { run } from "./cli.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv).catch((e) => {
    if (e instanceof CommanderError) process.exit(e.exitCode); // --help / usage errors already printed
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
