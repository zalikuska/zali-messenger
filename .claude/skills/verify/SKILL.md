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

### Getting logged in

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
