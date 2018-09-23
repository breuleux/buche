
# Demo

This is just a simple demo for a few of Buche's features, but it is a sufficient sample for you to figure out how to do cool things.

## Run more examples!

Assuming you are in Buche's `examples` directory:

* Creating and arranging tabs:
        buche -v python tabs/tabs.py

* A simple interactive interpreter for Python:
        buche -v python3 -u pyrepl/repl.py
        buche -v python3 -u pyrepl/nicer-repl.py

The `-v` flag is optional, but it will dump on stdout all communications between the program and Buche.

If for some reason you can't run an example, e.g. you don't have the right Python version or interpreter, each example directory contains `.jsonl` files. These won't be interactive, but you can run them like this:

    buche cat tabs/tabs.jsonl

Yes, this means you can save a Buche session simply by redirecting the output to a file. If you want to use Buche and log to a file at the same time, use the `--tee` option:

    buche --tee tabs.jsonl python tabs/tabs.py
