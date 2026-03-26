#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");
const { program } = require("commander");

const electron = require("electron");
const appDir = path.join(__dirname, "..");

program
  .option("--debug", "open DevTools on launch")
  .option("--replay <file>", "replay a JSONL instruction file")
  .option("--record <file>", "record shell instructions to a JSONL file");

program.parse();
const cli = program.opts();

const opts = {
  devtools: cli.debug ?? false,
  replay: cli.replay ?? null,
  record: cli.record ?? null,
};

const child = spawn(electron, [appDir], {
  stdio: "inherit",
  env: { ...process.env, BUCHE_OPTS: JSON.stringify(opts) },
});
child.on("exit", (code) => process.exit(code ?? 0));
