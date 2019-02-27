#!/usr/bin/env buche --inspect python3 -u

# A simple demo.

import sys
import os
import json
import time

def buche(**kwargs):
    print(json.dumps(kwargs))

def log(message, **kwargs):
    kwargs.setdefault('parent', '/')
    buche(content=message, **kwargs)

def html(message, **kwargs):
    log(message, format='html', **kwargs)

def text(message, **kwargs):
    log(message, format='text', **kwargs)

def markdown(message, **kwargs):
    log(message, format='markdown', **kwargs)

dirname = os.path.dirname(os.path.realpath(__file__))

html('<h2>Buche demo!</h2>')
html('Buche makes it easy to print: <ul address="list"></ul>')
html('<li><b>HTML</b></li>', parent="/list")
markdown('<li>**Markdown**</li>', parent="/list")

print("stdout goes to the /stdout address")
print("stderr goes to the /stderr address", file=sys.stderr)

text('Check out the tabs above.')

log('<tab-entry label="/README" address="/README"/>', parent="/buche")
buche(src=dirname + '/README.md', parent="/README")

log('<tab-entry label="/source" address="/source"/>', parent="/buche")
log('<p>This is the source code for demo.py</p>', parent="/source")
buche(src=__file__,
      format={'name': 'source', 'language': "python"},
      parent="/source")

time.sleep(1)

html('<li>...and more, eventually!</li>', parent="/list")
