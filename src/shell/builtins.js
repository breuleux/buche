const os = require("os");

const BUILTINS = {
  async *cd(args, _cell_id) {
    yield { type: "cd", path: args[0] ?? os.homedir() };
  },
  async *set(args, _cell_id) {
    for (const arg of args) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        yield {
          type: "set",
          name: arg.slice(0, eq),
          value: arg.slice(eq + 1),
          export: false,
        };
      }
    }
  },
  async *export(args, _cell_id) {
    for (const arg of args) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        yield {
          type: "set",
          name: arg.slice(0, eq),
          value: arg.slice(eq + 1),
          export: true,
        };
      }
    }
  },
  async *nuke(_args, _cell_id) {
    yield { type: "nuke" };
  },
  async *control(args, _cell_id) {
    const [subcommand, name, ...rest] = args;
    if (subcommand === "set") {
      let restartMs = null;
      let cmdArgs = rest;
      if (rest[0]?.startsWith("-t")) {
        restartMs = parseInt(rest[0].slice(2), 10);
        cmdArgs = rest.slice(1);
      }
      const [cmd, ...procArgs] = cmdArgs;
      yield { type: "control_set", name, cmd, args: procArgs, restartMs };
    } else if (subcommand === "enable") {
      yield { type: "control_enable", name };
    } else if (subcommand === "disable") {
      yield { type: "control_disable", name };
    }
  },
};

module.exports = { BUILTINS };
