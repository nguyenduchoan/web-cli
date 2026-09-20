#!/usr/bin/env node
const fs = require("node:fs");

process.stdout.write(`[AGENT_STARTED:${process.pid}:${process.cwd()}]\r\n`);

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--marker" && args[i + 1]) {
    process.stdout.write(`[MARKER:${args[++i]}]\r\n`);
  } else if (args[i] === "--print-cwd") {
    process.stdout.write(`[CWD:${process.cwd()}]\r\n`);
  }
}

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}

process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  if (chunk === "\x03") {
    process.exit(0);
  }
  if (chunk.includes("\x1b[1;2D")) {
    const hex = Buffer.from("\x1b[1;2D", "utf8").toString("hex");
    process.stdout.write(`[KEY:SHIFT_LEFT:${hex}]\r\n`);
  }
  buffer += chunk;
  const lines = buffer.split(/\r?\n|\r/);
  buffer = lines.pop() || "";

  for (const line of lines) {
    handleCommand(line);
  }
});

process.stdin.on("end", () => {
  if (buffer.length > 0) {
    handleCommand(buffer);
  }
  process.exit(0);
});

function handleCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (trimmed === "PING") {
    process.stdout.write("PONG\r\n");
  } else if (trimmed === "PRINT_CWD") {
    process.stdout.write(`[CWD:${process.cwd()}]\r\n`);
  } else if (trimmed.startsWith("HEX:")) {
    const raw = trimmed.slice(4);
    const hex = Buffer.from(raw, "utf8").toString("hex");
    process.stdout.write(`[HEX:${hex}]\r\n`);
  } else if (trimmed === "ANSI:ALT_ON") {
    process.stdout.write("\x1b[?1049h[ALT_BUFFER_ACTIVE]\r\n");
  } else if (trimmed === "ANSI:ALT_OFF") {
    process.stdout.write("\x1b[?1049l[NORMAL_BUFFER_ACTIVE]\r\n");
  } else if (trimmed === "ANSI:COLOR") {
    process.stdout.write("\x1b[31mRED_TEXT\x1b[0m\r\n");
  } else if (trimmed.startsWith("OSC9:")) {
    const msg = trimmed.slice(5);
    process.stdout.write(`\x1b]9;${msg}\x07`);
  } else if (trimmed.startsWith("OSC9_ST:")) {
    const msg = trimmed.slice(8);
    process.stdout.write(`\x1b]9;${msg}\x1b\\`);
  } else if (trimmed === "IGNORE_SIGTERM") {
    process.on("SIGTERM", () => {
      process.stdout.write("[IGNORED_SIGTERM]\r\n");
    });
    process.stdout.write("[TRAPPED_SIGTERM]\r\n");
  } else if (trimmed.startsWith("EXIT:")) {
    const code = parseInt(trimmed.slice(5), 10) || 0;
    process.exit(code);
  } else {
    // Echo raw line
    process.stdout.write(`[ECHO:${trimmed}]\r\n`);
  }
}
