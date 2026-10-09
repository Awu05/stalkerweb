# Viewer Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each person on a shared StalkerWeb server their own favorites and their own channel filters (hidden genres, hidden languages, Show Adult), chosen with a "Who's watching?" picker, while every other setting stays shared.

**Architecture:** A new server-side store (`data/viewers.json`, `ViewersManager`) holds viewers. A middleware resolves which viewer each request is for (header, query, `/v/<id>` path, Xtream username, else the default) and keeps it in an `AsyncLocalStorage`, so the existing filter hooks on `appState` (`getExportFilter`, `getShowAdult`, new `getHiddenLanguages`) answer for the current viewer without threading `req` through the catalog. The website stores the chosen viewer per device and sends it as `X-Viewer`.

**Tech Stack:** Node 20 / Express 5 / vitest (backend); React 19 + Vite + Tailwind v4 / vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-10-08-viewer-profiles-design.md`

## Global Constraints

- Shared and unchanged: portal connection and portal profiles, live buffer, idle auto-disconnect, EPG/VOD switches, download folder, STB emulation, access key.
- Per viewer: favorites (channels + groups), `disabledGenres`, `disabledLanguages`, `showAdult`.
- Names 1–30 characters, trimmed, unique case-insensitively. Colors only from the fixed palette. The last viewer cannot be deleted.
- Unknown viewer anywhere → the default viewer, never an error.
- Old `favorites.json`, `show_adult` setting and portal-profile filter fields are left on disk, never deleted, just no longer read.
- The default viewer's links stay exactly as today (no `?viewer=`, no `/v/`, Stremio id `com.stalkerweb.addon`), so existing installs keep working.
- No PINs; the Android app is untouched.
- Backend files use `'use strict'`, CommonJS, 2-space indent, `log.info(TAG, …)` via `../logger`. Several repo files are CRLF — edit with the Edit tool, not shell heredocs.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A viewer deleted while another device still has it saved: that device's requests must get the default viewer, and the website must show the picker rather than an empty or broken page. (Task 2 test: unknown id → default; Task 7 test: `chooseViewer` with a stale saved id.)
- Async continuations losing the viewer: a filter read after an `await` inside a route must still see the request's viewer, not the default. (Task 3 test: reads the filter after `await`.)
- Two viewers' favorites written at nearly the same time must not overwrite each other. (Task 1 test: interleaved writes to two viewers keep both.)
- Migration running twice, or with no old data at all. (Task 1 tests.)
- Renaming a viewer to another viewer's name in a different case ("andy" vs "Andy") must be refused. (Task 1 test.)

---

## File Structure

Backend:
- Create `backend/viewers/ViewersManager.js` — viewers store: CRUD, validation, filters, per-viewer favorites, first-run migration.
- Create `backend/lib/viewerContext.js` — request → viewer resolution, `/v/<id>` stripping, `AsyncLocalStorage`.
- Create `backend/lib/viewerFilters.js` — installs `currentViewer`, `isDefaultViewer`, `getExportFilter`, `getShowAdult`, `getHiddenLanguages` on `appState`.
- Create `backend/routes/viewers.js` — `/api/viewers` API.
- Modify `backend/routes/favorites.js` — favorites of `req.viewer`.
- Modify `backend/routes/settings.js` — drop `show_adult`.
- Modify `backend/routes/stremio.js` — per-viewer manifest id and name.
- Modify `backend/lib/catalog.js`, `backend/routes/vod.js` — hidden languages from the viewer.
- Modify `backend/server.js` — wiring.
- Tests: `backend/tests/viewers-manager.test.js`, `viewer-context.test.js`, `viewer-filters.test.js`, `viewers-routes.test.js`; update `stremio.test.js`, `idle-timeout-settings.test.js`.

Frontend:
- Create `frontend/src/lib/viewer.js` (+ `viewer.test.js`) — saved viewer id, `chooseViewer`.
- Create `frontend/src/components/ViewerPicker.jsx` — "Who's watching?".
- Create `frontend/src/components/ViewersCard.jsx` — Settings → Viewers.
- Modify `frontend/src/stalkerApi.js` — `X-Viewer` header, viewer API functions.
- Modify `frontend/src/App.jsx` — viewer state, picker, sidebar viewer chip, `Routes` keyed by viewer.
- Modify `frontend/src/pages/SetupPage.jsx` — "My channels" card, Show Adult moved there, Viewers card, links with the viewer.

---

### Task 1: ViewersManager

**Files:**
- Create: `backend/viewers/ViewersManager.js`
- Test: `backend/tests/viewers-manager.test.js`

**Interfaces:**
- Consumes: `FavoritesManager` prototype (`backend/favorites/FavoritesManager.js`) — its methods only use `this._load()` / `this._save(fav)`.
- Produces:
  - `new ViewersManager(dataDir)`
  - `ensureInitialized({ favorites, showAdult, disabledGenres, disabledLanguages }) → boolean` (true when it created the file)
  - `list() → { defaultViewerId, viewers: [{ id, name, color }] }`
  - `get(id) → viewer | null`, `getDefault() → viewer`, `findByName(nameOrId) → viewer | null`
  - `create({ name, color? }) → viewer`, `update(id, { name?, color? }) → viewer`, `remove(id) → void`
  - `setFilters(id, { disabledGenres?, disabledLanguages?, showAdult? }) → viewer`
  - `favoritesOf(id) → object with the FavoritesManager API` (`getRaw`, `addChannel`, `removeChannel`, `createGroup`, `renameGroup`, `deleteGroup`, `addChannelToGroup`, `removeChannelFromGroup`, `reorderChannels`, `reorderGroups`, `migrateLegacyIds`)
  - `ViewersManager.COLORS: string[]`, `ViewersManager.ViewerError` (`.status` 400/404/409)
  - viewer shape: `{ id, name, color, favorites: { channels, groups }, disabledGenres, disabledLanguages, showAdult }`

- [ ] **Step 1: Write the failing tests**

`backend/tests/viewers-manager.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import ViewersManager from '../viewers/ViewersManager.js'

const { COLORS, ViewerError } = ViewersManager
let dir, viewers

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-viewers-'))
  viewers = new ViewersManager(dir)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const statusOf = (fn) => { try { fn() } catch (e) { return e instanceof ViewerError ? e.status : 'other' } return null }

describe('first start', () => {
  it('creates a Default viewer from the shared favorites and filters', () => {
    const created = viewers.ensureInitialized({
      favorites: { channels: ['1', '2'], groups: [{ id: 'g1', name: 'News', channels: ['1'] }] },
      showAdult: true,
      disabledGenres: ['Sports'],
      disabledLanguages: ['FR'],
    })
    expect(created).toBe(true)
    const v = viewers.getDefault()
    expect(v).toMatchObject({ name: 'Default', showAdult: true, disabledGenres: ['Sports'], disabledLanguages: ['FR'] })
    expect(v.favorites.channels).toEqual(['1', '2'])
    expect(v.favorites.groups[0]).toMatchObject({ id: 'g1', name: 'News', channels: ['1'] })
  })

  it('gives an empty Default viewer when there is nothing to migrate', () => {
    viewers.ensureInitialized({})
    expect(viewers.getDefault()).toMatchObject({
      name: 'Default', showAdult: false, disabledGenres: [], disabledLanguages: [],
      favorites: { channels: [], groups: [] },
    })
  })

  it('does nothing once viewers.json exists', () => {
    viewers.ensureInitialized({ favorites: { channels: ['1'] } })
    viewers.create({ name: 'Andy' })
    expect(viewers.ensureInitialized({ favorites: { channels: ['9'] } })).toBe(false)
    expect(viewers.list().viewers.map(v => v.name)).toEqual(['Default', 'Andy'])
    expect(viewers.getDefault().favorites.channels).toEqual(['1'])
  })
})

describe('viewers', () => {
  beforeEach(() => viewers.ensureInitialized({}))

  it('creates a viewer with nothing hidden and no favorites', () => {
    const v = viewers.create({ name: '  Andy  ' })
    expect(v).toMatchObject({ name: 'Andy', showAdult: false, disabledGenres: [], favorites: { channels: [], groups: [] } })
    expect(COLORS).toContain(v.color)
    expect(v.id).toMatch(/^view_/)
  })

  it('refuses empty, too long and duplicate names, in any case', () => {
    viewers.create({ name: 'Andy' })
    expect(statusOf(() => viewers.create({ name: '   ' }))).toBe(400)
    expect(statusOf(() => viewers.create({ name: 'x'.repeat(31) }))).toBe(400)
    expect(statusOf(() => viewers.create({ name: 'andy' }))).toBe(409)
  })

  it('refuses a rename onto another viewer\'s name but allows changing its own case', () => {
    const a = viewers.create({ name: 'Andy' })
    const b = viewers.create({ name: 'Sam' })
    expect(statusOf(() => viewers.update(b.id, { name: 'ANDY' }))).toBe(409)
    expect(viewers.update(a.id, { name: 'ANDY' }).name).toBe('ANDY')
  })

  it('only accepts palette colors', () => {
    const a = viewers.create({ name: 'Andy' })
    expect(statusOf(() => viewers.update(a.id, { color: 'red' }))).toBe(400)
    expect(viewers.update(a.id, { color: COLORS[3] }).color).toBe(COLORS[3])
  })

  it('never deletes the last viewer, and moves the default when it is deleted', () => {
    const def = viewers.getDefault()
    const a = viewers.create({ name: 'Andy' })
    viewers.remove(def.id)
    expect(viewers.getDefault().id).toBe(a.id)
    expect(statusOf(() => viewers.remove(a.id))).toBe(409)
    expect(statusOf(() => viewers.remove('view_missing'))).toBe(404)
  })

  it('finds a viewer by name or id, ignoring case', () => {
    const a = viewers.create({ name: 'Andy' })
    expect(viewers.findByName('andy').id).toBe(a.id)
    expect(viewers.findByName(a.id.toUpperCase()).id).toBe(a.id)
    expect(viewers.findByName('')).toBe(null)
    expect(viewers.findByName('nobody')).toBe(null)
  })

  it('saves each viewer\'s own filters, validating them', () => {
    const a = viewers.create({ name: 'Andy' })
    viewers.setFilters(a.id, { disabledGenres: ['Sports'], showAdult: true })
    expect(viewers.get(a.id)).toMatchObject({ disabledGenres: ['Sports'], disabledLanguages: [], showAdult: true })
    expect(viewers.getDefault().disabledGenres).toEqual([])
    expect(statusOf(() => viewers.setFilters(a.id, { disabledGenres: 'Sports' }))).toBe(400)
    expect(statusOf(() => viewers.setFilters(a.id, { showAdult: 'yes' }))).toBe(400)
  })
})

describe('favorites per viewer', () => {
  beforeEach(() => viewers.ensureInitialized({}))

  it('keeps two viewers\' favorites apart, even when written in turn', () => {
    const a = viewers.create({ name: 'Andy' })
    const b = viewers.create({ name: 'Sam' })
    const fa = viewers.favoritesOf(a.id)
    const fb = viewers.favoritesOf(b.id)
    fa.addChannel('1')
    fb.addChannel('2')
    fa.addChannel('3')
    const g = fb.createGroup('Kids')
    fb.addChannelToGroup(g.id, '2')
    expect(viewers.get(a.id).favorites).toEqual({ channels: ['1', '3'], groups: [] })
    expect(viewers.get(b.id).favorites.channels).toEqual(['2'])
    expect(viewers.get(b.id).favorites.groups[0]).toMatchObject({ name: 'Kids', channels: ['2'] })
  })

  it('survives a restart', () => {
    const a = viewers.create({ name: 'Andy' })
    viewers.favoritesOf(a.id).addChannel('7')
    const again = new ViewersManager(dir)
    expect(again.favoritesOf(a.id).getRaw().channels).toEqual(['7'])
  })

  it('migrates legacy ids per viewer', () => {
    const a = viewers.create({ name: 'Andy' })
    viewers.favoritesOf(a.id).addChannel('607446590')
    expect(viewers.favoritesOf(a.id).migrateLegacyIds(id => (id === '607446590' ? '90210' : null))).toBe(1)
    expect(viewers.get(a.id).favorites.channels).toEqual(['90210'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/viewers-manager.test.js`
Expected: FAIL — `Cannot find module '../viewers/ViewersManager.js'`.

- [ ] **Step 3: Implement**

`backend/viewers/ViewersManager.js`:

```js
'use strict';

// ViewersManager — the people who watch on this server, in data/viewers.json.
// Each viewer has their own favorites and their own choice of which channels
// are shown (hidden genres and languages, adult content); every other setting
// is shared. See docs/superpowers/specs/2026-10-08-viewer-profiles-design.md.
//
// Every change reads the file, changes one viewer and writes it back, so two
// viewers saving in turn never overwrite each other.

const fs   = require('fs');
const path = require('path');
const FavoritesManager = require('../favorites/FavoritesManager');
const log  = require('../logger');
const TAG  = 'ViewersManager';

const COLORS   = ['#5b8def', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e93d82', '#978365'];
const MAX_NAME = 30;

class ViewerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function genId() {
  return `view_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const strings = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string') : []);

function normalFavorites(f) {
  return {
    channels: strings(f?.channels),
    groups: Array.isArray(f?.groups)
      ? f.groups.filter((g) => g && typeof g.id === 'string').map((g) => ({ ...g, channels: strings(g.channels) }))
      : [],
  };
}

function blankViewer(name, color) {
  return {
    id: genId(),
    name,
    color,
    favorites: { channels: [], groups: [] },
    disabledGenres: [],
    disabledLanguages: [],
    showAdult: false,
  };
}

class ViewersManager {
  constructor(dataDir) {
    this._file = path.join(dataDir, 'viewers.json');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /**
   * First start after the upgrade: one "Default" viewer made from what used to
   * be shared. Does nothing once viewers.json exists. Returns whether it ran.
   */
  ensureInitialized({ favorites = null, showAdult = false, disabledGenres = [], disabledLanguages = [] } = {}) {
    if (fs.existsSync(this._file)) return false;
    const v = blankViewer('Default', COLORS[0]);
    v.favorites = normalFavorites(favorites);
    v.showAdult = showAdult === true;
    v.disabledGenres = strings(disabledGenres);
    v.disabledLanguages = strings(disabledLanguages);
    this._save({ defaultViewerId: v.id, viewers: [v] });
    log.info(TAG, `created the Default viewer with ${v.favorites.channels.length} favorite(s)`);
    return true;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      const viewers = Array.isArray(raw.viewers) ? raw.viewers.filter((v) => v && typeof v.id === 'string') : [];
      const defaultViewerId = viewers.some((v) => v.id === raw.defaultViewerId) ? raw.defaultViewerId : (viewers[0]?.id ?? null);
      return { defaultViewerId, viewers };
    } catch {
      return { defaultViewerId: null, viewers: [] };
    }
  }

  _save(data) {
    try {
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this._file);
    } catch (e) {
      log.error(TAG, `save failed: ${e.message}`);
      throw e;
    }
  }

  // The data, never without a viewer: a missing or emptied file gets a Default.
  _data() {
    const d = this._load();
    if (d.viewers.length) return d;
    const v = blankViewer('Default', COLORS[0]);
    const fresh = { defaultViewerId: v.id, viewers: [v] };
    this._save(fresh);
    return fresh;
  }

  _mutate(id, change) {
    const d = this._data();
    const v = d.viewers.find((x) => x.id === id);
    if (!v) throw new ViewerError(404, 'Viewer not found.');
    change(v, d);
    this._save(d);
    return v;
  }

  _checkName(d, name, exceptId = null) {
    const n = String(name ?? '').trim();
    if (!n || n.length > MAX_NAME) throw new ViewerError(400, `A name of 1–${MAX_NAME} characters is required.`);
    if (d.viewers.some((v) => v.id !== exceptId && v.name.toLowerCase() === n.toLowerCase())) {
      throw new ViewerError(409, `There is already a viewer called "${n}".`);
    }
    return n;
  }

  _checkColor(color, fallback) {
    if (color === undefined) return fallback;
    if (!COLORS.includes(color)) throw new ViewerError(400, 'Pick one of the offered colors.');
    return color;
  }

  list() {
    const d = this._data();
    return { defaultViewerId: d.defaultViewerId, viewers: d.viewers.map(({ id, name, color }) => ({ id, name, color })) };
  }

  get(id) {
    return this._data().viewers.find((v) => v.id === id) || null;
  }

  getDefault() {
    const d = this._data();
    return d.viewers.find((v) => v.id === d.defaultViewerId);
  }

  /** A viewer by name or id, ignoring case (Xtream usernames), or null. */
  findByName(nameOrId) {
    const n = String(nameOrId ?? '').trim().toLowerCase();
    if (!n) return null;
    return this._data().viewers.find((v) => v.id.toLowerCase() === n || v.name.toLowerCase() === n) || null;
  }

  create({ name, color } = {}) {
    const d = this._data();
    const v = blankViewer(this._checkName(d, name), this._checkColor(color, COLORS[d.viewers.length % COLORS.length]));
    d.viewers.push(v);
    this._save(d);
    return v;
  }

  update(id, { name, color } = {}) {
    return this._mutate(id, (v, d) => {
      if (name !== undefined) v.name = this._checkName(d, name, id);
      v.color = this._checkColor(color, v.color);
    });
  }

  remove(id) {
    const d = this._data();
    if (!d.viewers.some((v) => v.id === id)) throw new ViewerError(404, 'Viewer not found.');
    if (d.viewers.length === 1) throw new ViewerError(409, 'The last viewer cannot be deleted.');
    d.viewers = d.viewers.filter((v) => v.id !== id);
    if (d.defaultViewerId === id) d.defaultViewerId = d.viewers[0].id;
    this._save(d);
  }

  setFilters(id, { disabledGenres, disabledLanguages, showAdult } = {}) {
    const list = (value, label) => {
      if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) throw new ViewerError(400, `${label} must be a list of names.`);
      return [...new Set(value)];
    };
    if (showAdult !== undefined && typeof showAdult !== 'boolean') throw new ViewerError(400, 'showAdult must be true or false.');
    const genres    = disabledGenres    !== undefined ? list(disabledGenres, 'disabledGenres') : undefined;
    const languages = disabledLanguages !== undefined ? list(disabledLanguages, 'disabledLanguages') : undefined;
    return this._mutate(id, (v) => {
      if (genres) v.disabledGenres = genres;
      if (languages) v.disabledLanguages = languages;
      if (showAdult !== undefined) v.showAdult = showAdult;
    });
  }

  /** The FavoritesManager API, reading and writing this viewer's favorites. */
  favoritesOf(id) {
    const fav = Object.create(FavoritesManager.prototype);
    fav._load = () => normalFavorites(this.get(id)?.favorites);
    fav._save = (f) => { this._mutate(id, (v) => { v.favorites = normalFavorites(f); }); };
    return fav;
  }
}

module.exports = ViewersManager;
module.exports.COLORS = COLORS;
module.exports.ViewerError = ViewerError;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/viewers-manager.test.js`
Expected: all pass.

- [ ] **Step 5: Lint and commit**

```bash
cd backend && npm run lint
git add backend/viewers/ViewersManager.js backend/tests/viewers-manager.test.js
git commit -m "feat(viewers): viewers store with per-viewer favorites and filters"
```

---

### Task 2: Viewer context middleware

**Files:**
- Create: `backend/lib/viewerContext.js`
- Test: `backend/tests/viewer-context.test.js`

**Interfaces:**
- Consumes: a viewers store with `get(id)`, `getDefault()`, `findByName(name)` (Task 1).
- Produces: `createViewerContext(viewers) → { middleware(req, res, next), current() → viewer | null }`. After the middleware, `req.viewer` is always a viewer, and `current()` returns it for the rest of the request, across `await`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/viewer-context.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { createViewerContext } from '../lib/viewerContext.js'

const all = [
  { id: 'view_def', name: 'Default' },
  { id: 'view_andy', name: 'Andy' },
  { id: 'view_sam', name: 'Sam' },
]
const store = {
  get: (id) => all.find((v) => v.id === id) ?? null,
  getDefault: () => all[0],
  findByName: (n) => all.find((v) => v.id === String(n).toLowerCase() || v.name.toLowerCase() === String(n).toLowerCase()) ?? null,
}

describe('viewer context', () => {
  let server, base
  beforeAll(async () => {
    const ctx = createViewerContext(store)
    const app = express()
    app.use(express.json())
    app.use(ctx.middleware)
    const answer = async (req, res) => {
      await new Promise((r) => setTimeout(r, 5))
      res.json({ req: req.viewer.id, current: ctx.current()?.id, path: req.path })
    }
    app.get('/player_api.php', answer)
    app.get('/{*rest}', answer)
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server.close())

  const ask = async (path, headers = {}) => (await fetch(base + path, { headers })).json()

  it('uses the default viewer when none is named', async () => {
    expect(await ask('/api/m3u')).toEqual({ req: 'view_def', current: 'view_def', path: '/api/m3u' })
  })

  it('reads the X-Viewer header, and keeps it across await', async () => {
    expect(await ask('/api/favorites', { 'X-Viewer': 'view_andy' })).toMatchObject({ req: 'view_andy', current: 'view_andy' })
  })

  it('reads ?viewer=', async () => {
    expect(await ask('/api/m3u?viewer=view_sam')).toMatchObject({ req: 'view_sam', current: 'view_sam' })
  })

  it('reads a /v/<id>/ path segment and strips it before routing', async () => {
    expect(await ask('/v/view_andy/stremio/manifest.json')).toEqual({ req: 'view_andy', current: 'view_andy', path: '/stremio/manifest.json' })
  })

  it('matches an Xtream username to a viewer name, ignoring case', async () => {
    expect(await ask('/player_api.php?username=sam&password=x')).toMatchObject({ req: 'view_sam' })
    expect(await ask('/player_api.php?username=anyone&password=x')).toMatchObject({ req: 'view_def' })
  })

  it('prefers the header over the query and the path', async () => {
    expect(await ask('/v/view_sam/api/m3u?viewer=view_sam', { 'X-Viewer': 'view_andy' })).toMatchObject({ req: 'view_andy' })
  })

  it('falls back to the default for an unknown or deleted viewer', async () => {
    expect(await ask('/api/m3u?viewer=view_gone')).toMatchObject({ req: 'view_def' })
    expect(await ask('/v/view_gone/stremio/manifest.json')).toMatchObject({ req: 'view_def', path: '/stremio/manifest.json' })
    expect(await ask('/api/favorites', { 'X-Viewer': 'view_gone' })).toMatchObject({ req: 'view_def' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run tests/viewer-context.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`backend/lib/viewerContext.js`:

```js
'use strict';

// Which viewer a request is for (docs/superpowers/specs/2026-10-08-viewer-profiles-design.md).
// First match wins: the X-Viewer header (the website), ?viewer=<id> (playlist
// and guide links), a /v/<id>/ path segment (Stremio, which appends its own
// paths to the addon URL), the Xtream username, else the default viewer. An
// unknown id is never an error — old links and the Android app get the default.
//
// The viewer is kept in an AsyncLocalStorage for the rest of the request, so
// code without the request (lib/catalog.js, appState.getExportFilter) can ask
// for it. Must run after the body parsers: their stream callbacks would
// otherwise run outside the request's context.

const { AsyncLocalStorage } = require('node:async_hooks');

const XTREAM_API = /^\/(?:player_api|get|xmltv|panel_api)\.php$/i;

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function createViewerContext(viewers) {
  const als = new AsyncLocalStorage();

  function pick(req, fromPath) {
    const header = req.get('x-viewer');
    const query  = typeof req.query?.viewer === 'string' ? req.query.viewer : null;
    for (const id of [header, query, fromPath]) {
      const v = id ? viewers.get(String(id)) : null;
      if (v) return v;
    }
    if (XTREAM_API.test(req.path)) {
      const v = viewers.findByName(req.query?.username ?? req.body?.username);
      if (v) return v;
    }
    return viewers.getDefault();
  }

  function middleware(req, res, next) {
    let fromPath = null;
    const m = /^\/v\/([^/?#]+)(.*)$/i.exec(req.url);
    if (m) {
      fromPath = decode(m[1]);
      req.url = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
      req.originalUrl = req.url;
    }
    const viewer = pick(req, fromPath);
    req.viewer = viewer;
    als.run(viewer, () => next());
  }

  return { middleware, current: () => als.getStore() ?? null };
}

module.exports = { createViewerContext };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && npx vitest run tests/viewer-context.test.js`
Expected: all pass.

- [ ] **Step 5: Lint and commit**

```bash
cd backend && npm run lint
git add backend/lib/viewerContext.js backend/tests/viewer-context.test.js
git commit -m "feat(viewers): resolve the viewer for each request"
```

---

### Task 3: Filters follow the viewer

**Files:**
- Create: `backend/lib/viewerFilters.js`
- Modify: `backend/lib/catalog.js:62` (hidden languages)
- Modify: `backend/routes/vod.js:66` (hidden languages)
- Test: `backend/tests/viewer-filters.test.js`

**Interfaces:**
- Consumes: `createViewerContext` (Task 2) `.current()`; `ViewersManager.getDefault()` (Task 1); `buildExportFilter({ profile, showAdult })` (`lib/exportFilter.js`, reads `profile.disabledGenres` / `profile.disabledLanguages`); `toLanguageSet` (`lib/languages.js`).
- Produces: `installViewerFilters(appState, { viewers, context })`, which sets on `appState`:
  - `currentViewer() → viewer`
  - `isDefaultViewer(viewer) → boolean`
  - `getExportFilter() → { keep, key }`
  - `getShowAdult() → boolean`
  - `getHiddenLanguages() → Set<string>`

- [ ] **Step 1: Write the failing test**

`backend/tests/viewer-filters.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { createViewerContext } from '../lib/viewerContext.js'
import { installViewerFilters } from '../lib/viewerFilters.js'

const all = [
  { id: 'view_def', name: 'Default', disabledGenres: [], disabledLanguages: [], showAdult: false },
  { id: 'view_andy', name: 'Andy', disabledGenres: ['Sports'], disabledLanguages: ['FR'], showAdult: true },
]
const viewers = {
  get: (id) => all.find((v) => v.id === id) ?? null,
  getDefault: () => all[0],
  findByName: () => null,
}
const channels = [
  { name: 'ESPN', genre: 'Sports' },
  { name: 'TF1', genre: 'FR | General' },
  { name: 'Hot', genre: 'Adult' },
  { name: 'CNN', genre: 'News' },
]

describe('viewer filters', () => {
  let server, base
  beforeAll(async () => {
    const context = createViewerContext(viewers)
    const appState = {}
    installViewerFilters(appState, { viewers, context })
    const app = express()
    app.use(context.middleware)
    app.get('/shown', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 5)) // the filter is read after an await
      res.json({
        names: channels.filter(appState.getExportFilter().keep).map((c) => c.name),
        adult: appState.getShowAdult(),
        languages: [...appState.getHiddenLanguages()],
        isDefault: appState.isDefaultViewer(appState.currentViewer()),
      })
    })
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server.close())

  it('uses the default viewer\'s filters when no viewer is named', async () => {
    const r = await (await fetch(`${base}/shown`)).json()
    expect(r).toEqual({ names: ['ESPN', 'TF1', 'CNN'], adult: false, languages: [], isDefault: true })
  })

  it('uses the named viewer\'s filters', async () => {
    const r = await (await fetch(`${base}/shown?viewer=view_andy`)).json()
    expect(r.names).toEqual(['Hot', 'CNN'])
    expect(r.adult).toBe(true)
    expect(r.languages.length).toBe(1)
    expect(r.isDefault).toBe(false)
  })

  it('gives each viewer its own filter key, so filtered caches are not shared', () => {
    // Outside a request: the default viewer.
    const appState = {}
    installViewerFilters(appState, { viewers, context: { current: () => all[1] } })
    const andyKey = appState.getExportFilter().key
    installViewerFilters(appState, { viewers, context: { current: () => null } })
    expect(appState.getExportFilter().key).not.toBe(andyKey)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run tests/viewer-filters.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `backend/lib/viewerFilters.js`**

```js
'use strict';

// The channel filters for whoever is asking: the current viewer's hidden genres
// and languages and Show Adult (lib/viewerContext.js), or the default viewer's
// outside a request. Installed on appState so the exports, the Xtream API, the
// Stremio addon and the VOD category list (all of which call these hooks)
// follow the viewer without knowing about viewers.

const { buildExportFilter } = require('./exportFilter');
const { toLanguageSet } = require('./languages');

function installViewerFilters(appState, { viewers, context }) {
  const current = () => context.current() ?? viewers.getDefault();
  appState.currentViewer      = current;
  appState.isDefaultViewer    = (v) => !!v && v.id === viewers.getDefault()?.id;
  appState.getExportFilter    = () => {
    const v = current();
    return buildExportFilter({ profile: v, showAdult: v?.showAdult === true });
  };
  appState.getShowAdult       = () => current()?.showAdult === true;
  appState.getHiddenLanguages = () => toLanguageSet(current()?.disabledLanguages);
}

module.exports = { installViewerFilters };
```

- [ ] **Step 4: Point the catalog and VOD categories at the viewer**

In `backend/lib/catalog.js`, replace:

```js
  const hiddenLanguages = () => appState.profilesManager?.activeDisabledLanguages?.() ?? new Set();
```

with:

```js
  const hiddenLanguages = () => appState.getHiddenLanguages?.() ?? new Set();
```

In `backend/routes/vod.js`, replace:

```js
    const hidden = appState.profilesManager?.activeDisabledLanguages() ?? new Set();
```

with:

```js
    const hidden = appState.getHiddenLanguages?.() ?? new Set();
```

and change that route's comment line "Filtered by the active profile's hidden languages." to "Filtered by the current viewer's hidden languages."

Then check whether `tests/vod-categories.test.js` mocks `profilesManager.activeDisabledLanguages`:

Run: `cd backend && grep -n "activeDisabledLanguages\|getHiddenLanguages" tests/*.js`

For each mock found, replace `profilesManager: { activeDisabledLanguages: () => X }` with `getHiddenLanguages: () => X` (same value).

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx vitest run`
Expected: all pass (the new test plus the existing suite).

- [ ] **Step 6: Lint and commit**

```bash
cd backend && npm run lint
git add backend/lib/viewerFilters.js backend/lib/catalog.js backend/routes/vod.js backend/tests/
git commit -m "feat(viewers): channel filters follow the current viewer"
```

---

### Task 4: Viewers API and per-viewer favorites routes

**Files:**
- Create: `backend/routes/viewers.js`
- Modify: `backend/routes/favorites.js`
- Test: `backend/tests/viewers-routes.test.js`

**Interfaces:**
- Consumes: `ViewersManager` (Task 1), `createViewerContext` (Task 2). `req.viewer` is set by the middleware.
- Produces:
  - `require('./routes/viewers')(viewers) → Router` mounted at `/api/viewers`:
    - `GET /` → `{ defaultViewerId, viewers: [{ id, name, color }] }`
    - `POST /` `{ name, color? }` → `{ id, name, color }`
    - `GET /me` → `{ id, name, color, isDefault, disabledGenres, disabledLanguages, showAdult }`
    - `PUT /me/filters` `{ disabledGenres?, disabledLanguages?, showAdult? }` → same shape as `/me`
    - `PUT /:id` `{ name?, color? }` → `{ id, name, color }`
    - `DELETE /:id` → `{ success: true }`
    - errors: `{ error }` with 400 / 404 / 409, or 500 when saving failed
  - `require('./routes/favorites')(viewers, appState)` — same endpoints as today, scoped to `req.viewer`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/viewers-routes.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import ViewersManager from '../viewers/ViewersManager.js'
import { createViewerContext } from '../lib/viewerContext.js'
import viewersModule from '../routes/viewers.js'
import favoritesModule from '../routes/favorites.js'

describe('viewers API and favorites', () => {
  let server, base, dir, viewers

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-viewer-routes-'))
    viewers = new ViewersManager(dir)
    viewers.ensureInitialized({ favorites: { channels: ['1'] } })
    const context = createViewerContext(viewers)
    // Connected, with every channel known, so the favorites list is served.
    const appState = {
      sessionManager: { isAuthenticated: () => true },
      channelManager: {
        getChannels: () => [{ uniqueId: '1' }, { uniqueId: '2' }],
        getChannel: (id) => ({ uniqueId: String(id), name: `Ch ${id}` }),
        getProgress: () => ({ loading: false }),
        resolveLegacyId: () => null,
      },
    }
    const app = express()
    app.use(express.json())
    app.use(context.middleware)
    app.use('/api/viewers', viewersModule(viewers))
    app.use('/api/favorites', favoritesModule(viewers, appState))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const call = async (method, p, body, viewer) => {
    const headers = { 'Content-Type': 'application/json', ...(viewer ? { 'X-Viewer': viewer } : {}) }
    const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json() }
  }

  it('lists, creates, renames and deletes viewers', async () => {
    const created = await call('POST', '/api/viewers', { name: 'Andy' })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ name: 'Andy' })
    expect(Object.keys(created.body).sort()).toEqual(['color', 'id', 'name'])

    const list = await call('GET', '/api/viewers')
    expect(list.body.viewers.map((v) => v.name)).toEqual(['Default', 'Andy'])

    expect((await call('PUT', `/api/viewers/${created.body.id}`, { name: 'Andrew' })).body.name).toBe('Andrew')
    expect((await call('POST', '/api/viewers', { name: 'andrew' })).status).toBe(409)
    expect((await call('POST', '/api/viewers', { name: '' })).status).toBe(400)
    expect((await call('DELETE', '/api/viewers/view_missing')).status).toBe(404)
    expect((await call('DELETE', `/api/viewers/${created.body.id}`)).body).toEqual({ success: true })
  })

  it('refuses to delete the last viewer', async () => {
    const only = (await call('GET', '/api/viewers')).body.viewers
    expect(only.length).toBe(1)
    const r = await call('DELETE', `/api/viewers/${only[0].id}`)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/last viewer/)
  })

  it('reads and saves the current viewer\'s filters', async () => {
    const sam = (await call('POST', '/api/viewers', { name: 'Sam' })).body
    expect((await call('GET', '/api/viewers/me')).body).toMatchObject({ name: 'Default', isDefault: true })
    const saved = await call('PUT', '/api/viewers/me/filters', { disabledGenres: ['Sports'], showAdult: true }, sam.id)
    expect(saved.body).toMatchObject({ id: sam.id, isDefault: false, disabledGenres: ['Sports'], showAdult: true })
    expect((await call('GET', '/api/viewers/me')).body.disabledGenres).toEqual([])
    expect((await call('PUT', '/api/viewers/me/filters', { showAdult: 'yes' }, sam.id)).status).toBe(400)
  })

  it('keeps favorites apart per viewer, and old clients get the default viewer\'s', async () => {
    const kim = (await call('POST', '/api/viewers', { name: 'Kim' })).body
    await call('POST', '/api/favorites/channels', { uniqueId: '2' }, kim.id)
    const kimFavs = (await call('GET', '/api/favorites', null, kim.id)).body.channels.map((c) => c.uniqueId)
    const defaultFavs = (await call('GET', '/api/favorites')).body.channels.map((c) => c.uniqueId)
    expect(kimFavs).toEqual(['2'])
    expect(defaultFavs).toEqual(['1'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run tests/viewers-routes.test.js`
Expected: FAIL — `routes/viewers.js` not found.

- [ ] **Step 3: Implement `backend/routes/viewers.js`**

```js
// routes/viewers.js
// GET    /api/viewers              — { defaultViewerId, viewers: [{ id, name, color }] }
// POST   /api/viewers              — { name, color? } create
// GET    /api/viewers/me           — the viewer this request is for, with its filters
// PUT    /api/viewers/me/filters   — { disabledGenres?, disabledLanguages?, showAdult? }
// PUT    /api/viewers/:id          — { name?, color? }
// DELETE /api/viewers/:id          — not the last one

'use strict';

const express = require('express');
const { ViewerError } = require('../viewers/ViewersManager');
const log = require('../logger');
const TAG = 'viewers';

const summary = ({ id, name, color }) => ({ id, name, color });

module.exports = function viewersModule(viewers) {
  const router = express.Router();

  const details = (v) => ({
    ...summary(v),
    isDefault: v.id === viewers.getDefault()?.id,
    disabledGenres: v.disabledGenres ?? [],
    disabledLanguages: v.disabledLanguages ?? [],
    showAdult: v.showAdult === true,
  });

  // Runs a change and answers with its result, or with the error it raised.
  function answer(res, fn) {
    try {
      res.json(fn());
    } catch (e) {
      if (e instanceof ViewerError) return res.status(e.status).json({ error: e.message });
      log.error(TAG, e.message);
      res.status(500).json({ error: 'The viewers could not be saved.' });
    }
  }

  router.get('/', (_req, res) => answer(res, () => viewers.list()));
  router.post('/', (req, res) => answer(res, () => summary(viewers.create(req.body ?? {}))));
  router.get('/me', (req, res) => answer(res, () => details(viewers.get(req.viewer.id) ?? viewers.getDefault())));
  router.put('/me/filters', (req, res) => answer(res, () => details(viewers.setFilters(req.viewer.id, req.body ?? {}))));
  router.put('/:id', (req, res) => answer(res, () => summary(viewers.update(req.params.id, req.body ?? {}))));
  router.delete('/:id', (req, res) => answer(res, () => { viewers.remove(req.params.id); return { success: true }; }));

  return router;
};
```

- [ ] **Step 4: Scope `backend/routes/favorites.js` to the viewer**

Change the module signature and every `favoritesManager.` call:

```js
module.exports = function favoritesModule(viewers, appState) {
  const router = express.Router();
  const guard = sessionMiddleware(appState);
  // This request's viewer's favorites (lib/viewerContext.js sets req.viewer).
  const favs = (req) => viewers.favoritesOf(req.viewer.id);
```

Replace `migrateFavoriteIdsOnce()` with a per-viewer version (keep the existing comment above it, and add one line: "Tracked per viewer, since each has its own list."):

```js
  function migrateFavoriteIdsOnce(req) {
    const cm = appState?.channelManager;
    if (!cm) return;
    cm._favoriteIdsMigrated ??= new Set();
    if (cm._favoriteIdsMigrated.has(req.viewer.id)) return;
    // A partial list would leave genuinely-unknown ids untouched, which is
    // right, but don't mark it done until the full list is in.
    if (cm.getProgress?.().loading || cm.getChannels().length === 0) return;
    try {
      favs(req).migrateLegacyIds(id => cm.resolveLegacyId(id));
      cm._favoriteIdsMigrated.add(req.viewer.id);
    } catch (e) {
      log.warn(TAG, `favorite id migration failed: ${e.message}`);
    }
  }
```

In the `GET /` handler: change `(_req, res)` to `(req, res)`, call `migrateFavoriteIdsOnce(req)`, and read `const raw = favs(req).getRaw();`.

In every other handler, replace `favoritesManager.<method>(` with `favs(req).<method>(` (handlers already take `req`). The full list to change: `addChannel`, `removeChannel`, `createGroup`, `renameGroup`, `deleteGroup`, `addChannelToGroup`, `reorderChannels`, `reorderGroups`, `removeChannelFromGroup`.

Verify none are left:

Run: `cd backend && grep -n "favoritesManager" routes/favorites.js`
Expected: no output.

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx vitest run`
Expected: all pass.

- [ ] **Step 6: Lint and commit**

```bash
cd backend && npm run lint
git add backend/routes/viewers.js backend/routes/favorites.js backend/tests/viewers-routes.test.js
git commit -m "feat(viewers): viewers API and per-viewer favorites"
```

---

### Task 5: Wire into the server; settings, Stremio and Xtream

**Files:**
- Modify: `backend/server.js` (around lines 80–101 for managers and filters, 153–155 for middleware, 307 for favorites routes, 327–347 for mounting)
- Modify: `backend/routes/settings.js` (drop `show_adult`)
- Modify: `backend/routes/stremio.js:146-148` (manifest id and name)
- Modify: `backend/tests/stremio.test.js`, `backend/tests/idle-timeout-settings.test.js`

**Interfaces:**
- Consumes: Tasks 1–4. `appState.currentViewer()` and `appState.isDefaultViewer(v)` (Task 3).
- Produces: a running server where every request has a viewer; `/api/viewers` mounted; the Stremio manifest for a non-default viewer has id `com.stalkerweb.addon.<viewerId>` and name `StalkerWeb (<name>)`.

- [ ] **Step 1: Write the failing Stremio test**

In `backend/tests/stremio.test.js`, after the existing manifest test (the one asserting `id: 'com.stalkerweb.addon'`), add:

```js
  it('gives a non-default viewer its own addon id and name, so both can be installed', async () => {
    appState.currentViewer = () => ({ id: 'view_andy', name: 'Andy' })
    appState.isDefaultViewer = () => false
    try {
      const m = await get('/manifest.json')
      expect(m).toMatchObject({ id: 'com.stalkerweb.addon.view_andy', name: 'StalkerWeb (Andy)' })
    } finally {
      delete appState.currentViewer
      delete appState.isDefaultViewer
    }
    expect((await get('/manifest.json')).id).toBe('com.stalkerweb.addon')
  })
```

Run: `cd backend && npx vitest run tests/stremio.test.js`
Expected: the new test FAILS (id is `com.stalkerweb.addon`).

- [ ] **Step 2: Implement the manifest change**

In `backend/routes/stremio.js`, in the `/manifest.json` handler before `res.set('Cache-Control', 'no-cache');`, add:

```js
    // Each viewer installs their own copy (their favorites' filters); the
    // default viewer keeps the original id so existing installs carry on.
    const viewer = appState.currentViewer?.();
    const own = viewer && appState.isDefaultViewer && !appState.isDefaultViewer(viewer);
```

and change the two lines:

```js
      id: 'com.stalkerweb.addon',
      ...
      name: 'StalkerWeb',
```

to:

```js
      id: own ? `com.stalkerweb.addon.${viewer.id}` : 'com.stalkerweb.addon',
      ...
      name: own ? `StalkerWeb (${viewer.name})` : 'StalkerWeb',
```

Run: `cd backend && npx vitest run tests/stremio.test.js`
Expected: all pass.

- [ ] **Step 3: Drop `show_adult` from the shared settings**

In `backend/routes/settings.js`:
- remove `show_adult: false,` from `DEFAULTS`;
- remove the `show_adult:` line from the GET response;
- remove `show_adult` from the POST destructuring and delete the line `if (show_adult !== undefined) existing.show_adult = !!show_adult;`.

Leave any `show_adult` already saved in the file alone (the spec keeps old fields on disk).

In `backend/tests/idle-timeout-settings.test.js`, the test "leaves the timeout alone when saving other settings" posts `{ show_adult: true }`; change it to `{ epg_enabled: false }` so it still saves another setting.

- [ ] **Step 4: Wire the server**

In `backend/server.js`:

1. After the `ProfilesManager` lines (around line 87), add:

```js
// Viewers: each person's favorites and channel filters (viewers/ViewersManager.js).
// On the first start after the upgrade, the Default viewer takes over what was
// shared: the favorites, Show Adult, and the active profile's hidden genres and
// languages. The old files and fields are left in place.
const ViewersManager = require('./viewers/ViewersManager');
const viewersManager = new ViewersManager(config.dataDir);
{
  const legacy = profilesManager.getActive();
  viewersManager.ensureInitialized({
    favorites:         favoritesManager.getRaw(),
    showAdult:         new (require('./cache/CacheManager'))(config.dataDir).load()?.show_adult === true,
    disabledGenres:    legacy?.disabledGenres,
    disabledLanguages: legacy?.disabledLanguages,
  });
}
const viewerContext = require('./lib/viewerContext').createViewerContext(viewersManager);
```

2. Replace the block that defines `appState.getExportFilter` and `appState.getShowAdult` (the comment "Filter applied to the M3U / XMLTV / XSPF exports…", the `buildExportFilter` require, and both assignments) with:

```js
// Filter applied to the exports, the Xtream API, the Stremio addon and the VOD
// categories: the current viewer's hidden genres and languages, plus adult
// channels unless that viewer shows them (lib/viewerFilters.js).
require('./lib/viewerFilters').installViewerFilters(appState, { viewers: viewersManager, context: viewerContext });
```

Keep `exportSettingsCache` only if something else still uses it (`appState.getLiveBufferSeconds` does — keep the `const exportSettingsCache = …` line).

3. After `app.use(access.stripPrefix);` add:

```js
// Which viewer each request is for — after the access prefix (links look like
// /k/<token>/v/<viewer>/…) and before the gate, which checks the stripped path.
app.use(viewerContext.middleware);
```

4. Change the favorites routes line to:

```js
const favoritesRoutes = require('./routes/favorites')(viewersManager, appState);
```

5. Add with the other route modules:

```js
const viewersRoutes   = require('./routes/viewers')(viewersManager);
```

and mount it next to `/api/profiles`:

```js
app.use('/api/viewers', viewersRoutes);
```

`/api/viewers` is under the `api` root, which `lib/access.js` already treats as full access — no change there.

- [ ] **Step 5: Smoke-test the server**

Run (Git Bash), from the repo root:

```bash
cd backend && DATA_DIR="$(mktemp -d)" PORT=18999 node server.js > /tmp/sw-smoke.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:18999/api/viewers
curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"Andy"}' http://127.0.0.1:18999/api/viewers
curl -s http://127.0.0.1:18999/api/viewers/me
kill %1
```

Before running, check the env var name for the data folder: `grep -n "dataDir" backend/config.js`, and use that name in place of `DATA_DIR` if it differs.

Expected: the first call lists one `Default` viewer; the POST returns `{ id, name: "Andy", color }`; `/me` returns Default with `isDefault: true`. The log shows `created the Default viewer`.

- [ ] **Step 6: Full backend suite, lint, commit**

```bash
cd backend && npx vitest run && npm run lint
git add backend/
git commit -m "feat(viewers): wire viewers into the server, Stremio and settings"
```

---

### Task 6: Frontend API and saved viewer

**Files:**
- Create: `frontend/src/lib/viewer.js`
- Test: `frontend/src/lib/viewer.test.js`
- Modify: `frontend/src/stalkerApi.js`

**Interfaces:**
- Consumes: the `/api/viewers` API (Task 4).
- Produces:
  - `getViewerId() → string | null`, `setViewerId(id | null)`
  - `chooseViewer(viewers, savedId) → { id: string | null, needsPicker: boolean }`
  - `viewerQuery(viewer) → ''` for the default viewer, else `?viewer=<id>`
  - `viewerPath(viewer) → ''` for the default viewer, else `/v/<id>`
  - in `stalkerApi.js`: `getViewers()`, `createViewer(body)`, `updateViewer(id, body)`, `deleteViewer(id)`, `getMyViewer()`, `saveMyFilters(body)`; every request sends `X-Viewer` when a viewer is saved.

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/viewer.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { chooseViewer, viewerQuery, viewerPath } from './viewer'

const a = { id: 'view_a', name: 'Andy' }
const b = { id: 'view_b', name: 'Sam' }

describe('chooseViewer', () => {
  it('keeps the saved viewer while it exists', () => {
    expect(chooseViewer([a, b], 'view_b')).toEqual({ id: 'view_b', needsPicker: false })
  })

  it('picks the only viewer without asking', () => {
    expect(chooseViewer([a], null)).toEqual({ id: 'view_a', needsPicker: false })
    expect(chooseViewer([a], 'view_gone')).toEqual({ id: 'view_a', needsPicker: false })
  })

  it('asks when there are several and none is saved, or the saved one was deleted', () => {
    expect(chooseViewer([a, b], null)).toEqual({ id: null, needsPicker: true })
    expect(chooseViewer([a, b], 'view_gone')).toEqual({ id: null, needsPicker: true })
  })
})

describe('viewer links', () => {
  it('leaves the default viewer\'s links as they were', () => {
    expect(viewerQuery({ id: 'view_a', isDefault: true })).toBe('')
    expect(viewerPath({ id: 'view_a', isDefault: true })).toBe('')
    expect(viewerQuery(null)).toBe('')
  })

  it('adds the viewer to other viewers\' links', () => {
    expect(viewerQuery({ id: 'view_b', isDefault: false })).toBe('?viewer=view_b')
    expect(viewerPath({ id: 'view_b', isDefault: false })).toBe('/v/view_b')
  })
})
```

Run: `cd frontend && npx vitest run src/lib/viewer.test.js`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `frontend/src/lib/viewer.js`**

```js
// The viewer this device is watching as (Settings → Viewers). Saved per
// device; the server falls back to its default viewer for an id it doesn't
// know, so a stale value never breaks a request.
const KEY = 'sw:viewer'

export function getViewerId() {
  try { return localStorage.getItem(KEY) || null } catch { return null }
}

export function setViewerId(id) {
  try {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
  } catch { /* storage blocked — the server's default viewer is used */ }
}

// Which viewer to use on startup: the saved one while it still exists, the
// only one when there is just one, otherwise ask ("Who's watching?").
export function chooseViewer(viewers, savedId) {
  if (savedId && viewers.some(v => v.id === savedId)) return { id: savedId, needsPicker: false }
  if (viewers.length === 1) return { id: viewers[0].id, needsPicker: false }
  return { id: null, needsPicker: true }
}

// Links for players outside the browser. The default viewer's links stay as
// they always were, so links handed out before viewers existed keep working.
export const viewerQuery = (viewer) => (viewer && !viewer.isDefault ? `?viewer=${encodeURIComponent(viewer.id)}` : '')
export const viewerPath  = (viewer) => (viewer && !viewer.isDefault ? `/v/${encodeURIComponent(viewer.id)}` : '')
```

- [ ] **Step 3: Send the viewer with every API call**

In `frontend/src/stalkerApi.js`, add the import at the top:

```js
import { getViewerId } from './lib/viewer'
```

and in `_fetch`, replace:

```js
    const r = await fetch(BASE + path, { ...opts, signal: controller.signal })
```

with:

```js
    const viewer = getViewerId()
    const headers = viewer ? { ...opts.headers, 'X-Viewer': viewer } : opts.headers
    const r = await fetch(BASE + path, { ...opts, headers, signal: controller.signal })
```

After the `// ── Settings` block, add:

```js
// ── Viewers ───────────────────────────────────────────────────────────────
// Each person's favorites and channel filters (backend routes/viewers.js).
// "me" is whichever viewer this device sends in X-Viewer.
export const getViewers    = () => _get('/viewers')
export const createViewer  = (body) => _post('/viewers', body)
export const updateViewer  = (id, body) => _put(`/viewers/${encodeURIComponent(id)}`, body)
export const deleteViewer  = (id) => _delete(`/viewers/${encodeURIComponent(id)}`)
export const getMyViewer   = () => _get('/viewers/me')
export const saveMyFilters = (body) => _put('/viewers/me/filters', body)
```

- [ ] **Step 4: Test, lint, commit**

```bash
cd frontend && npx vitest run && npm run lint
git add frontend/src/lib/viewer.js frontend/src/lib/viewer.test.js frontend/src/stalkerApi.js
git commit -m "feat(viewers): send the device's viewer with every API call"
```

---

### Task 7: Who's watching? picker and the viewer in the app

**Files:**
- Create: `frontend/src/components/ViewerPicker.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: Task 6 (`getViewerId`, `setViewerId`, `chooseViewer`, `getViewers`, `createViewer`, `getMyViewer`); `invalidateFavoritesCache` (`lib/useFavorites.js`).
- Produces in the app context (`useApp()`):
  - `viewer` — `{ id, name, color, isDefault, disabledGenres, disabledLanguages, showAdult }` or null
  - `viewers` — `[{ id, name, color }]`
  - `refreshViewers() → Promise<void>` — reloads the list and the current viewer
  - `switchViewer(id) → Promise<void>`
  - `openViewerPicker()`
  - `applyViewer(me)` — puts a `/me`-shaped object into `viewer`, `showAdult`, `disabledGenres`, `disabledLanguages`
  - `ViewerPicker` props: `{ viewers, onPick(id), onCreate(name) → Promise, onClose?: () => void }`

- [ ] **Step 1: Create `frontend/src/components/ViewerPicker.jsx`**

```jsx
import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'

// "Who's watching?" — full-screen, on a device that hasn't picked a viewer
// yet (or whose viewer was deleted), and from the sidebar to switch. Tiles
// are plain buttons in a row, so arrow keys / Tab and Enter work on a TV.
export function ViewerAvatar({ viewer, size = 32 }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold text-white shrink-0"
      style={{ background: viewer?.color || 'var(--color-surface-3)', width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {(viewer?.name || '?').slice(0, 1).toUpperCase()}
    </span>
  )
}

export default function ViewerPicker({ viewers, onPick, onCreate, onClose }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const first = useRef(null)

  useEffect(() => { first.current?.focus() }, [])

  // Left/Right move between tiles, like a TV launcher.
  function onKeyDown(e) {
    if (e.key === 'Escape' && onClose) { onClose(); return }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const tiles = [...e.currentTarget.querySelectorAll('[data-tile]')]
    const i = tiles.indexOf(document.activeElement)
    if (i < 0) return
    e.preventDefault()
    tiles[(i + (e.key === 'ArrowRight' ? 1 : tiles.length - 1)) % tiles.length].focus()
  }

  async function add(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onCreate(name.trim())
      setAdding(false)
      setName('')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-8 bg-[var(--color-bg)] px-4" role="dialog" aria-modal="true" aria-label="Who's watching?" onKeyDown={onKeyDown}>
      {onClose && (
        <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]" aria-label="Close">
          <X size={18} />
        </button>
      )}
      <h1 className="text-2xl font-semibold text-[var(--color-text)]">Who&apos;s watching?</h1>

      <div className="flex flex-wrap justify-center gap-4 max-w-3xl">
        {viewers.map((v, i) => (
          <button
            key={v.id}
            ref={i === 0 ? first : undefined}
            data-tile
            onClick={() => onPick(v.id)}
            className="flex flex-col items-center gap-2 w-28 p-3 rounded-[var(--radius-md)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            <ViewerAvatar viewer={v} size={72} />
            <span className="text-sm text-[var(--color-text)] truncate max-w-full">{v.name}</span>
          </button>
        ))}
        {!adding && (
          <button
            data-tile
            onClick={() => setAdding(true)}
            className="flex flex-col items-center gap-2 w-28 p-3 rounded-[var(--radius-md)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            <span className="flex items-center justify-center w-[72px] h-[72px] rounded-full border-2 border-dashed border-[var(--color-border)]">
              <Plus size={28} />
            </span>
            <span className="text-sm">Add viewer</span>
          </button>
        )}
      </div>

      {adding && (
        <form onSubmit={add} className="flex flex-col items-center gap-2 w-full max-w-xs">
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={30}
            placeholder="Name"
            aria-label="New viewer's name"
            className="w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)]"
          />
          {error && <p className="text-xs text-[var(--color-live)]">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={!name.trim() || saving} className="px-4 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] text-sm font-medium disabled:opacity-50">Add</button>
            <button type="button" onClick={() => { setAdding(false); setError(null) }} className="px-4 py-1.5 rounded-[var(--radius-sm)] text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]">Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Viewer state in `AppInner` (`frontend/src/App.jsx`)**

Imports — add:

```js
import ViewerPicker, { ViewerAvatar } from '@/components/ViewerPicker'
import { getViewerId, setViewerId, chooseViewer } from '@/lib/viewer'
import { invalidateFavoritesCache } from '@/lib/useFavorites'
```

and add `getViewers, createViewer, getMyViewer` to the existing `stalkerApi` import. Remove `getActiveProfileId, getProfileGenres` from the `@/lib/profiles` import (keep `fetchProfiles`).

State — after the `disabledLanguages` state line add:

```js
  const [viewer, setViewer]   = useState(null)   // /api/viewers/me
  const [viewers, setViewers] = useState([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerRequired, setPickerRequired] = useState(false)
```

Helpers — after `updateIdleInfo`, add:

```js
  // The viewer's own filters drive every channel list (Channels, Guide, Player).
  function applyViewer(me) {
    setViewer(me)
    setShowAdult(!!me.showAdult)
    setDisabledGenres(new Set(me.disabledGenres ?? []))
    setDisabledLanguages(new Set(me.disabledLanguages ?? []))
  }

  async function refreshViewers() {
    const [list, me] = await Promise.all([getViewers(), getMyViewer()])
    setViewers(list.viewers)
    applyViewer(me)
  }

  async function switchViewer(id) {
    setViewerId(id)
    invalidateFavoritesCache()
    applyViewer(await getMyViewer())
    setPickerOpen(false)
    setPickerRequired(false)
  }

  async function addViewerFromPicker(name) {
    const v = await createViewer({ name })
    await switchViewer(v.id)
    setViewers((await getViewers()).viewers)
  }
```

Startup — in `load()`, replace:

```js
        const [status, settings] = await Promise.all([getStatus(), getSettings(), fetchProfiles().catch(() => {})])
```

with:

```js
        const [status, settings, list] = await Promise.all([getStatus(), getSettings(), getViewers(), fetchProfiles().catch(() => {})])
        const pick = chooseViewer(list.viewers, getViewerId())
        setViewerId(pick.id)
        setViewers(list.viewers)
        if (pick.needsPicker) { setPickerRequired(true); setPickerOpen(true) }
        applyViewer(await getMyViewer())
```

and delete these lines further down in the same `try`:

```js
        setShowAdult(!!settings.show_adult)
        // Genre filters are strictly per-profile — an empty list means "no
        // filters", not "inherit".
        const activeId = getActiveProfileId()
        setDisabledGenres(new Set(activeId ? getProfileGenres(activeId) : []))
```

Context — replace the `ctxValue` memo with:

```js
  const ctxValue = useMemo(
    () => ({ connected, setConnected, epgEnabled, setEpgEnabled, showAdult, setShowAdult, disabledGenres, setDisabledGenres, disabledLanguages, setDisabledLanguages, setLastPingAt, setIdleInfo,
      viewer, viewers, refreshViewers, switchViewer, applyViewer, openViewerPicker: () => setPickerOpen(true) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the functions only call setters
    [connected, epgEnabled, showAdult, disabledGenres, disabledLanguages, viewer, viewers]
  )
```

(If the repo's ESLint config has no `react-hooks` plugin, drop the disable comment — check with `npm run lint`.)

Render — just inside `<TooltipProvider>`, before `<Sidebar`, add:

```jsx
        {pickerOpen && (
          <ViewerPicker
            viewers={viewers}
            onPick={switchViewer}
            onCreate={addViewerFromPicker}
            onClose={pickerRequired ? undefined : () => setPickerOpen(false)}
          />
        )}
```

Pass the viewer to the sidebar: add `viewer={viewer}` and `onSwitchViewer={() => setPickerOpen(true)}` to the `<Sidebar` props.

Remount pages on a switch, so they reload that viewer's favorites: change `<Routes>` to `<Routes key={viewer?.id ?? 'none'}>`.

- [ ] **Step 3: The viewer in the sidebar footer**

Change the `Sidebar` signature to accept `viewer, onSwitchViewer`:

```js
function Sidebar({ connected, epgEnabled, lastPingAt, idleInfo, version, accessEnabled, collapsed, onToggle, mobileOpen, onCloseMobile, viewer, onSwitchViewer }) {
```

In the footer, directly before `<NavItem to="/settings" …/>`, add:

```jsx
          {viewer && (
            <button
              onClick={() => { onCloseMobile?.(); onSwitchViewer() }}
              title="Switch viewer"
              aria-label={`Watching as ${viewer.name}. Switch viewer`}
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-md)] text-sm font-medium h-10 text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]/70 transition-all duration-150',
                collapsed ? 'justify-center w-10 mx-auto' : 'px-3 w-full'
              )}
            >
              <ViewerAvatar viewer={viewer} size={22} />
              {!collapsed && <span className="truncate">{viewer.name}</span>}
            </button>
          )}
```

- [ ] **Step 4: Lint, test, build**

```bash
cd frontend && npm run lint && npx vitest run && npm run build
```

Expected: no lint warnings, tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ViewerPicker.jsx frontend/src/App.jsx
git commit -m "feat(viewers): Who's watching? picker and the viewer in the sidebar"
```

---

### Task 8: Settings — My channels, Viewers, links

**Files:**
- Create: `frontend/src/components/ViewersCard.jsx`
- Modify: `frontend/src/pages/SetupPage.jsx`

**Interfaces:**
- Consumes: `useApp()` → `viewer, viewers, refreshViewers, switchViewer, applyViewer` (Task 7); `createViewer, updateViewer, deleteViewer, saveMyFilters` (Task 6); `viewerQuery, viewerPath` (Task 6).
- Produces: `ViewersCard` (no props; reads the app context). The palette must match `ViewersManager.COLORS` (Task 1).

- [ ] **Step 1: Create `frontend/src/components/ViewersCard.jsx`**

```jsx
import { useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/appContext'
import { createViewer, updateViewer, deleteViewer } from '../stalkerApi'
import { ViewerAvatar } from './ViewerPicker'

// Same list as backend viewers/ViewersManager.js COLORS.
const COLORS = ['#5b8def', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e93d82', '#978365']

// Settings → Viewers: the people who watch here, each with their own
// favorites and channel filters. Everything else on this page is shared.
export default function ViewersCard() {
  const { viewer, viewers, refreshViewers, switchViewer } = useApp()
  const [editing, setEditing] = useState(null) // { id, name, color } | { id: null, name: '', color } for a new one
  const [error, setError] = useState(null)

  async function save() {
    setError(null)
    try {
      if (editing.id) await updateViewer(editing.id, { name: editing.name, color: editing.color })
      else await createViewer({ name: editing.name, color: editing.color })
      setEditing(null)
      await refreshViewers()
    } catch (err) {
      setError(err.message)
    }
  }

  async function remove(v) {
    if (!window.confirm(`Delete ${v.name}? Their favorites and channel filters are deleted too.`)) return
    setError(null)
    try {
      await deleteViewer(v.id)
      // Deleting yourself: carry on as whoever is left first.
      if (v.id === viewer?.id) await switchViewer(viewers.find(x => x.id !== v.id).id)
      await refreshViewers()
    } catch (err) {
      setError(err.message)
    }
  }

  const editor = editing && (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
      <input
        autoFocus
        value={editing.name}
        onChange={e => setEditing({ ...editing, name: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(null) }}
        maxLength={30}
        placeholder="Name"
        aria-label="Viewer name"
        className="rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)]"
      />
      <div className="flex gap-2" role="radiogroup" aria-label="Color">
        {COLORS.map(c => (
          <button
            key={c}
            role="radio"
            aria-checked={editing.color === c}
            aria-label={c}
            onClick={() => setEditing({ ...editing, color: c })}
            className={cn('h-6 w-6 rounded-full ring-offset-2 ring-offset-[var(--color-surface)]', editing.color === c && 'ring-2 ring-[var(--color-text)]')}
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={save} disabled={!editing.name.trim()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] text-xs font-medium disabled:opacity-50"><Check size={13} /> Save</button>
        <button onClick={() => { setEditing(null); setError(null) }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"><X size={13} /> Cancel</button>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-2">
      {viewers.map(v => (
        editing?.id === v.id ? <div key={v.id}>{editor}</div> : (
          <div key={v.id} className="flex items-center gap-3 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-[var(--color-surface-2)]/60">
            <ViewerAvatar viewer={v} size={28} />
            <span className="text-sm text-[var(--color-text)] truncate">{v.name}</span>
            {v.id === viewer?.id && <span className="text-[11px] text-[var(--color-muted)]">· you</span>}
            <div className="ml-auto flex gap-1">
              <button onClick={() => setEditing({ id: v.id, name: v.name, color: v.color })} className="p-1.5 rounded text-[var(--color-muted)] hover:text-[var(--color-text)]" title="Rename or recolor" aria-label={`Edit ${v.name}`}><Pencil size={14} /></button>
              {viewers.length > 1 && (
                <button onClick={() => remove(v)} className="p-1.5 rounded text-[var(--color-muted)] hover:text-[var(--color-live)]" title="Delete" aria-label={`Delete ${v.name}`}><Trash2 size={14} /></button>
              )}
            </div>
          </div>
        )
      ))}
      {editing && !editing.id ? editor : (
        <button
          onClick={() => setEditing({ id: null, name: '', color: COLORS[viewers.length % COLORS.length] })}
          className="flex items-center gap-2 px-2 py-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          <Plus size={14} /> Add viewer
        </button>
      )}
      {error && <p className="text-xs text-[var(--color-live)]">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Filters save to the viewer in `SetupPage.jsx`**

Imports: add `saveMyFilters` to the `stalkerApi` import; add `import ViewersCard from '@/components/ViewersCard'` and `import { viewerQuery, viewerPath } from '@/lib/viewer'`; remove `setProfileGenres, setProfileLanguages` (and `getActiveProfileId` if nothing else in the file uses it — check with `grep -n getActiveProfileId frontend/src/pages/SetupPage.jsx`) from the `@/lib/profiles` import.

From `useApp()` also take `viewer, applyViewer`:

```js
  const { connected, setConnected, setEpgEnabled, showAdult, setShowAdult,
          disabledGenres, setDisabledGenres, disabledLanguages, setDisabledLanguages, setLastPingAt, setIdleInfo,
          viewer, applyViewer } = useApp()
```

Replace `handleAdultToggle`:

```js
  async function handleAdultToggle(val) {
    setShowAdult(val)
    invalidateChannelCache()
    try { applyViewer(await saveMyFilters({ showAdult: val })) } catch { setShowAdult(!val) }
  }
```

Replace `persistGenres` (and its comment):

```js
  // Genre filters belong to the current viewer. Update the app context
  // immediately (optimistic), save on the server, and invalidate the channel
  // cache so the channel/player pages re-filter on next visit.
  function persistGenres(set) {
    setDisabledGenres(set)
    saveMyFilters({ disabledGenres: [...set] }).catch(() => {})
    invalidateChannelCache()
  }
```

Replace the body of `persistLanguages` likewise:

```js
  function persistLanguages(set) {
    setDisabledLanguages(set)
    saveMyFilters({ disabledLanguages: [...set] }).catch(() => {})
    invalidateChannelCache()
  }
```

In the connect handler, delete the `setDisabledGenres(new Set(…profile.disabledGenres…))` and `setDisabledLanguages(new Set(…profile.disabledLanguages…))` calls and change the comment above them to:

```js
      // Mark this profile active. Channel filters belong to the viewer, not
      // the portal profile, so they stay as they are.
      await setActiveProfile(profile.id).catch(() => {})
```

- [ ] **Step 3: Move Show Adult into a "My channels" card, add the Viewers card**

In the "App Preferences" card, cut the whole row containing `Show Adult Content` (the `<div className="flex items-center justify-between">` that holds that `<p>` and the `<Switch checked={showAdult} …/>`).

Change the "Genre Filters" card opening tag to:

```jsx
        <Card
          title={viewer ? `My channels (${viewer.name})` : 'My channels'}
          description="Which channels you see: hide genres and languages, and choose whether adult content is shown. These belong to you — other viewers keep their own."
        >
```

and paste the Show Adult row as the first child of that card (before the `{!connected ? (` ternary), wrapped as:

```jsx
          <div className="flex items-center justify-between pb-3 mb-1 border-b border-[var(--color-border)]">
            {/* the cut Show Adult row's <div> with the label and description, then the <Switch> */}
          </div>
```

i.e. keep the cut row's inner `<div>` (title + description) and `<Switch checked={showAdult} onCheckedChange={handleAdultToggle} />` unchanged, only its outer `className` changes as above.

Directly before the "My channels" card, add:

```jsx
        {/* ── Viewers ─────────────────────────────────────────────────────── */}
        <Card title="Viewers" description="Everyone who watches here. Each viewer has their own favorites and channel filters; every other setting on this page is shared.">
          <ViewersCard />
        </Card>
```

- [ ] **Step 4: Links follow the viewer**

In the IPTV Links block, after `const k = …`, add:

```js
          // The current viewer's channels (the default viewer's links are unchanged).
          const vq = viewerQuery(viewer)
          const vp = viewerPath(viewer)
```

Change the URLs:
- Stremio: `` url={`${stremioOrigin}${k}${vp}/stremio/manifest.json`} ``
- M3U: `` url={`${origin}${k}/api/m3u${vq}`} ``
- VLC: `` url={`${origin}${k}/api/xspf${vq}`} ``
- XMLTV: `` url={`${origin}${k}/api/xmltv${vq}`} ``

In the M3U hint, change `add <code className="font-mono">?prefix=1</code>` to `` add <code className="font-mono">{vq ? '&prefix=1' : '?prefix=1'}</code> ``.

In the Xtream server hint, replace "any username" (both variants of the hint) with ``{viewer && !viewer.isDefault ? <>the username <strong>{viewer.name}</strong></> : 'any username'}`` — convert those two hint strings to JSX fragments to do so.

Replace the paragraph starting "All of these leave out the genres and languages hidden under Genre Filters…" with:

```jsx
              <p className="text-xs text-[var(--color-muted)]">
                These links show {viewer ? <strong>{viewer.name}</strong> : 'your'}&apos;s channels: they leave out the genres and languages hidden under My channels, and adult content unless it is turned on there. Each viewer gets their own links. Add <code className="font-mono">{vq ? '&all=1' : '?all=1'}</code> to the M3U, VLC or XMLTV link to include every channel; the Xtream server and Stremio addon always apply the filters.
              </p>
```

- [ ] **Step 5: Lint, test, build**

```bash
cd frontend && npm run lint && npx vitest run && npm run build
```

Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ViewersCard.jsx frontend/src/pages/SetupPage.jsx
git commit -m "feat(viewers): Settings — Viewers, My channels, per-viewer links"
```

---

### Task 9: End-to-end check and PR

**Files:** none new.

- [ ] **Step 1: Full checks**

```bash
cd backend && npx vitest run && npm run lint
cd ../frontend && npx vitest run && npm run lint && npm run build
```

Expected: everything passes.

- [ ] **Step 2: Browser check**

Start the backend with a scratch data folder and an existing `favorites.json` (copy one channel id into `{"channels":["<id>"],"groups":[]}`) and the built frontend; connect a portal profile. Check, in order:
1. With one viewer: no picker; sidebar shows "Default"; the old favorite is still starred.
2. Settings → Viewers → add "Andy": the list shows both.
3. Reload: no picker, because this device already has Default saved. Open a private window: the picker appears (two viewers, none saved).
4. In the private window pick Andy: favorites empty; star a channel; hide a genre under My channels. Back in the first window (Default): that channel is not starred, the genre is visible.
5. Settings links in Andy's window include `?viewer=` / `/v/`; open the M3U link — the hidden genre is missing. The Default window's links have no viewer part.
6. Delete Andy from the Default window, then reload the private window: the picker no longer appears (one viewer left) and it is Default.
7. TV remote: in the picker, Left/Right moves between tiles, Enter picks.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/viewer-profiles
gh pr create --title "feat: viewer profiles — own favorites and channel filters per person" --body "<summary of the spec, the test plan above, and the 🤖 Generated with [Claude Code](https://claude.com/claude-code) line>"
```

Wait for CI (backend-check, frontend-check, build-apk, build-docker) and report the result.
