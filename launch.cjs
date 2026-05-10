#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const http = require("http");

const PORT = 3777;
const POLL_INTERVAL = 500;
const POLL_TIMEOUT = 30_000;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http.get(`http://localhost:${PORT}/api/stats`, (res) => {
        res.resume();
        resolve();
      }).on("error", () => {
        if (Date.now() - start > POLL_TIMEOUT) {
          reject(new Error("Server did not start within 30s"));
        } else {
          setTimeout(check, POLL_INTERVAL);
        }
      });
    };
    check();
  });
}

async function main() {
  console.log("[launch] Starting Synaptic server...");

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const server = spawn(npx, ["tsx", "watch", "src/index.ts"], {
    stdio: "inherit",
  });

  server.on("error", (err) => {
    console.error("[launch] Server failed to start:", err.message);
    process.exit(1);
  });

  try {
    await waitForServer();
  } catch (err) {
    console.error("[launch]", err.message);
    server.kill();
    process.exit(1);
  }

  console.log("[launch] Server ready — opening Electron HUD...");

  // Tell Electron the server is already managed by this launcher
  const electron = spawn(npx, ["electron", "electron/main.cjs"], {
    stdio: "inherit",
    env: { ...process.env, SYNAPTIC_EXTERNAL_SERVER: "1" },
  });

  electron.on("error", (err) => {
    console.error("[launch] Electron failed to start:", err.message);
    server.kill();
    process.exit(1);
  });

  electron.on("exit", (code) => {
    console.log("[launch] Electron closed — shutting down server...");
    server.kill();
    process.exit(code ?? 0);
  });

  const cleanup = () => {
    electron.kill();
    server.kill();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main();
