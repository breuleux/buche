
# Welcome to buche

`buche` is a command-line application:

```
Usage: buche [options] [command]

Options:

  --tee [file]         File to log the command's stdout to.
  --inspect            Print stdout and stdin.
  --install plugin     Install a buche plugin.
  --uninstall plugin   Uninstall a buche plugin.
  --dev                Open developer console.
  --dump               Don't open a window, just print on stdout.
  -r [plugins]         Require the given plugins.
  -h, --help           Output usage information.
  -v, --version        Output the version number.

Note:
   The options must come before the command. Any options written
   after the command are the options for that command.
```

If you want to quickly try some examples:

```bash
git clone https://github.com/breuleux/buche
cd buche/examples
buche --inspect python demo.py
```

If you just want to see if this works, here's something quicker and simpler:

```bash
buche curl -s https://raw.githubusercontent.com/breuleux/buche/master/examples/log/demo.json
```
