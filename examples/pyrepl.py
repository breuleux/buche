# Python interactive interpreter. Doesn't seem to work with Python 2,
# if you know why, let me know (probably some stdin buffering nonsense).

# buche --inspect -c 'python3 -u pyrepl.py'

import json
import sys

def buche(**args):
    print(json.dumps(args))

buche(command='open', path='/log', type='log', hasInput=True)
buche(command='log', path='/log', format='html',
      contents='<b>Enter Python code in the input box at the bottom!</b>')

for line in sys.stdin:
    data = json.loads(line)
    code = data['contents']
    if code.strip() == '':
        continue
    buche(command='log', contents=code, format='pre',
          gutter='echo', path=data['path'])
    try:
        try:
            buche(command='log', path='/log', format='pre',
                  contents=repr(eval(code)), gutter='result')
        except SyntaxError:
            exec(code)
    except Exception as exc:
        buche(command='log', path='/log', format='pre',
              contents=repr(exc), gutter='error')
