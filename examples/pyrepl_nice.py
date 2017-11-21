#!/usr/bin/env buche --inspect python3 -u

# Python interactive interpreter. Requires the buche package and
# Python >=3.6

import json
import sys
try:
    from buche import buche, reader
except ImportError:
    print('This demo requires the buche package (pip install buche)')
    sys.exit(1)

_ = None
log = buche.open_log('log', hasInput=True)
log.markdown('**Enter Python code in the input box at the bottom!**')

code_globals = globals()

@reader.on_input
def repl_line(event, message):
    code = message.contents
    if code.strip() == '':
        return
    log.pre(code, gutter='echo')
    try:
        try:
            log.show(eval(code, code_globals), gutter='result')
        except SyntaxError:
            exec(code, code_globals)
    except Exception as exc:
        log.show(exc, gutter='error')

@reader.on_click
def repl_select(event, message):
    global _
    _ = message.obj
    log.pre('_ = <what you clicked>', gutter='echo')

reader.start()
