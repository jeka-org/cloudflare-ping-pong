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

The only external dependency is a Postgres instance running on a VPS, accessed via Hyperdrive (either via public IP or Cloudflare Tunnel for secure private access). This is intentional: Hyperdrive exists to make existing databases fast at the edge, and using a self-hosted Postgres is more realistic than a serverless provider (most companies have their own Postgres).

Cloudflare positions Durable Objects as the foundation for real-time applications, AI agents, and collaborative tools. This game is a good test of that claim.

### How to deploy
```bash
# Create D1 database
wrangler d1 create pong-db

# Create Hyperdrive config (pointing to VPS Postgres)
# Option A: via Cloudflare Tunnel (recommended)
wrangler hyperdrive create pong-analytics \
  --connection-string="postgres://pong_user:PASSWORD@TUNNEL_HOSTNAME/pong_analytics"
# Option B: via public IP
wrangler hyperdrive create pong-analytics \
  --connection-string="postgres://pong_user:PASSWORD@YOUR_VPS_IP:5432/pong_analytics"

# Run D1 migrations
wrangler d1 execute pong-db --file=./schema/d1-schema.sql

# Run Postgres migrations
psql $POSTGRES_CONNECTION_STRING -f ./schema/postgres-schema.sql

# Deploy - live at pong.jeka.org
wrangler deploy
```

### wrangler.toml
```toml
name = "global-pong"
main = "src/index.ts"
compatibility_date = "2024-12-01"

routes = [
  { pattern = "pong.jeka.org", custom_domain = true }
]

[[durable_objects.bindings]]
name = "GAME_ROOM"
class_name = "GameRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GameRoom"]

[[d1_databases]]
binding = "DB"
database_name = "pong-db"
database_id = "<created-at-deploy>"

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<created-at-deploy>"
```

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

**What it does:**
- Serves the game frontend (canvas-based, inline HTML in index.ts)
- Routes `/r/:roomId` to the correct Durable Object
- Upgrades HTTP to WebSocket for the game connection
- Generates human-readable room and player names ("swift-fox", "Bold Tiger")
- Serves the homepage with live dashboard, stats, and recent games
- API endpoints: `/api/create`, `/api/stats`, `/api/recent`, `/api/leaderboard`, `/api/analytics`, `/api/events/live`, `/api/event`

**Code shape:**
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve frontend
    if (url.pathname === '/') return new Response(HOME_HTML, { headers: { 'content-type': 'text/html' }});

    // Route to game room
    if (url.pathname.startsWith('/r/')) {
      const roomId = url.pathname.split('/')[2];
      const id = env.GAME_ROOM.idFromName(roomId);
      const room = env.GAME_ROOM.get(id);
      return room.fetch(request);
    }

    // Create new room
    if (url.pathname === '/api/create') {
      const roomId = generateRoomName(); // "swift-fox"
      await createRoom(env.DB, roomId, request.cf);
      return Response.json({ roomId, url: `/r/${roomId}` });
    }

    // Analytics from Postgres via Hyperdrive
    if (url.pathname === '/api/analytics') {
      const client = new pg.Client(env.HYPERDRIVE.connectionString);
      // ... activity, cities, topGames, eventCount queries
    }
  }
};
```

### Durable Object: GameRoom

**What it does:**
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

**Game state in DO SQLite:**
```sql
CREATE TABLE game_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Stores: ball position/velocity, paddle positions, scores, game phase
-- Using KV pattern because game state is a single mutable blob

CREATE TABLE players (
  slot INTEGER PRIMARY KEY,  -- 1 or 2
  connected_at TEXT,
  colo TEXT,
  city TEXT,
  country TEXT
);

CREATE TABLE rallies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  ended_at TEXT,
  hits INTEGER,
  winner_slot INTEGER
);
```

**Game loop:**
```typescript
class GameRoom extends DurableObject {
  players: Map<WebSocket, PlayerInfo> = new Map();
  gameState: { ball, paddle1, paddle2, score1, score2, phase };

  async webSocketMessage(ws: WebSocket, msg: string) {
    const data = JSON.parse(msg);
    if (data.type === 'paddle') {
      const player = this.players.get(ws);
      if (player?.slot === 1) this.gameState.paddle1 = data.y;
      if (player?.slot === 2) this.gameState.paddle2 = data.y;
    }
  }

  startGameLoop() {
    this.gameLoop = setInterval(() => {
      // AI paddle movement (if enabled)
      if (this.aiEnabled) {
        // Reaction delay, deliberate mistakes, lazy when ball going away
      }

      // Update ball, check collisions, check scoring
      let ball = updateBall(this.gameState.ball);
      ball = checkWallBounce(ball);
      // Paddle collisions add angle based on hit position
      // Ball speeds up after each hit

      // Broadcast state to all connected players + spectators
      this.broadcast({ type: 'state', ball, paddle1, paddle2, score1, score2, phase });
    }, 1000 / 60); // 60fps server-side tick
  }
}
```

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
  id TEXT PRIMARY KEY,              -- "swift-fox"
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
  player1_name TEXT,                -- "Swift Fox" (added via migration)
  player2_name TEXT,                -- "Bold Tiger" or "AI 🤖"
  winner_slot INTEGER,
  final_score TEXT,                 -- "5-3"
  total_rallies INTEGER,
  longest_rally INTEGER,
  game_duration_seconds REAL
);

CREATE TABLE leaderboard (
  player_id TEXT PRIMARY KEY,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  longest_rally INTEGER DEFAULT 0,
  games_played INTEGER DEFAULT 0,
  last_played TEXT
);

CREATE INDEX idx_rooms_status ON rooms(status);
CREATE INDEX idx_rooms_created ON rooms(created_at DESC);
CREATE INDEX idx_leaderboard_wins ON leaderboard(wins DESC);
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

-- Example analytics queries (run via Hyperdrive):

-- 24h activity by hour
SELECT date_trunc('hour', timestamp) AS hour,
       COUNT(DISTINCT room_id) AS games, COUNT(*) AS events
FROM game_events WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY 1 ORDER BY 1 DESC;

-- Geographic player distribution
SELECT city, country, COUNT(DISTINCT room_id) AS games
FROM game_events WHERE city IS NOT NULL
GROUP BY city, country ORDER BY games DESC;

-- Top games by points scored
SELECT room_id,
       COUNT(*) FILTER (WHERE event_type = 'point_scored') AS points,
       MAX((metadata->>'rally_hits')::int) AS longest_rally
FROM game_events
WHERE event_type IN ('point_scored', 'game_over')
GROUP BY room_id ORDER BY points DESC;
```

-- Materialized view for hourly activity (deployed in Postgres)
CREATE MATERIALIZED VIEW hourly_activity AS
SELECT
  date_trunc('hour', timestamp) AS hour,
  COUNT(DISTINCT room_id) AS games,
  COUNT(DISTINCT city) AS cities,
  COUNT(*) FILTER (WHERE event_type = 'point_scored') AS total_points
FROM game_events
GROUP BY 1 ORDER BY 1 DESC;
```

**Hyperdrive cache note:** Analytics queries avoid `NOW()` in parameterized form where possible, letting Hyperdrive cache read-heavy dashboard queries. The live event feed uses `ORDER BY timestamp DESC LIMIT 20` which naturally expires from cache as new events arrive.

---

## Frontend

### Game canvas
- HTML5 Canvas, zero dependencies
- Renders at 60fps, interpolating between server state updates
- Client-side prediction for paddle movement (immediate response, no input lag)
- Server reconciliation when authoritative state arrives
- Touch controls for mobile (touchmove events)

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
Shows the player's ping to the DO in real-time during gameplay (WebSocket ping/pong frames). This is both a game feature and a Cloudflare network demonstration:
```
12ms (SEA)
```

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

## Testing

Testing uses **Vitest** with `@cloudflare/vitest-pool-workers` for testing Workers, D1, and Durable Objects in a local Miniflare environment.

```bash
npx vitest              # run all tests
npx vitest --watch      # watch mode during development
npx vitest --coverage   # with coverage
```

Test categories:
- **Unit**: Physics engine (ball movement, collisions, scoring), room name generation
- **Integration**: Durable Object WebSocket flow, D1 room/leaderboard operations, Worker routing
- **End-to-end**: Full game lifecycle (manual via `wrangler dev`)

The physics module (`physics.ts`) is pure functions with no Cloudflare dependencies, making it straightforward to unit test. DO and D1 tests use Cloudflare's Vitest pool which runs a local Miniflare instance with real bindings.

---

## Project Structure

```
pong/
├── wrangler.toml            # Cloudflare config (Workers, DO, D1, Hyperdrive)
├── vitest.config.ts         # Test config with Cloudflare Workers pool
├── tsconfig.json
├── package.json
├── src/
│   ├── index.ts             # Worker: routes, API endpoints, homepage + game HTML (inline)
│   ├── game-room.ts         # Durable Object: WebSocket, physics, AI, event logging
│   ├── physics.ts           # Ball/paddle physics engine (pure functions)
│   ├── room-names.ts        # Room name + player name generator
│   ├── d1-queries.ts        # D1: room creation, game results, recent games
│   └── analytics.ts         # Hyperdrive: Postgres analytics query builders
├── tests/
│   ├── physics.test.ts      # Unit: ball movement, collisions, scoring
│   ├── room-names.test.ts   # Unit: name generation
│   ├── d1-queries.test.ts   # Integration: D1 room/leaderboard operations
│   ├── worker.test.ts       # Integration: Worker routing, API endpoints
│   └── analytics.test.ts    # Unit: query builders (no real Postgres)
└── schema/
    ├── d1-schema.sql        # D1 rooms + leaderboard tables
    └── postgres-schema.sql  # Postgres game_events + materialized views
```

---

## Setup

### Prerequisites
- Cloudflare Workers Paid plan ($5/mo) for Durable Objects, D1, and Hyperdrive
- A Postgres instance accessible from the internet (for analytics via Hyperdrive)

### Credentials needed
```
CLOUDFLARE_API_TOKEN=<your-token>
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
POSTGRES_CONNECTION_STRING=postgres://user:pass@host:5432/pong_analytics
```

---

Built by [Spark](https://spark.jeka.org) ✨
