#!/usr/bin/env buche -v python3 -u

# Python interactive interpreter. Requires the buche package and
# Python >=3.6

try:
    from buche import buche, reader, Repl
except ImportError:
    print('This demo requires the Python buche package (pip install buche)',
          file=sys.stderr)
    sys.exit(1)

class Color:
    def __init__(self, r, g, b):
        self.r = r
        self.g = g
        self.b = b

    def __hrepr__(self, H, hrepr):
        sz = hrepr.config.swatch_size or 20
        return H.div(
            style=f'display:inline-block;width:{sz}px;height:{sz}px;margin:2px;'
                  f'background-color:rgb({self.r},{self.g},{self.b});'
        )

repl = Repl(buche, reader, code_globals=globals())
repl.start()
repl.log.html("""
    <p><b>Enter Python expressions in the input box at the bottom.</b></p>

    <p>You can click on any part of the output to put it in a temporary
    variable.</p>

    <p>Something to get you started:</p>
""")
repl.run('[Color(0, 0, i * 16) for i in range(16)]')
