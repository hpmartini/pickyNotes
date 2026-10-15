#!/usr/bin/env node
// Sends one {"cmd":"status"} line to the WhisperStorm control socket and exits 0 only if the reply has ok:true.
// If the socket is missing, tries to launch the built WhisperStorm.app and waits up to 15s for the socket to appear.
// Print format mirrors the gate in the task brief: a single JSON line on stdout, exits 1 on any failure.

import { connect, createConnection } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// WHISPERSTORM_SOCKET points the script at another socket (tests use a fake server there) and disables the auto-launch.
const OVERRIDE = process.env.WHISPERSTORM_SOCKET;
const SOCKET = OVERRIDE ?? `${homedir()}/Library/Application Support/WhisperStorm/control.sock`;
const APP = `${homedir()}/PROJECTS/WhisperStorm/build/Build/Products/Release/WhisperStorm.app`;

const send = () =>
  new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET);
    let buf = "";
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout waiting for reply"));
    }, 5000);
    sock.once("connect", () => sock.write('{"cmd":"status"}\n'));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) {
        clearTimeout(t);
        sock.end();
      }
    });
    sock.on("end", () => resolve(buf.trim()));
    sock.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

const waitForSocket = (ms) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (existsSync(SOCKET)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`socket did not appear within ${ms}ms`));
      setTimeout(tick, 250);
    };
    tick();
  });

const launch = () => {
  if (!existsSync(APP)) {
    console.error(`WhisperStorm.app not found at ${APP}; build it first (xcodegen generate && xcodebuild …).`);
    process.exit(1);
  }
  spawn("open", [APP], { detached: true, stdio: "ignore" }).unref();
};

(async () => {
  try {
    if (!existsSync(SOCKET)) {
      if (OVERRIDE) throw new Error(`no WhisperStorm socket at ${SOCKET}`);
      launch();
      await waitForSocket(15000);
    }
    const reply = await send();
    const parsed = JSON.parse(reply);
    if (!parsed.ok) {
      console.error("reply not ok:", reply);
      process.exit(1);
    }
    console.log(reply);
    process.exit(0);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
})();