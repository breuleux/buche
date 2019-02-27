#!/usr/bin/env buche -v python

from math import *
import json, os, sys

def buche(**cfg):
    print(json.dumps(cfg))

here = os.path.dirname(os.path.realpath(__file__))
expr = ' '.join(sys.argv[1:]) or 'sin(x)'

buche(command='plugin', name='plotly')

buche(
    parent='/',
    content="""
    <buche-data address="data"></buche-data>
    <plotly-element address="plot"></plotly-element>
    """
)

buche(
    parent='/plot',
    command='configure',
    plots={
        expr: {
            'dataSource': '/data',
            'x': {'field': 'x'},
            'y': {'field': 'y'},
        }
    }
)

for i in range(100):
    x = i / 10.0
    buche(
        parent='/data',
        command='data',
        data={
            'x': x,
            'y': eval(expr)
        }
    )
