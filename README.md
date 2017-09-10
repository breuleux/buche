
# Buche

Buche is a powerful and flexible log viewer. It supports logging rich data into multiple tabs, as well as live plotting. To use it, you only have to print JSON commands on stdout, and (optionally) read back JSON commands emitted by buche on stdin.

## Install

```bash
npm install buche -g
```

## Use

Buche takes commands from stdout and (when applicable) outputs commands on stdin. This means you can simply pipe your application to buche: `<command> | buche` (if you have no need for stdin) or you can have buche run the command for you: `buche -c <command>`.

The `--inspect` flag makes buche print out all the commands that are exchanged between it and your program, in the following format: `-> <command_to_buche>` and `<- <command_from_buche>`.

## Examples

```bash
git clone https://github.com/breuleux/buche
cd buche/examples
buche --inspect -c 'python -u demo.py'
```

Each example in the `examples/` directory starts with a comment. That comment explains what the example is for and gives the shell command you should run to execute the example (notice for example that the `-u` flag should be used when running a Python script in order to force Python to flush the output buffer on each print.)

To reproduce an example or translate it in a different language, all you need to do is print out the same thing, and react the same way to any commands that come in on stdin.

Feel free to contribute more examples, especially in programming languages that are not yet featured, and ideally without dependencies.

## Stability

There is no stable release of Buche at the moment and the interface and commands may still change. Some capabilities may be removed in order to enhance security, such as the ability to inject scripts with full permissions in the output stream. Suggestions are welcome.
