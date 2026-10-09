---
name: buche
description: Build GUI apps for the buche terminal — drive an interactive HTML view from your program over the fd-5 control channel (cell_configure, cell_send with html/exec/data/register/resolve/response commands), talk back from JavaScript with the in-iframe `buche` API, serve proc:// resources, and handle focus and sizing. Use when writing any program (Python, Node, anything) that renders an interactive UI in buche, with buchelib or over the raw JSON protocol.
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

---

## 2. Creating and configuring the cell

`cell_configure` creates the cell (and reconfigures it later — send it again
with changed fields):

```json
{"type": "cell_configure", "from": ["myapp"], "to": ["$term"],
 "mode": "unified", "label": "myapp"}
```

Fields that matter for GUI apps (full set in `references/incoming.schema.json`
under `CellConfigureMessage`):

- `mode`: `"split"` (terminal + switchable GUI view, the default) or
  `"unified"` (GUI only — text you print becomes text blocks inside the GUI).
- `label`: tab/cell title.
- `id`: when answering a submitted command, repeat the `id` from the `command`
  message you received; buche then moves the focus to your cell when it
  appears.
- `background`: create the cell without stealing the focus.
- `sticky`: keep the focus in the cell when your process ends.

**The GUI view does not exist yet** at this point: it comes into being with
the first GUI command, starting from an empty document. Everything in it
arrives through your commands.

---

## 3. Commands — you → GUI

GUI commands ride inside a `cell_send` envelope:

```json
{"type": "cell_send", "from": ["myapp"], "to": ["$term"],
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
- `"buche:text"`: raw text block (this is what printed text becomes in
  `"unified"` mode).
- your own: registered with `register_schemas`.

### `register` — add command handlers

```json
{"type": "register", "handlers":
  {"greet": "(msg) => { document.body.append(msg.who); }"}}
```

Handlers are JavaScript **function source strings** `(msg) => ...`. After
registering, any `cell_send` whose inner `message.type` matches is dispatched
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
stdout becomes). In `"split"` mode it goes to the terminal view; in
`"unified"` mode there is none, and it shows up inside the GUI as a
`"buche:text"` data block.

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
| `buche.blur()` | give the keyboard back to the terminal (focus stays on your cell) |
| `buche.leave()` | "the user is done": the focus leaves your cell entirely, even when sticky |
| `buche.autofocus()` | focus `[autofocus]` / `#prime-focus` / the last focused element |

Sizing information:

- **`window.bucheInfo`** — `{width, height, maxHeight, dynamicHeight}` of the
  cell in CSS pixels, accurate before your first script runs.
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
`<iframe src="page.html">`, XHR — all of it is transparently routed to you;
absolute `http(s)://` URLs still hit the real network. (`buche.proc(url)`
does the same thing explicitly and gives you a `Response`.)

A request you have not pre-served arrives as
`{"type": "resolve", "request_id", "path", "params", "method"}` — answer with
a `resolve` command (`status` / `content` / `mimetype` / `encoding`, base64
for binary; §3).

Better: **push resources ahead of the request** with a cache-seeding `resolve`
(a `resolve` with `path` but no `request_id`), so `app.js` and images load
with zero round trips.

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
  reach the terminal as if typed there: **Ctrl+Q** (navigation mode) and
  **Ctrl+Tab / Ctrl+Shift+Tab** (switch tabs). Don't rely on capturing them.
- A click inside the page focuses it naturally, like in any browser.

---

## 8. End-to-end example

The control-channel conversation of a tiny counter app (process address
`["counter"]`; `→` = you write to fd 5, `←` = you read):

```jsonl
→ {"type":"cell_configure","from":["counter"],"to":["$term"],"mode":"unified","label":"counter"}
→ {"type":"cell_send","from":["counter"],"to":["$term"],"message":{"type":"html","content":
  "<p>Count: <b id=\"n\">0</b></p>
   <button autofocus onclick=\"buche({action:'inc'})\">+1</button>
   <script>
     buche.proc('state.json').then(r => r.json()).then(s => { document.getElementById('n').textContent = s.n; });
   </script>"}}
→ {"type":"cell_send","from":["counter"],"to":["$term"],"message":{"type":"resolve","path":"state.json","content":"{\"n\": 41}","mimetype":"application/json"}}
← {"type":"data","from":["$term"],"to":["counter"],"data":{"action":"inc"}}
→ {"type":"cell_send","from":["counter"],"to":["$term"],"message":{"type":"exec","code":"++document.getElementById('n').textContent|0"}}
```

(Order the `resolve` push before the `html` if you want the `fetch` to hit the
cache.)

---

## 9. Gotchas

- The iframe is sandboxed to scripts only: no same-origin access, no forms,
  no popups. Everything goes through `buche`.
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
