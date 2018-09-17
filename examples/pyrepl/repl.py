#!/usr/bin/env buche --inspect python3 -u

# Python interactive interpreter. Doesn't seem to work with Python 2,
# if you know why, let me know (probably some stdin buffering nonsense).

import json
import sys

def buche(**args):
    print(json.dumps(args))

buche(command='resource',
      content='''
      <style>
          .code { font-family: monospace; }
      </style>
      ''')

buche(parent='/',
      content="""
      <div style="height:100%;width:100%;display:flex;flex-direction:column;">
        <buche-log address="repl"></buche-log>
        <buche-input address="input"></buche-input>
      </div>
      """)

buche(parent='/repl',
      content='<b>Enter Python code in the input box at the bottom!</b>')

buche(parent='/input',
      command='focus')

for line in sys.stdin:
    data = json.loads(line)
    code = data['value']
    if code.strip() == '':
        continue
    buche(parent='/input',
          command='set')
    buche(parent='/repl',
          tag='log-entry',
          attributes={'class': 'echo code'},
          format='text',
          content=code)
    try:
        try:
            result = eval(code)
            buche(parent='/repl',
                  tag='log-entry',
                  attributes={'class': 'result code'},
                  format='text',
                  content=repr(result))
        except SyntaxError:
            exec(code)
    except Exception as exc:
        buche(parent='/repl',
              tag='log-entry',
              attributes={'class': 'error code'},
              format='text',
              content=repr(exc))
