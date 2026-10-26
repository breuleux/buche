---
name: buche
description: Build GUI apps for the buche terminal — drive an interactive HTML view from your program over the fd-5 control channel (configure with kind "frame", send with html/exec/data/register/resolve/response commands), talk back from JavaScript with the in-iframe `buche` API, serve proc:// resources, and handle focus and sizing. Use when writing any program (Python, Node, anything) that renders an interactive UI in buche, with buchelib or over the raw JSON protocol.
---

# Programming buche GUI cells

buche runs your program in a **cell**. Besides its terminal output, a cell can
show an **interactive HTML GUI**: a sandboxed iframe whose content you inject
and script from your process, and whose JavaScript can call back into your
process. This skill documents the contract between the two — everything an app
needs, as seen from your process and from inside the iframe.

The Python library **buchelib** wraps all of this (see the `buchelib` skill);
read this document to understand what it does, or to write against the raw
protocol.

The machine-readable wire format lives next to this skill:

- `references/incoming.schema.json` — JSON Schema of every message **you send**
  (called "incoming" because it arrives at buche).
- `references/outgoing.schema.json` — JSON Schema of every message **you
  receive**.

Both reject unknown properties; JSDoc descriptions are inlined. They are
generated with buche, so they match the terminal you are talking to.

---

## 1. The control channel

buche starts your process with a **control channel**: the fd numbered by the
`BUCHE_CONTROL_FD` environment variable (normally **fd 5**). Messages are
newline-delimited JSON — one object per line, in both directions.

Every message you send carries:

- `from`: **your address**, an array of strings (e.g. `["myapp"]`);
- `to`: the terminal is `["$term"]`.

Everything buche sends you comes back with `from: ["$term"]` and `to` set to
your address.

The other descriptors:

| fd | env | direction | meaning |
| --- | --- | --- | --- |
| 0 | — | in | keyboard input, delivered while the cell holds the focus |
| 1, 2 | — | out | stdout/stderr — rendered into the cell's terminal view |
| 3 | — | in | datain (opened, yours to use) |
| 4 | `BUCHE_DATA_FD` | out | dataout: write one JSON value per line; each arrives at the terminal as a `data` message (same as sending one on fd 5, minus the envelope) |
| 5 | `BUCHE_CONTROL_FD` | duplex | the control channel |

A quick liveness check in Python: `BUCHE_CONTROL_FD` in `os.environ` **and**
`os.fstat(int(...))` succeeds. Degrade to plain text output when absent (CI,
pipes).

### Shell environment (`coquille`)

buche's companion shell `coquille` exports `CQ_CURRENT_COMMAND` while it
handles a prompt command (Enter/submit, Tab/complete, …): the **JSON
serialization of the `command` message** it is dispatching — `text`,
`selection` (`start === end` is the plain cursor), `action` (the action
that fired: a command line string, `{"command": ...}` or `{"builtin": ...}`), `id`, `from`,
`to` (see `references/outgoing.schema.json`). Processes spawned by the
submitted command inherit it, so a GUI program can read the submission that
launched it (`JSON.parse(os.environ["CQ_CURRENT_COMMAND"])`). Absent when the
process was started any other way.

---

## 2. Cells: where your output goes

A process started by `coquille` shows up as **a placeholder** at first (its
address plus `"?"`): an empty terminal, standing in for the first thing you
show, and taking keyboard input meanwhile. Then:

- What you print goes to `<process>.$stdout`: your **terminal** cell.
- What you write on fd 4 (and GUI commands, §3) goes to `<process>.$frame`:
  your **GUI** cell.

Whichever comes first takes the placeholder's place; the other one, if it
comes, becomes a tab beside it (a new GUI comes to the front). Both stand for
your process: closing one tab leaves the process running while the other is
there; closing the last one terminates it.

**GUI only.** To have what you print show up inside the GUI instead (as
`"buche:text"` data blocks, §3), ask the shell, before printing:

```json
{"type": "stdout_mode", "from": ["$proc"], "to": ["$shell"], "mode": "gui"}
```

(`"mode": "text"` switches back.)

**Any address is a cell.** `configure` with a `kind` creates a cell there (or
reconfigures it — send it again with changed fields). A cell is a `"terminal"`,
a `"frame"` (an HTML page you drive: a GUI) or a `"prompt"`, and stays that
kind: a GUI app declares a `"frame"`:

```json
{"type": "configure", "kind": "frame", "from": ["myapp"], "to": ["$term"], "label": "myapp"}
```

A cell must be declared before anything is sent to it: a `send` to an
address that shows nothing is refused (an `undeclared` problem).

Fields that matter for GUI apps (full set in `references/incoming.schema.json`
under `ConfigureMessage`):

- `label`: tab/cell title: a string, or structured text
  (`{"parts": [{"text": "myapp", "style": "sans"}]}`;
  part styles are accents, which can also set the font: `mono`, `sans`,
  `serif`, `cursive`). Besides text parts, structured text can hold
  `{"spacer": "grow"}`, which takes the space left over on the line (to
  right-align what follows it), and groups, `{"group": [parts], "style": …,
  "action": …}`: the group's style applies to its parts under their own
  (`"bold"` over `"red"`: bold red), and its action (only in a prompt's
  context) makes the whole group one click target. Spacers in a group are
  ignored.
- `icon`: shown before the label in its tab (`null` removes it). Either an
  image, `{"type": "image", "mimetype": "image/png", "data": "<base64>",
  "encoding": "base64"}` (or SVG text with no `encoding`; `"mask": true` paints
  only its shape, in the text colour), or a character,
  `{"type": "glyph", "text": "M", "font": "cursive", "color": "orange bold",
  "background": "blue", "shape": "circle"}` (all but `text` optional; `shape`
  is `"circle"` or `"square"`, and only matters with a `background`).
- `zone`: where a new cell goes. `"inline"` (the default: in the stream of the
  prompt it was started from), `"tab"` (a new tab beside it), `"left"`,
  `"right"`, `"up"`, `"down"` (or `l`, `r`, `u`, `d`: into the pane on that
  side, made if there is none), `"sleft"`, `"sright"`, `"sup"`, `"sdown"` (or
  `sl`, `sr`, `su`, `sd`: a new pane split off on that side, even if there is
  one already), `"float"` (or `f`: a new floating window), `"pop"` (a
  floating window over the prompt, closed — the process terminated — as soon
  as the focus leaves it), or the name of a pane (made if there is none).
  Users type the same as `@zone` before a command (`@left ls`).
- `id`: when answering a submitted command, repeat the `id` from the `command`
  message you received; buche then moves the focus to your cell when it
  appears.
- `background`: create the cell without stealing the focus.
- `sticky`: keep the focus in the cell when your process ends.
- `grow`: lift the height cap a cell has in a scroll stream (normally ~500px,
  past which the cell scrolls on its own): the cell takes all the height its
  content needs, and the user scrolls the stream instead. Meant for long,
  growing content such as a chat transcript.

**The GUI does not exist yet** at this point: it comes into being with the
first GUI command, starting from an empty document. Everything in it arrives
through your commands.

### Temporary interfaces: `standby`

A GUI the user may just glance at (a souped-up `ps`, say: it keeps running to
take button clicks, but most of the time nobody clicks) can say so:

```json
{"type": "configure", "from": ["$proc"], "to": ["$term"], "status": "standby"}
```

A standby process is terminated when the user clears spent cells (Ctrl+L), or
once its cell has stayed scrolled out of view (out of sight even with its
stream scrolled to the bottom) for a while. `"status": "running"` takes it
back, e.g. while the user is in the middle of something.

### Refusing to close

Closing your cell's tab (its ✕, Cmd+W, Alt+Q W) sends your process a SIGTERM,
and the tab goes once your process has ended. To refuse (e.g. to ask about
unsaved changes first), trap SIGTERM and stay alive: the tab shows as closing
meanwhile. Then either exit (the tab goes), or say you are running again,
which cancels the close (the tab stays):

```json
{"type": "configure", "from": ["$proc"], "to": ["$term"], "status": "running"}
```

The user can still force it: Alt+Q Shift+W (or a click on the closing tab's
spinner) kills your process and closes the tab right away.

---

## 3. Commands — you → GUI

GUI commands ride inside a `send` envelope:

```json
{"type": "send", "from": ["myapp"], "to": ["$term"],
 "message": {"type": "html", "content": "<h1>hi</h1>"}}
```

They execute in arrival order; commands sent before the document is up are
queued and replayed against it. A bare `{"type": "data", "data": {...}}`
message (no envelope) is a shorthand for a `data` command.

### `html` — inject HTML

```json
{"type": "html", "mode": "append", "selector": "#log", "content": "<p>hi</p>"}
```

- `mode`: `"append"` (default) | `"set"` (replace the target's children) |
  `"replace"` (replace the target itself).
- `selector`: CSS selector, defaults to the document body.
- `<script>` tags in `content` are re-created on insertion, so **they
  execute** — this is how you ship your app's JavaScript.
- If the injected nodes contain an element with `id="prime-focus"`, it takes
  the focus.

### `exec` — evaluate JavaScript in the page

```json
{"type": "exec", "code": "state.count", "response_id": "r7"}
```

- With `response_id`: `code` is evaluated as an **expression**, awaited, and
  answered back to you as a `{"type": "response", "response_id", "value"}`
  (or `"error"`) message.
- Without `response_id`: `code` runs as **statements**; no answer.
- `selector`: run once per matched element with `this` bound to it (the answer
  then carries an array of values).

### `data` — structured payloads

```json
{"type": "data", "data": {"$schema": "myapp:row", "cells": [1, 2]}}
```

The iframe dispatches on `data.$schema`:

- `"buche:plain"` (default when no handler): pretty-printed JSON block.
- `"buche:text"`: raw text block (this is what printed text becomes with
  `stdout_mode` `"gui"`, §2).
- your own: registered with `register_schemas`.

### `register` — add command handlers

```json
{"type": "register", "handlers":
  {"greet": "(msg) => { document.body.append(msg.who); }"}}
```

Handlers are JavaScript **function source strings** `(msg) => ...`. After
registering, any `send` whose inner `message.type` matches is dispatched
to that function with the whole message as argument. This is the extensibility
hatch: build your own command vocabulary instead of composing `exec` calls.

### `register_schemas` — add `data` handlers

```json
{"type": "register_schemas",
 "schemas": {"myapp:row": "(data) => renderRow(data)"}}
```

Maps `$schema` values to `(data) => ...` sources.

### `resolve` — serve `proc://` resources (§6)

```json
{"type": "resolve", "request_id": "abc", "status": 200,
 "content": "...", "mimetype": "text/plain", "encoding": "utf-8"}
```

- With `request_id`: answers the pending request the GUI relayed to you.
- Without `request_id`, with `path` and `content`: **pre-seeds the cache** so
  a later request for that path never round-trips to you.
- `encoding`: `"base64"` for binary payloads, otherwise plain text.

### `response` — answer `buche.request()` (§5)

```json
{"type": "response", "response_id": "k3", "value": {"ok": true}}
```

Resolves the page-side Promise (or rejects it, with `"error": "..."` instead
of `"value"`).

### `text` — the terminal view

`{"type": "text", "stream": "stdout", "text": "..."}` (this is also what
stdout becomes, at `$stdout`). It is for a `"terminal"` cell only: the other
commands are for a `"frame"` cell, and a cell refuses commands of the other kind
(a `kindmismatch` problem). For both, use two cells (`$stdout` and `$frame`).

---

## 4. Replies — GUI → you

Anything the page sends out arrives on your control channel as one message:

```json
{"type": "data", "from": ["$term"], "to": ["myapp"], "data": { ... }}
```

| Origin (inside the iframe) | The `data` payload you receive |
| --- | --- |
| `buche(x)` | `x`, verbatim |
| `buche.request(x)` | `{...x, response_id: "<id>"}` — answer with a `response` command |
| `exec` with `response_id` | `{"type": "response", "response_id", "value" \| "error"}` |
| a `proc://` request not in the cache | `{"type": "resolve", "request_id", "path", "params", "method"}` — answer with a `resolve` command |

The one page message you will **not** receive is `{"type": "leave"}`
(`buche.leave()`, §7): buche consumes it to move the focus away from your
cell.

Correlate round trips with the ids: `buche.request` mints one itself, so mint
your own and put it in the payload if you need to route the answer.

---

## 5. The API inside the iframe (`window.buche`)

Inside your GUI's pages, a global `buche` is always available — no script
tag, no import:

| Call | Effect |
| --- | --- |
| `buche(data)` / `buche.send(data)` | relay `data` to your process (§4) |
| `buche.request(data)` | like `buche(data)`, but adds a fresh `response_id` and returns a Promise; your process resolves it with a `response` command (rejects if the answer carries `error`) |
| `buche.proc(url, {method})` | fetch a `proc://` resource; returns a `Response` (§6) |
| `buche.lib(url)` | the URL a `lib://` URL loads from (§6) |
| `buche.blur()` | give the keyboard back to the terminal (focus stays on your cell) |
| `buche.leave()` | "the user is done": the focus leaves your cell entirely, even when sticky |
| `buche.autofocus()` | focus `[autofocus]` / `#prime-focus` / the last focused element |

Sizing information:

- **`window.bucheInfo`** — `{width, height, maxHeight, dynamicHeight}` of the
  cell in CSS pixels, accurate before your first script runs (`maxHeight` is
  0 when the cell has no cap, as with `grow`).
- **`window` `"buche-info"`** event — fired whenever it changes
  (`e.detail`), e.g. after the user drags the cell's size gutter.
- **`window` `"resize"`** events fire whenever the cell's size changes; react
  to those rather than polling.

### Height contract

By default your GUI **is content-sized**: buche reads the height of your
document and grows the cell to fit — no scrollbars, your whole UI is visible.
That means:

- Report through layout, not code: whatever your body's box + margins measure
  is the height taken; absolutely-positioned overlays are not counted.
- The cell must be able to **shrink** too: avoid `min-height` on `body` and
  anything that locks the viewport height (`100vh`), or your cell can never
  get shorter.

When the cell has a height of its own (`bucheInfo.dynamicHeight === false` —
pinned by a drag, or filling a pane), height reports are ignored, and the
runtime installs `html, body { height: 100% }` so fill layouts work. Listen
for `"resize"` / `"buche-info"` and reflow.

---

## 6. `proc://` resources

Each GUI cell can serve resources under a private URL space. Inside the
iframe, **relative URLs are your cell's resources**: `fetch("logo.png")`,
`<img src="chart.svg">`, `<link href="style.css">`, `<script src="app.js">`,
`<iframe src="page.html">`, XHR — all of it is transparently routed to you.
(`buche.proc(url)` does the same thing explicitly and gives you a
`Response`.) Absolute `http(s)://` URLs are refused: see "No network" below.

### No network

A GUI cannot reach the network. Its page, and every library it loads, gets
`proc:` resources, `lib:` libraries, and what it makes itself (`blob:`,
`data:`); anything over `http(s)://` or `ws(s)://` is refused: `fetch`, XHR,
WebSockets, `<script src>`, stylesheets and `@import`, images, fonts,
`sendBeacon`, workers, and the page navigating itself away. (Enforced by a
Content Security Policy on every GUI document, which the page cannot lift,
and, in Electron, by blocking the requests themselves.)

So ship what your page needs: a library such as d3 goes in a `lib://` library
(below) or a `proc://` resource, not a CDN link; fonts too. A library that
phones home (analytics, remote fonts, tile servers) fails where it does.

A request you have not pre-served arrives as
`{"type": "resolve", "request_id", "path", "params", "method"}` — answer with
a `resolve` command (`status` / `content` / `mimetype` / `encoding`, base64
for binary; §3).

Better: **push resources ahead of the request** with a cache-seeding `resolve`
(a `resolve` with `path` but no `request_id`), so `app.js` and images load
with zero round trips.

### `lib://` libraries: files served for you

For static files (your app's JS, CSS, images), declare a **library** instead:
you only send hashes, your shell (cq) supplies the content when it's needed,
and buche keeps it in a store shared by every session. Nothing is sent twice,
and the files keep loading after your process exits.

Your process gets a salt of its own in `$BUCHE_LIB_SALT`. Prove you can read
each file with `HMAC-SHA256(key = the salt as UTF-8, message = the content)`
in hex, and send this on the control channel:

```json
{"type": "library", "from": ["$proc"], "id": "k3j9x0c2m8q4z7w1v5b6",
 "files": {"js/main.js":  {"file": "/abs/path/to/main.js",  "mimetype": "text/javascript", "proof": "<hex>"},
           "js/util.js":  {"file": "/abs/path/to/util.js",  "mimetype": "text/javascript", "proof": "<hex>"},
           "style.css":   {"file": "/abs/path/to/style.css", "mimetype": "text/css",        "proof": "<hex>"}}}
```

- **`id`**: 16 to 63 characters in `[a-z0-9-]`, **unguessable**. Anyone who
  knows the id can load the library. Use random bytes, or a hash of the proofs.
  An id stays bound to its files: declaring it again with different files is
  refused, so use a new id when the files change.
- **`file`**: an absolute path to a regular file (at most 64 MiB).
- The keys are the paths in the library: the files are served at
  `lib://<id>/<path>`, and relative URLs between them work
  (`import "./util.js"` in `js/main.js`). Note that `fetch()` resolves against
  the *page*, not the module: use `new URL("../data.json", import.meta.url)`.

**Or give the content inline**, for any file, in place of `file` and
`proof`: `{"mimetype": "application/json", "content": "...", "encoding":
"utf-8"}` (`"base64"` for binary). Inline files need no proof and no
authority: a library made only of them can be declared without cq (e.g. by a
program buche runs directly), straight to `["$term"]`. Choose an unguessable
id all the same.

cq reads the files, checks the proofs, and passes the library on. Anything
wrong (a missing file, a bad proof) shows up as an error in the terminal, and
nothing is declared. Messages you send after the declaration (your `html`)
reach buche after it, so you can use `lib://` URLs right away:

```json
{"type": "send", "from": ["$proc"], "message": {"type": "html",
 "content": "<link rel=stylesheet href='lib://k3j9x0c2m8q4z7w1v5b6/style.css'><script type=module src='lib://k3j9x0c2m8q4z7w1v5b6/js/main.js'></script>"}}
```

If a file changes after you declared it, loading it fails until you declare a
library (with a new id) for the new content. A file already in buche's store
keeps loading.

The store (`~/.cache/buche/lib`, or `$BUCHE_LIB_STORE`) is capped at 512 MiB
(`$BUCHE_LIB_STORE_LIMIT`, e.g. `2G`), dropping the files used longest ago
first. The files of the libraries a buche window serves are never dropped
while it runs.

In the browser view (not Electron), `lib://` URLs are rewritten for you in
`src`/`href` attributes of `html` content and in `fetch`/XHR. Anywhere else
(a script setting `src` itself, `url()` in inline CSS, `import` in an inline
module), go through **`buche.lib(url)`**, which gives the URL to load (the
same URL in Electron).

---

## 7. Focus, as seen from your page

- The user navigating onto your cell does **not** move the focus into your
  page; keys keep going to the terminal until the navigation is *committed*.
- On commit, the focus lands on the element that last had it in your page, or
  else on `[autofocus]` / `#prime-focus`. Put `autofocus` on your primary
  input (or give it `id="prime-focus"`) so a fresh page grabs the keyboard;
  `html` commands focus `#prime-focus` among newly injected nodes as well.
- Make interactive elements focusable (`tabindex`) — the user tabs inside
  your page from there.
- Escape hatches: `buche.blur()` hands keys back to the terminal while your
  cell keeps it; `buche.leave()` means "done with this GUI" and moves the
  focus off your cell (never delivered to your process; the cell and your
  process survive untouched).
- Some chords always escape your page, even with the focus inside it, and
  reach the terminal as if typed there: by default **Alt+Q** (navigation
  mode), **Cmd/Ctrl+P** (focus a prompt), **Ctrl+Tab / Ctrl+Shift+Tab** and
  **Cmd/Ctrl+←/→** (switch tabs) — the user can rebind them, and add more
  (~/.config/buche/config.yaml). Don't rely on capturing them.
- A click inside the page focuses it naturally, like in any browser.

---

## 8. End-to-end example

The control-channel conversation of a tiny counter app (process address
`["counter"]`; `→` = you write to fd 5, `←` = you read):

```jsonl
→ {"type":"configure","kind":"frame","from":["counter"],"to":["$term"],"label":"counter"}
→ {"type":"send","from":["counter"],"to":["$term"],"message":{"type":"html","content":
  "<p>Count: <b id=\"n\">0</b></p>
   <button autofocus onclick=\"buche({action:'inc'})\">+1</button>
   <script>
     buche.proc('state.json').then(r => r.json()).then(s => { document.getElementById('n').textContent = s.n; });
   </script>"}}
→ {"type":"send","from":["counter"],"to":["$term"],"message":{"type":"resolve","path":"state.json","content":"{\"n\": 41}","mimetype":"application/json"}}
← {"type":"data","from":["$term"],"to":["counter"],"data":{"action":"inc"}}
→ {"type":"send","from":["counter"],"to":["$term"],"message":{"type":"exec","code":"++document.getElementById('n').textContent|0"}}
```

(Order the `resolve` push before the `html` if you want the `fetch` to hit the
cache.)

---

## 9. Gotchas

- The iframe is sandboxed to scripts only: no same-origin access, no forms,
  no popups, and no network (§6). Everything goes through `buche`.
- `html` with `mode:"set"` on the body wipes your page's state (globals, DOM,
  listeners) — prefer targeted `append`/`set` on containers, or `exec`.
- `exec`, `register` and `register_schemas` `eval` code in the page by
  design: only ever send code you produced, never strings that passed through
  untrusted input.
- The document starts empty and parses before queued commands run; scripts
  injected via `html` run once, at insertion.
- Your process ending does not close the GUI: it stays on screen; the focus
  leaves the cell unless it is `sticky` — and the user can always come back
  (a click or navigation refocuses it while the process lives).
- Keep the protocol JSON on single lines; a message containing a raw newline
  breaks framing.
