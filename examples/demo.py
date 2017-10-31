# A simple demo.

# buche --inspect python -u demo.py

import json

def buche(**args):
    print(json.dumps(args))

def log(message, **args):
    args.setdefault('path', '/log')
    buche(command='log', contents=message, **args)

def html(message, **args):
    log(message, format='html', **args)

def pre(message, **args):
    log(message, format='pre', **args)

def markdown(message, **args):
    log(message, format='markdown', **args)

html('<h2>Buche demo!</h2>')
html('Buche makes it easy to print <b>HTML</b>')
markdown('You can also print **Markdown**.')

markdown(open('../README.md').read(), path='/README')
pre(open(__file__).read(), path='/source')
html('''Logs can be printed to multiple tabs. For example,
     I have printed the README in the README tab, and the
     source code for demo.py in the source tab.''')

markdown("""
## Run more examples!

* `buche --inspect -c 'python -u plot.py'` demonstrates live plotting.
* `buche --inspect -c 'python -u tabs.py'` shows how to arrange tabs.
* `buche --inspect -c 'python -u pyrepl.py'` implements a simple interactive
  interpreter for Python.
""")
