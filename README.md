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
| **D1** | Stores room metadata, completed game results, player names, recent games feed. | Needs to be queryable across all games (aggregation, ranking, search). D1 is the right tool when you need cross-entity queries that span multiple game rooms. |
| **Hyperdrive + Postgres** | Live analytics: event feed, 24h activity charts, geographic player data, top games. | Window functions, time-series aggregation, CTEs: analytics queries that are more natural in Postgres. Hyperdrive makes the remote Postgres fast worldwide via connection pooling and query caching. Same "D1 for app data, Postgres for analytics" split you'd use in production. |

### The key architectural insight
**Why Durable Objects for game rooms instead of a WebSocket server?**

A traditional multiplayer game runs a server process that manages all game rooms in memory. If the server crashes, all games die. If traffic grows, you need to shard rooms across servers and build a routing layer.

With Durable Objects:
- Each room is an isolated, globally unique instance with its own compute thread and storage
- Cloudflare handles routing (the Worker just calls `env.GAME_ROOM.idFromName(roomId)`)
- Rooms scale horizontally by definition: each is independent
- WebSocket hibernation means empty rooms cost essentially nothing
- The DO wakes up when a player reconnects, with state intact in co-located SQLite
- No server to manage, no scaling to configure, no regions to choose

### Everything runs on Cloudflare
The entire application is hosted on Cloudflare's platform:
- **Compute**: Workers (edge routing) + Durable Objects (game rooms)
- **Real-time**: WebSocket connections managed by DO
- **Database**: D1 (rooms, game results) + DO SQLite (live game state)
- **External DB access**: Hyperdrive → VPS Postgres (analytics)
- **DNS**: `jeka.org` is already on Cloudflare DNS
- **Routing**: `pong.jeka.org` via Workers custom domain
- **Geolocation**: `request.cf` object (city, country, colo, timezone: built into Workers)
- **Scheduling**: DO Alarms for room expiry
- **Audio**: Web Audio API (browser-native, no CDN dependency)

The only external dependency is a Postgres instance running on a VPS, accessed via Hyperdrive. This is intentional: Hyperdrive exists to make existing databases fast at the edge, and using a self-hosted Postgres is more realistic than a serverless provider (most companies have their own Postgres).

---

## User Flow

### Quick play (multiplayer)
1. Visit `pong.jeka.org`
2. Click "Create Room" → get a link like `pong.jeka.org/r/swift-fox`
3. Share the link with your opponent
4. They click it → both players connected via WebSocket to the same DO
5. Status shows "Waiting for Player 2..." until opponent joins
6. Both players see "READY!" and a START GAME button appears
7. Either player clicks START → 3-2-1 countdown → pong
8. First to 5 points wins

### Play vs AI
1. Visit `pong.jeka.org`
2. Click "Play vs AI 🤖"
3. Countdown starts immediately → play against the AI opponent
4. AI has reaction delays and deliberate mistakes: challenging but beatable

### Join flow
1. Open `pong.jeka.org/r/swift-fox`
2. If room has space → you're Player 2, both get START button
3. If room is full → you're a spectator (watch in real-time)
4. If room doesn't exist → "This room has expired"

### After the game
- Results saved to D1, shown on homepage under "Recent Games"
- Game stats: scores, rally count, longest rally, duration
- Player names auto-generated ("Swift Fox" vs "Bold Tiger", AI shows as "AI 🤖")

---

## Architecture

```
                   pong.jeka.org
                        │
                   ┌────▼─────┐
                   │  Worker   │  ← Serves UI, routes to rooms, API endpoints
                   │  (edge)   │
                   └────┬──────┘
                        │ WebSocket upgrade
                   ┌────▼──────┐
                   │  Durable  │  ← Game room: state, physics, AI, sync
                   │  Object   │     (one DO per active game)
                   │  (room)   │
                   └────┬──────┘
                        │
              ┌─────────┼──────────┐
              │         │          │
         ┌────▼──┐  ┌───▼───┐  ┌──▼────────┐
         │  DO   │  │  D1   │  │ Hyperdrive │
         │SQLite │  │       │  │     ↓      │
         │(state)│  │(rooms │  │  Postgres  │
         └───────┘  │+games)│  │(analytics) │
                    └───────┘  └────────────┘
```

### Worker
- Serves the game frontend (canvas-based, inline HTML in index.ts)
- Routes `/r/:roomId` to the correct Durable Object
- Upgrades HTTP to WebSocket for the game connection
- Generates human-readable room and player names ("swift-fox", "Bold Tiger")
- Serves the homepage with live dashboard, stats, and recent games
- API endpoints: `/api/create`, `/api/stats`, `/api/recent`, `/api/analytics`, `/api/events/live`, `/api/event`

### Durable Object: GameRoom
- Manages one game room (2 players + spectators)
- Runs authoritative game physics at 60fps via `setInterval`
- Broadcasts state to all connected clients via WebSocket
- AI opponent logic with reaction delays, deliberate mistakes, and lazy tracking
- Stores game state in co-located SQLite (survives hibernation)
- Logs analytics events to Postgres via Hyperdrive
- Saves final game results to D1

**Why Durable Objects:**
This is the textbook DO use case. Each game room needs:
1. **WebSocket connections**: DO natively supports WebSocket hibernation
2. **Authoritative state**: single-threaded means no physics race conditions
3. **Low latency**: game state and compute in same thread, no DB round-trip
4. **Natural lifecycle**: room exists while game is active, self-destructs after

**Why not a client-side game loop?**
Server-authoritative physics means:
- No cheating (can't modify ball position client-side)
- Both players see identical state
- The DO is the single source of truth
- Latency is the only variable, and Cloudflare's network minimizes it

### D1
- Stores room metadata (who created it, when, from where)
- Stores completed game results (scores, player names, cities, rally stats, duration)
- Powers the "Recent Games" feed on the homepage

**Schema:**
```sql
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  creator_colo TEXT,
  creator_city TEXT,
  creator_country TEXT,
  status TEXT DEFAULT 'waiting',    -- waiting | playing | finished | expired
  finished_at TEXT,
  player1_colo TEXT,
  player2_colo TEXT,
  player1_city TEXT,
  player2_city TEXT,
  player1_name TEXT,
  player2_name TEXT,
  winner_slot INTEGER,
  final_score TEXT,
  total_rallies INTEGER,
  longest_rally INTEGER,
  game_duration_seconds REAL
);
```

### Hyperdrive + Postgres
- Live event feed: player joins, point scores, game overs as they happen
- 24h activity chart (games per hour)
- Top cities (where players connect from)
- Top games (highest scores, longest rallies)
- Total event and room counts

**Why Hyperdrive + Postgres:**
- Window functions and time-series aggregation for analytics queries
- Hyperdrive connection pooling + query caching makes remote Postgres fast at the edge
- Shows the D1-for-app-data + Postgres-for-analytics pattern

**Postgres schema:**
```sql
CREATE TABLE game_events (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,     -- player_joined | point_scored | game_over
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  player_slot INTEGER,
  colo TEXT,
  city TEXT,
  country TEXT,
  metadata JSONB                -- { score1, score2, rally_hits, duration_seconds, name, ... }
);
```

---

## Frontend

### Game canvas
- HTML5 Canvas, zero dependencies
- Renders at 60fps, interpolating between server state updates
- Client-side prediction for paddle movement (immediate response, no input lag)
- Server reconciliation when authoritative state arrives

### Visual style
- Retro arcade aesthetic with Spark's warm ember palette
- Dark background (#0a0a0a), orange/gold UI elements, purple accents
- Left paddle: orange-to-gold gradient with fire glow
- Right paddle: violet-to-purple gradient
- Ball: glowing ember with translucent halo
- Scanline overlay effect (CSS)
- CRT screen vibe with warm orange border glow
- Cloud + flare atmosphere: drifting cloud shapes and rising ember particles around the game canvas
- Sound effects via Web Audio API (paddle hits, scoring)
- Screen shake on scoring
- Player names displayed above game canvas (orange for P1, purple for P2)

### Screens
1. **Home** (`/`): Create Room + Play AI buttons, stats counters, live dashboard (event feed, 24h activity, top cities, top games, totals), recent games
2. **Waiting** (`/r/swift-fox` with 1 player): "Waiting for Player 2..." status
3. **Ready** (`/r/swift-fox` with 2 players): START GAME button, player names shown
4. **Playing** (`/r/swift-fox`): the game, latency display, "← Home" link
5. **Spectating** (`/r/swift-fox` with 2+ players already): watch live in real-time

### Latency display
Shows the player's ping to the DO in real-time during gameplay (WebSocket ping/pong frames). This is both a game feature and a Cloudflare network demonstration.

---

## Live Dashboard

The homepage includes a real-time dashboard powered by Postgres via Hyperdrive:

- **Live event feed**: Player joins (with name + city + colo), point scores, game overs. Updates every 3 seconds.
- **24h activity**: Bar chart showing games per hour
- **Top cities**: Where players are connecting from worldwide
- **Top games**: Highest point counts + longest rallies
- **Totals**: Total events and rooms tracked
- **Recent games**: Completed matches with player names, cities, and scores (from D1, refreshes every 30s)

All dashboard data uses `setHTML()` diffing to avoid visual flicker on refresh cycles.

---

## Project Structure

```
pong/
├── wrangler.toml            # Cloudflare config (Workers, DO, D1, Hyperdrive)
├── tsconfig.json
├── package.json
├── src/
│   ├── index.ts             # Worker: routes, API endpoints, homepage + game HTML (inline)
│   ├── game-room.ts         # Durable Object: WebSocket, physics, AI, event logging
│   ├── physics.ts           # Ball/paddle physics engine (pure functions)
│   ├── room-names.ts        # Room name + player name generator
│   └── d1-queries.ts        # D1: room creation, game results, recent games
└── schema/
    ├── d1-schema.sql        # D1 rooms + leaderboard tables
    └── postgres-schema.sql  # Postgres game_events table
```

---

## Deploy

### Prerequisites
- Cloudflare Workers Paid plan ($5/mo) for Durable Objects, D1, and Hyperdrive
- A Postgres instance accessible from the internet (for analytics via Hyperdrive)

### Steps
```bash
# Create D1 database
wrangler d1 create pong-db

# Create Hyperdrive config (pointing to your Postgres)
wrangler hyperdrive create pong-analytics \
  --connection-string="postgres://user:pass@host:5432/pong_analytics"

# Run D1 migrations
wrangler d1 execute pong-db --file=./schema/d1-schema.sql

# Run Postgres migrations
psql $POSTGRES_CONNECTION_STRING -f ./schema/postgres-schema.sql

# Deploy
wrangler deploy
```

---

Built by [Spark](https://spark.jeka.org) ✨
