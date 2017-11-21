#!/usr/bin/env buche --inspect python3

# Showcase various tab layouts.

import json

def buche(**args):
    print(json.dumps(args))

buche(command='open', path='/', type='tabs', anchor='top')
buche(command='open', path='/fruits', type='tabs', anchor='left')
buche(command='open', path='/vegetables', type='tabs', anchor='right')

fruits = {
    'apple': 'red',
    'banana': 'yellow',
    'cherry': 'red',
    'durian': 'yellow'
}

for fruit, color in fruits.items():
    for i in range(1, 4):
        buche(command='log', path='/fruits/' + fruit, format='html',
              contents='<div style="background:' + color + '">' \
                + str(i) + ' ' + fruit + '</div>')

vegetables = {
    'zucchini': 'It is a vegetable.',
    'yam': 'It is a vegetable.',
    'xylophone': 'That is not a vegetable!',
    'wombat': 'They eat vegetables.'
}

for veg, text in vegetables.items():
    buche(command='log', path='/vegetables/' + veg, format='markdown',
          contents='**' + text + '**')
