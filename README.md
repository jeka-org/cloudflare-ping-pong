# Global Pong - Real-Time Multiplayer on Cloudflare's Edge
## Real-time multiplayer pong on Workers + Durable Objects

**URL:** `pong.jeka.org`
**Stack:** Workers + Durable Objects + D1 + Hyperdrive + Postgres

---

## Background & Context

### What is this?
Global Pong is a real-time multiplayer pong game running entirely on Cloudflare's developer platform. Two players connect via WebSocket to a Durable Object that runs the authoritative game physics. Every paddle move, ball bounce, and score happens server-side in a single thread: no race conditions, no cheating, identical state for both players.

### Why build it?
A project to explore three areas of the Cloudflare developer platform: **Workers**, **available database options**, and **Hyperdrive**. A real-time multiplayer game is the canonical Durable Objects use case: WebSockets, single-threaded state management, co-located storage, and the compute model that makes DO different from traditional server architecture.

### Why these specific Cloudflare products?

| Product | Role in Global Pong | Why This Product (Not an Alternative) |
|---------|---------------------|---------------------------------------|
| **Workers** | Serves UI, routes HTTP requests to game rooms, handles room creation | Sub-ms cold starts for instant page loads. `request.cf` gives player geolocation (city, country, colo) for free. Routes WebSocket upgrades to the correct DO instance. |
| **Durable Objects** | Each game room is a DO instance. Runs physics loop, manages WebSocket connections, stores game state in co-located SQLite. | Single-threaded = no race conditions on physics. WebSocket hibernation = idle rooms cost nothing. Co-located SQLite = zero-latency state reads. DO Alarms = auto-expire abandoned rooms. This IS the textbook DO use case. |
| **D1** | Stores room metadata, completed game results, player names, leaderboard. | Needs to be queryable across all games (aggregation, ranking, search). D1 is the right tool when you need cross-entity queries that span multiple game rooms. |
| **Hyperdrive + Postgres** | Live analytics: event feed, 24h activity charts, geographic player data, top games. | Window functions, time-series aggregation, CTEs: analytics queries that are more natural in Postgres. Hyperdrive makes the remote Postgres fast worldwide via connection pooling and query caching. Same "D1 for app data, Postgres for analytics" split you'd use in production. |

### Everything runs on Cloudflare
The entire application is hosted on Cloudflare's platform:
- **Compute**: Workers (edge routing) + Durable Objects (game rooms + lobby)
- **Real-time**: WebSocket connections managed by DO
- **Database**: D1 (rooms, game results, leaderboard) + DO SQLite (live game state)
- **External DB access**: Hyperdrive -> VPS Postgres (analytics)
- **DNS**: `jeka.org` is already on Cloudflare DNS
- **Routing**: `pong.jeka.org` via Workers custom domain
- **Geolocation**: `request.cf` object (city, country, colo, timezone: built into Workers)
- **Scheduling**: DO Alarms for room expiry (10 min for waiting rooms, 30 min for finished rooms)
- **Audio**: Web Audio API (sound effects) + embedded MP3 (background music)

The only external dependency is a Postgres instance running on a VPS, accessed via Hyperdrive.

---

## User Flow

### Quick play (multiplayer)
1. Visit `pong.jeka.org`
2. Click "Create Room" or join a waiting game from the live lobby
3. Share the room link with your opponent
4. They click it -> both players connected via WebSocket to the same DO
5. Status shows "Waiting for Player 2..." until opponent joins
6. Both players see "READY!" and a START GAME button appears
7. Either player clicks START -> 3-2-1 countdown -> pong
8. Best of 5 (first to 3 wins)

### Play vs AI
1. Visit `pong.jeka.org`
2. Click "Play vs AI"
3. Countdown starts immediately -> play against the AI opponent
4. AI has reaction delays and deliberate mistakes: challenging but beatable
5. AI games show as "playing" in the lobby (spectators can watch)

### Join flow
1. Open a room link like `pong.jeka.org/r/swift-fox-abc`
2. If room has space -> you're Player 2, both get START button
3. If room is full -> you're a spectator (watch in real-time, send emoji reactions)
4. If room doesn't exist or has ended -> error page: "Room Not Available"

### Reconnection
If a player disconnects (browser refresh, network hiccup, mobile tab switch):
1. Game pauses for 15 seconds with a reconnection countdown
2. Other player and spectators see "Waiting for [Name] to reconnect..."
3. If the player reconnects within 15s, the game resumes with a 3-2-1 countdown
4. If both players disconnect, the game ends immediately
5. Reconnecting player keeps their original name (important for leaderboard)

### After the game
- Results saved to D1 with status: `finished`, `disconnected`, or `abandoned`
- Game stats: scores, rally count, longest rally, duration
- Player names auto-generated ("Swift Fox" vs "Bold Tiger", AI shows as "AI")
- Leaderboard updated (AI excluded from leaderboard entries)
- Results shown on homepage under "Recent Games"

---

## Features

### Game Mechanics
- **Best of 5**: First player to 3 points wins
- **Server-authoritative physics**: 60fps physics tick, 30fps network broadcast
- **Client-side prediction**: Your paddle renders instantly, server reconciles
- **Ball acceleration**: Ball speeds up after each paddle hit
- **Angle control**: Hit position on paddle determines bounce angle
- **Space Events** (random mid-game disruptions):
  - **Gravity Well**: Swirling vortex pulls the ball toward it. Spawns at random positions, lasts 5 seconds.
  - **Asteroid**: Drifting solid obstacle. Ball bounces off it, creating unpredictable angles.
  - **Rally Heat**: After 4+ consecutive hits, ball speeds up (1.1x/1.2x/1.3x) and visuals intensify (warm vignette, enhanced trails). Resets on point scored.
  - Events spawn ~every 20 seconds (15% chance per 3s check), max 1 active at a time
  - Events freeze during reconnection pause, persist across rounds

### Visual Effects
- Space theme with warm ember palette (orange/gold, magenta accents)
- **Warp starfield**: 150 stars flying outward from center with warm gold/orange streaks
- **Ball trail**: Ember particles drift upward behind the ball
- **Paddle hit sparks**: Burst of colored particles on collision (orange for left, magenta for right)
- **Paddle glow pulse**: Paddles breathe with animated glow, flash white on hit
- **Screen shake**: On scoring
- **Rally heat visuals**: Progressive warm vignette overlay at 4/7/10+ hit rallies
- **Gravity well**: Swirling orange particles orbiting a radial glow
- **Asteroid**: Dark rock with orange-lit edges, slow rotation
- Warm ember center line force field with drifting particles
- CRT scanline overlay, nebula glow behind canvas
- Smooth interpolation between server state updates

### Audio
- **Background music**: 6 royalty-free chiptune tracks (random per game), crossfade looping
  - 8-Bit Perplexion (1:50), Bonkers for Arcades (1:08), Funky Chiptune (1:15), Arcade Heroes (0:39), 8-Bit Drama (0:49), The Ice Cream Man (0:48)
  - Music by Eric Matyas (soundimage.org), embedded as base64
  - Mute toggle button in top-right corner
  - Music fades out over 2 seconds on game end (no abrupt stop)
  - Mobile volume reduced (0.03 vs 0.08 desktop)
- **Sound effects** (Web Audio API, all sine wave):
  - Soft thud on paddle hit
  - Gentle chime on scoring
  - Rising three-note on game start
  - Countdown tick
  - Deep tone on game over
- **Mobile audio**: Tap-to-start overlay unlocks AudioContext on iOS Safari. Silent buffer trick for permanent unlock.
- **Haptic feedback**: Vibrate on paddle hits (15ms), scoring (30ms), game over (pattern)

### Spectator Mode
- 3rd+ connections to a room become spectators
- Watch the game in real-time with full canvas rendering
- Persistent "SPECTATING" badge (top-left, purple)
- Emoji reactions: 🔥 👏 😱 💀 😂 👀 ❤️ 🏓 (2-second cooldown, server-validated whitelist)
- Floating emojis visible to all players and spectators
- Spectator joining an AI game gets "Watching AI game" message

### Live Lobby
- Homepage shows all active rooms in real-time via WebSocket to Lobby DO
- Waiting rooms show [JOIN] button, in-progress rooms show [SPECTATE] button
- Lobby is the hero section (immediately after action buttons, before stats)
- Empty state includes action buttons so visitors don't scroll back up
- Rooms animate in/out with fade transitions
- GameRooms send heartbeat to Lobby DO every 30s to prevent stale listings
- Lobby DO prunes rooms inactive for 5+ minutes

### Mobile Support
- **Orientation detection**: Portrait mode shows "Rotate your phone" overlay (dismissible)
- **Responsive canvas**: Fills available width/height, 4:3 ratio, max 800px
- **Touch zones**: Left half of screen = Player 1 paddle, right half = Player 2. Touch anywhere on your side.
- **Multi-touch**: Can tap music/emoji buttons while holding paddle
- **Performance**: Reduced particles on mobile (4 hit sparks vs 8, 15 stars vs 30)
- **Landscape CSS**: Player names hidden, UI elements minimized to maximize game area

### Room Lifecycle
- Rooms checked against D1 before serving game page (non-existent rooms get error page)
- DO also rejects WebSocket upgrades for rooms in terminal states
- Room name collision: D1 uniqueness check with 5 retries on create
- Waiting rooms auto-expire after 10 minutes (DO alarm)
- Stale D1 rows cleaned on stats/lobby API fetches (15-minute threshold)

---

## State Machine

### Room Statuses (D1)
`waiting` | `ready` | `playing` | `finished` | `expired` | `disconnected` | `abandoned`

### Transitions
| From | To | Trigger |
|------|----|---------|
| waiting | ready | Player 2 connects (human games) |
| waiting | expired | 10-min alarm fires |
| ready | countdown | Either player clicks START |
| countdown | playing | Countdown reaches 0 |
| playing | finished | Score reaches 3 |
| playing | paused | Player disconnects (15s grace) |
| paused | playing | Player reconnects |
| paused | disconnected | Grace expires, has score |
| paused | abandoned | Grace expires, no score |

AI games skip waiting/ready and register directly as 'playing'.

### Game-End Paths (all 7 call: lobby unregister + D1 update + stop game loop + clear heartbeat)
1. Normal win (score reaches 3) -> `finished`
2. Grace expires with score -> `disconnected`, winner = remaining player
3. Grace expires without score -> `abandoned`, no results saved
4. Both players disconnect -> `abandoned`, immediate end
5. Waiting room alarm (10 min) -> `expired`
6. AI game, player leaves with score -> `disconnected`, AI wins
7. AI game, player leaves without score -> `abandoned`

---

## Architecture

```
                   pong.jeka.org
                        |
                   +----v-----+
                   |  Worker   |  <- Serves UI, routes to rooms, API endpoints
                   |  (edge)   |     Room existence check against D1
                   +----+------+
                        | WebSocket upgrade
                   +----v------+
                   |  Durable  |  <- Game room: state, physics, AI, reconnection
                   |  Object   |     Heartbeat to lobby every 30s
                   |  (room)   |     DO Alarm for room expiry
                   +----+------+
                        |
              +---------+----------+
              |         |          |
         +----v--+  +---v---+  +--v--------+
         |  DO   |  |  D1   |  | Hyperdrive |
         |SQLite |  |       |  |     v      |
         |(state)|  |(rooms |  |  Postgres  |
         +-------+  |+games |  |(analytics) |
                    |+leader)|  +-----------+
                    +-------+
                        
                   +----------+
                   | Lobby DO |  <- Room registry, WebSocket to homepage viewers
                   | (global) |     Staleness pruning via alarm (60s check)
                   +----------+
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Homepage with lobby, stats, dashboard, recent games |
| `/r/:roomId` | GET | Game page (checks D1 for room existence first) |
| `/r/:roomId` | WS | WebSocket to game room DO |
| `/api/create` | POST | Create room (D1 + collision retry) |
| `/api/stats` | GET | Global stats (also triggers stale room cleanup) |
| `/api/recent` | GET | Recent finished games from D1 |
| `/api/leaderboard` | GET | Player leaderboard from D1 |
| `/api/lobby` | GET | Active rooms (HTTP fallback) |
| `/ws/lobby` | WS | Live lobby updates |
| `/api/analytics` | GET | Postgres analytics (activity, cities, top games) |
| `/api/events/live` | GET | Recent events from Postgres |
| `/api/event` | POST | Log analytics event (called by GameRoom DO) |
| `/analytics` | GET | Standalone analytics dashboard page |

---

## Testing

```bash
npx vitest              # 44 tests across 6 files
npx vitest --watch      # watch mode
```

Test coverage:
- **Physics** (13 tests): ball movement, collisions, scoring, wall bounces
- **Room names** (3 tests): name generation format
- **D1 queries** (8 tests): room CRUD, stats, leaderboard, stale cleanup
- **Worker routes** (13 tests): homepage, game page, room existence check, API endpoints, lobby
- **Lobby DO** (1 test): basic functionality
- **Analytics** (6 tests): query builder output

---

## Project Structure

```
pong/
+-- wrangler.toml            # Cloudflare config (Workers, DO, D1, Hyperdrive)
+-- vitest.config.ts         # Test config with Cloudflare Workers pool
+-- FIXES-SPEC.md            # Validated fix spec (18 fixes with state machine)
+-- src/
|   +-- index.ts             # Worker: routes, API, inline HTML (homepage + game + analytics)
|   +-- game-room.ts         # DO: WebSocket, physics, AI, reconnection, lobby notifications
|   +-- lobby-room.ts        # DO: room registry, WebSocket broadcast, staleness pruning
|   +-- physics.ts           # Ball/paddle physics engine (pure functions)
|   +-- room-names.ts        # Room name + player name generator
|   +-- d1-queries.ts        # D1: room CRUD, game results, leaderboard, stale cleanup
|   +-- analytics.ts         # Hyperdrive: Postgres analytics query builders
+-- tests/
|   +-- physics.test.ts
|   +-- room-names.test.ts
|   +-- d1-queries.test.ts
|   +-- worker.test.ts
|   +-- lobby-room.test.ts
|   +-- analytics.test.ts
+-- schema/
    +-- d1-schema.sql
    +-- postgres-schema.sql
```

---

## Setup

### Prerequisites
- Cloudflare Workers Paid plan ($5/mo) for Durable Objects, D1, and Hyperdrive
- A Postgres instance accessible from the internet (for analytics via Hyperdrive)

### Deploy
```bash
wrangler d1 create pong-db
wrangler d1 execute pong-db --file=./schema/d1-schema.sql
wrangler hyperdrive create pong-analytics \
  --connection-string="postgres://user:pass@host:5432/pong_analytics"
psql $POSTGRES_CONNECTION_STRING -f ./schema/postgres-schema.sql
wrangler deploy
```

---

## Music Attribution
Background music by [Eric Matyas](https://soundimage.org), used under royalty-free license with attribution.

Built by [Spark](https://spark.jeka.org) ✨
