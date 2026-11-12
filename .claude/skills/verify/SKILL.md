---
name: verify
description: Build, run and drive the ZaliMessenger web client (the canonical UI shared by all four shells) to observe a change at runtime.
---

# Verifying a change in this repo

The web UI (`web/src/`) is the canonical source for **all four** shells, so a
change there is verified in a browser tab and that verdict carries to macOS,
Windows and Android. A change confined to a native shell has to be run in that
shell instead — this skill does not cover those.

## Handle

```bash
python3 scripts/bundle_web.py     # ALWAYS first: web/app.js is generated
```

Then two servers, both already in `.claude/launch.json` — use `preview_start`,
never Bash:

| name | port | what |
|---|---|---|
| `zali-server` | 3000 | the API (`cargo run`, reads `.env` at repo root) |
| `web-static` | 8090 | serves `web/` |

Open `http://127.0.0.1:8090`. `.env` already lists both localhost and 127.0.0.1
origins in `ALLOWED_ORIGINS`; **the two are separate browser origins**, so
localStorage/IndexedDB do not carry between them — handy for a clean slate.

### Fastest: the dev link (no login form, no clicks)

```bash
python3 scripts/zali_ctl.py url --as dev1 --contact dev2 --chat dev2
# → http://127.0.0.1:8090/?as=dev1&contact=dev2&chat=dev2
```

Navigating there registers-or-logs-in `dev1` on the **local** server (password
`ZALI_DEV_PASSWORD` in `web/src/interface/control.js`, `pw=` for an account made
some other way), adds contacts, opens the chat. Other params: `channel=<server>/<channel>`,
`view=settings|hub|coin`, `voice=<server>/<channel>`, `api=<url>` (default
`http://<page host>:3000`), `run=[["cmd",{args}],…]`. Honoured only on a loopback page
outside native shells. Not `open=` — that name belongs to the push-click route
(`web_push.js`) and is stripped from the URL. The session persists per origin, so the
second visit is instant; use `localhost` vs `127.0.0.1` for a second account.
`window.__ZALI_INTERFACE.devBootResult` lists what each step did.

Then drive everything through one call instead of clicks:

```js
await __zaliControl('help')                       // every command + args
await __zaliControl('send', {chat:'dev2', text:'hi'})
await __zaliControl('server.create', {name:'T'}); await __zaliControl('channel.create', {server:'T', name:'V', kind:'voice'})
await __zaliControl('voice.join', {server:'T', channel:'V'}); await __zaliControl('voice.state')
await __zaliControl('wait', {code:"this.voice.status === 'connected'", timeout: 10000})
```

The Browser pane blocks the microphone: `voice.state.micError` says so, and the room
still joins.

### Native shells from the terminal

Settings → «Для разработчиков» → «Управление из терминала» turns on a loopback HTTP
endpoint in the shell (macOS `Services/ControlServer.swift`, Windows
`native/control.rs`, off by default). The shell mints the token, stores it in
`control.json` under its data dir and checks it on every request. Paste the connection
string once: `python3 scripts/zali_ctl.py pair 'zalictl://…'`. After that
`zali_ctl.py state | chats | messages | send | voice … | call | screen sources|start|stop |
logs | eval | wait | snapshot | window show` run the same page commands. `snapshot`
(PNG of the window) is macOS only. Never run a test copy of the macOS app for this:
it shares Application Support with the real one.

### Getting logged in by hand

The login form's own submit is fiddly to drive with synthetic clicks. What
works, in order of preference:

```js
// 1. register (no UI path needed)
await fetch('http://127.0.0.1:3000/api/auth/register', {method:'POST',
  headers:{'Content-Type':'application/json'},
  body: JSON.stringify({username:'u', password:'atleast8chars'})});

// 2. log in through the app's OWN auth path
await window.__ZALI_INTERFACE.executeAuth('login', 'u', 'atleast8chars');
```

`window.__ZALI_INTERFACE` is the live `ZaliInterface` instance — the real
object, not a copy. Driving its methods drives the app.

Set the API base for an origin that has never seen it:

```js
localStorage.setItem('zali_network_config_v1', JSON.stringify({
  apiBaseUrl:'http://127.0.0.1:3000', wsBaseUrl:'ws://127.0.0.1:3000/ws', iceServers:[]}));
```

## Gotchas that will waste your time

- **`requestAnimationFrame` does not run while the Browser pane is hidden.**
  The boot splash's fade is rAF-driven, so a headless session sits on
  "ZaliMessenger / scrambling text" forever and the app looks hung. It is not
  — check `sessionBootstrapInProgress === false` and `document.hidden`. Front
  the tab (`tabs_select`) before judging anything animation-gated. The same
  applies to `scheduleAvatarRefresh`/`scheduleServerAssetRefresh`.
- **`index.html` pins `?v=` on `style.css` and `app.js`.** Change either and
  the browser serves the stale cached copy until you bump that string. If a
  new element renders unstyled, check this first.
- **Settings has three entry points** — the gear button, the mobile bottom nav
  and the Hub segment control — and they all funnel through
  `openSettingsView()` (`web/src/interface/mobile.js`). Anything that must be
  rendered when Settings opens belongs there, not on the gear's click handler.
- **`img.decode()` can hang** in a hidden pane. Read PNG dimensions out of the
  bytes instead if you need to prove which image you got.

## Flows worth driving

- **Asset cache** (`web/src/interface/cache.js`): cold load vs warm load,
  counting `performance.getEntriesByType('resource')` entries matching
  `/api/avatar/`. Warm must be 0. Settings card is `#cacheSettings`.
- **Avatars**: upload via `setProfileAvatar(file, username)` with a File built
  from a canvas `toBlob`.
- **Offline**: `preview_stop` the API server and reload — cached assets should
  still render.

## Harnesses

`scripts/{perf,security,memory,voice,crypto}_doctor/run.sh` run the real
`ZaliInterface` in a Node VM. They are the repo's regression net, not a
substitute for running the app — but a change that breaks one has broken an
invariant someone wrote down after an incident.
