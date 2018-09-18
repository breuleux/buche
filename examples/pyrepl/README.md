
# Python REPL

The `<buche-input>` element can be used to read input from the user inside the Buche window. It is transmitted to the main process's `stdin` in JSON format when the user presses Enter.

This can be used to write, among other things, REPLs for various languages. Here we have one for Python.

## Run the examples:

There are two examples in this directory. `repl.py` has no dependencies, whereas `nicer-repl.py` depends on the `buche` package for Python.

### No dependencies

    buche --inspect python3 -u repl.py

The `-u` flag is important to use here, because otherwise Python will buffer `stdin` from Buche and hang (it knows that it is not reading from the terminal and therefore (wrongly) guesses that we are not in an interactive session).

Also, this doesn't work in Python 2. I don't know why. Don't use Python 2, it is old and rotten.

### Buche dependency

The [buche](https://github.com/breuleux/pybuche) package for Python provides:

* A nicer interface.
* HTML pretty-printing for all objects.
* An event-based reader for events coming from Buche on stdin.

    pip install buche
    buche --inspect python3 -u nicer-repl.py

Notice that arrays and dictionaries are pretty-printed, and you can even click on an object to stash it in a variable!
