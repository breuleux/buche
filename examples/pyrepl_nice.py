# Python interactive interpreter. Requires the buche package and
# Python >=3.6

# buche --inspect -c 'python3 -u pyrepl_nice.py'

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

@reader.on_input
def repl_line(event, message):
    code = message.contents
    if code.strip() == '':
        return
    log.pre(code, gutter='echo')
    try:
        try:
            log.show(eval(code), gutter='result')
        except SyntaxError:
            exec(code)
    except Exception as exc:
        log.show(exc, gutter='error')

@reader.on_click
def repl_select(event, message):
    global _
    _ = message.obj
    log.pre('_ = <what you clicked>', gutter='echo')

reader.start()
