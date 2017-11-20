# Live plotting.

# buche --inspect python -u plot.py

import time
import math
import json

def buche(**args):
    print(json.dumps(args))

buche(command='require', path='/', pluginName='bokeh')
buche(command='open', path='/plot', type='bokeh', title='Trigonometry')

for i in range(0, 1000):
    v = i / 100.0
    s = math.sin(v)
    c = math.cos(v)
    buche(command='point', path='/plot/sin', x=v, y=s)
    buche(command='point', path='/plot/cos', x=v, y=c)
    buche(command='log', format='pre', path='/log',
          contents=('{:.2f}, {:.2f}'.format(s, c)))
    time.sleep(0.05)
