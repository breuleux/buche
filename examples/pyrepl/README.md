
# Python REPL

The `<buche-input>` element can be used to read input from the user inside the Buche window. It is transmitted to the main process's `stdin` in JSON format when the user presses Enter.

This can be used to write, among other things, REPLs for various languages. Here we have one for Python.

## Run the example:

    buche --inspect python3 -u repl.py

The `-u` flag is important to use here, because otherwise Python will buffer `stdin` from Buche and hang (it knows that it is not reading from the terminal and therefore (wrongly) guesses that we are not in an interactive session).

Also, this doesn't work in Python 2. I don't know why. Don't use Python 2, it is old and rotten.
