#!/usr/bin/env node
const readline = require("node:readline");
const net = require("node:net");
const { program } = require("commander");
const { Shell } = require("../src/shell/runner");

program
  .option("-c <command>", "run a command and exit")
  .allowUnknownOption(false)
  .parse();

const cli = program.opts();

async function main() {
  const shell = new Shell();

  const controlFd = process.env.BUCHE_CONTROL_FD
    ? parseInt(process.env.BUCHE_CONTROL_FD, 10)
    : null;

  let inputStream;
  let writeLine;

  if (controlFd != null) {
    const sock = new net.Socket({ fd: controlFd });
    const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
    inputStream = (async function* () {
      for await (const line of rl) {
        try {
          yield JSON.parse(line);
        } catch {}
      }
    })();
    writeLine = (line) => sock.write(`${line}\n`);
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    inputStream = (async function* () {
      for await (const line of rl) {
        try {
          yield JSON.parse(line);
        } catch {}
      }
    })();
    writeLine = (line) => process.stdout.write(`${line}\n`);
  }

  if (cli.c) {
    async function* singleCommand() {
      yield { type: "prompt_submit", text: cli.c };
    }
    for await (const event of shell.run(singleCommand())) {
      writeLine(JSON.stringify(event));
    }
    process.exit(0);
    return;
  }

  for await (const event of shell.run(inputStream)) {
    writeLine(JSON.stringify(event));
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
