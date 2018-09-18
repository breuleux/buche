#!/usr/bin/env buche --inspect python3 -u

# Python interactive interpreter. Requires the buche package and
# Python >=3.6

import json
import sys
try:
    from buche import buche, reader
except ImportError:
    print('This demo requires the buche package (pip install buche)',
          file=sys.stderr)
    sys.exit(1)

_ = None

buche.html.style('''
.repl-container { height: 100%; width: 100%;
                  display: flex; flex-direction: column; }
log-entry.echo, buche-input > input { font-family: monospace; }
buche-input > input { font-family: monospace; font-size: 16px; }
''')

container = buche.open.div['repl-container']()
repl = container.open.bucheLog()
inp = container.open.bucheInput()

repl.html.b('Enter Python code in the input box at the bottom!')
repl.html.b('Try clicking on results :)')
inp.command_focus()

code_globals = globals()

@reader.on_submit
def repl_line(event, message):
    code = message.value
    if code.strip() == '':
        return
    repl.html.logEntry['echo'](code)
    inp.command_set()
    try:
        try:
            res = eval(code, code_globals)
            if res is not None:
                repl.show.logEntry['result'](res, interactive=True)
        except SyntaxError:
            exec(code, code_globals)
    except Exception as exc:
        repl.show.logEntry['error'](exc)

@reader.on_click
def repl_select(event, message):
    global _
    if hasattr(message, 'obj'):
        _ = message.obj
        repl.html.logEntry['echo'](f'_ = {message.obj}')
    inp.command_focus()

reader.start()
