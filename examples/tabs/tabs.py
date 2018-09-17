#!/usr/bin/env buche --inspect python3

# Showcase various tab layouts.

import json

def buche(**args):
    print(json.dumps(args))

buche(parent='/',
      tag='buche-tabs',
      attributes={'layout': 'top', 'address': 'root'})

buche(parent='/root',
      command='new',
      label='fruits',
      active=True,
      tag='buche-tabs',
      attributes={'layout': 'left',
                  'address': 'fruits',
                  'autofocus': True})

buche(parent='/root',
      command='new',
      label='vegetables',
      tag='buche-tabs',
      attributes={'layout': 'right',
                  'address': 'vegetables',
                  'autofocus': True})

fruits = {
    'apple': 'red',
    'banana': 'yellow',
    'cherry': 'red',
    'durian': 'yellow'
}

for fruit, color in fruits.items():
    buche(parent='/root/fruits',
          command='new',
          label=fruit,
          paneAddress=fruit)
    for i in range(1, 4):
        buche(parent='/root/fruits/' + fruit,
              content='<div style="background:{}">{} {}</div>'
                      .format(color, i, fruit))

vegetables = {
    'zucchini': 'It is a vegetable.',
    'yam': 'It is a vegetable.',
    'xylophone': 'That is not a vegetable!',
    'wombat': 'They eat vegetables.'
}

for veg, text in vegetables.items():
    buche(parent='/root/vegetables',
          command='new',
          label=veg,
          active=True,
          content='<b>' + text + '</b>')
