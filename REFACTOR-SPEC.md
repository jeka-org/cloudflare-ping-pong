# Refactor Spec: Extract Inline HTML/CSS/JS from index.ts

## Problem
`src/index.ts` is 2,854 lines / 1.7MB. It contains the Worker router, 3 full HTML pages (with inline CSS + JS), and 435KB of base64 music data. It's unmaintainable: no editor tooling, impossible diffs, duplicated utility code across pages.

## Goal
Split `index.ts` into focused, editable files while keeping the exact same deployed behavior. **Zero user-facing changes.** This is a pure structural refactor.

## Constraints
- Cloudflare Workers serve responses from code, not static files (no `public/` directory without Workers Sites/Assets)
- Wrangler bundles `src/index.ts` and its imports with esbuild
- Music must remain accessible to the client (currently base64 inline)
- All 58 existing tests must pass without modification
- The `check-html-js.mjs` validator may need updating to match new file layout
- Deploy must produce identical behavior to current production

## Plan

### Phase 1: Extract HTML templates to separate files

**New files:**
```
src/
  templates/
    home.ts         # exports HOME_HTML string
    game.ts         # exports GAME_HTML string  
    analytics.ts    # exports ANALYTICS_HTML string
    error.ts        # exports ERROR_HTML function
```

Each file exports one template string (the exact same content currently in index.ts).

**Changes to index.ts:**
- Remove the 4 inline template constants (`HOME_HTML`, `GAME_HTML`, `ANALYTICS_HTML`, `ERROR_HTML`)
- Import them from `./templates/*`
- Router logic stays in index.ts (it's ~150 lines, fine)

**Result:** index.ts drops from ~2,854 to ~300 lines. Templates become navigable files.

### Phase 2: Extract music to separate module

**New file:**
```
src/
  music-data.ts     # exports MUSIC_TRACKS array of base64 strings
```

**Changes to game template:**
- Import the base64 strings into `game.ts` and interpolate them into the template

**Result:** Music data isolated in its own file. `game.ts` references it, editor doesn't choke loading 435KB strings.

### Phase 3: Deduplicate shared client utilities

**New file:**
```
src/
  templates/
    shared-utils.ts  # exports SHARED_JS string with timeAgo, renderEvent, eventIcons, etc.
```

The homepage and analytics page both define `timeAgo()`, `renderEvent()`, `eventIcons`, `eventLabels`. Extract these to a shared JS string that gets injected into both templates.

**Changes:** Both templates include `${SHARED_JS}` in their `<script>` blocks instead of duplicated functions.

### Phase 4: Update tooling

- Update `check-html-js.mjs` to find `<script>` blocks in `src/templates/*.ts` instead of only `src/index.ts`
- Verify `npm run check` passes
- Verify `npm run typecheck` passes

## Files Modified
- `src/index.ts` — strip templates, add imports
- `src/templates/home.ts` — new (extracted from index.ts)
- `src/templates/game.ts` — new (extracted from index.ts)
- `src/templates/analytics.ts` — new (extracted from index.ts)
- `src/templates/error.ts` — new (extracted from index.ts)
- `src/music-data.ts` — new (extracted from game template)
- `src/templates/shared-utils.ts` — new (deduplicated from home + analytics)
- `tests/check-html-js.mjs` — updated to scan new locations

## Files NOT Modified
- `src/game-room.ts` — no change
- `src/lobby-room.ts` — no change
- `src/physics.ts` — no change
- `src/room-names.ts` — no change
- `src/d1-queries.ts` — no change
- `src/analytics.ts` — no change (this is the server-side analytics, not the page)
- `wrangler.toml` — no change (main is still `src/index.ts`)
- `tests/*.test.ts` — no change
- `README.md` — no behavioral change, no update needed

## Verification
1. `npm run test` — all 58 tests pass
2. `npm run check` — updated HTML validator passes  
3. `npm run typecheck` — TypeScript compiles
4. Deploy to pong.jeka.org
5. Manual checks:
   - Homepage loads, lobby WS connects, stats/feed populate
   - Create room works, game plays (mouse + touch)
   - Music plays, sounds work
   - Game over screen shows, "Play Again" creates new room
   - Analytics page loads at /analytics
   - Error page shows for expired rooms
   - Spectator mode works with emoji reactions

## What This Does NOT Do
- Does not extract client JS from `<script>` blocks into real .ts files (Phase 3 future work — requires a client bundler pipeline)
- Does not move music to R2/KV (future optimization)  
- Does not add CSS files (CSS stays inline in templates)
- Does not change any game logic, networking, or UI behavior
