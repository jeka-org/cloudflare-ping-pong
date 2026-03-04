# Global Pong - Real-Time Multiplayer on Cloudflare's Edge
## Real-time multiplayer pong on Workers + Durable Objects

**URL:** `pong.jeka.org`
**Stack:** Workers + Durable Objects + D1 + Hyperdrive + Postgres
---

## Background & Context

### What is this?
Global Pong is a real-time multiplayer pong game running entirely on Cloudflare's developer platform. Two players connect via WebSocket to a Durable Object that runs the authoritative game physics. Every paddle move, ball bounce, and score happens server-side in a single thread - no race conditions, no cheating, identical state for both players.

### Why build it?
A project to explore three areas of the Cloudflare developer platform: **Workers**, **available database options**, and **Hyperdrive**. A real-time multiplayer game is the canonical Durable Objects use case - WebSockets, single-threaded state management, co-located storage, and the compute model that makes DO different from traditional server architecture.

### Why these specific Cloudflare products?

| Product | Role in Global Pong | Why This Product (Not an Alternative) |
|---------|---------------------|---------------------------------------|
| **Workers** | Serves UI, routes HTTP requests to game rooms, handles room creation | Sub-ms cold starts for instant page loads. `request.cf` gives player geolocation (city, country, colo) for free. Routes WebSocket upgrades to the correct DO instance. |
| **Durable Objects** | Each game room is a DO instance. Runs physics loop, manages WebSocket connections, stores game state in co-located SQLite. | Single-threaded = no race conditions on physics. WebSocket hibernation = idle rooms cost nothing. Co-located SQLite = zero-latency state reads. DO Alarms = auto-expire abandoned rooms. This IS the textbook DO use case. |
| **D1** | Stores room metadata, completed game results, leaderboard, recent games feed. | Needs to be queryable across all games (aggregation, ranking, search). D1 is better than DO for cross-entity queries. D1 is the right tool when you need cross-entity queries. |
| **Hyperdrive + Postgres** | Rich analytics: geographic matchup heatmaps, time-series activity, latency analysis between player pairs. | Window functions, PostGIS, materialized views, CTEs - analytics queries that are more natural in Postgres. Hyperdrive makes the remote Postgres fast worldwide via query caching. Same "D1 for app data, Postgres for analytics" split you'd use in production. |

### The key architectural insight
**Why Durable Objects for game rooms instead of a WebSocket server?**

A traditional multiplayer game runs a server process that manages all game rooms in memory. If the server crashes, all games die. If traffic grows, you need to shard rooms across servers and build a routing layer.

With Durable Objects:
- Each room is an isolated, globally unique instance with its own compute thread and storage
- Cloudflare handles routing (the Worker just calls `env.GAME_ROOM.idFromName(roomId)`)
- Rooms scale horizontally by definition - each is independent
- WebSocket hibernation means empty rooms cost essentially nothing
- The DO wakes up when a player reconnects, with state intact in co-located SQLite
- No server to manage, no scaling to configure, no regions to choose

Cloudflare positions Durable Objects as the foundation for real-time applications, AI agents, and collaborative tools. This game is a good test of that claim.

### Everything runs on Cloudflare
The entire application is hosted on Cloudflare's platform:
- **Compute**: Workers (edge routing) + Durable Objects (game rooms)
- **Real-time**: WebSocket connections managed by DO
- **Database**: D1 (rooms, leaderboard) + DO SQLite (live game state)
- **External DB access**: Hyperdrive → VPS Postgres (analytics)
- **DNS**: `jeka.org` is already on Cloudflare DNS
- **Routing**: `pong.jeka.org` via Workers custom domain
- **Geolocation**: `request.cf` object (city, country, colo, timezone - built into Workers)
- **Scheduling**: DO Alarms for room expiry
- **Audio**: Web Audio API (browser-native, no CDN dependency)

The only external dependency is a Postgres instance running on the VPS, accessed via Hyperdrive (either via public IP or Cloudflare Tunnel for secure private access). This is intentional - Hyperdrive exists to make existing databases fast at the edge, and using a self-hosted Postgres is more realistic than a serverless provider (most companies have their own Postgres).

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

### Cloudflare account requirements
- **Workers Paid plan** ($5/month) - required for Durable Objects, D1, and Hyperdrive
- **`jeka.org` on Cloudflare DNS** - already set up ✓
- That's it. $5/mo includes everything.

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

### Quick play
1. Visit `pong.jeka.org`
2. Click "Create Room" → get a link like `pong.jeka.org/r/swift-fox`
3. Share the link with your opponent
4. They click it → both players connected via WebSocket to the same DO
5. 3-2-1 countdown → pong
6. First to 5 points wins

### Join flow
1. Open `pong.jeka.org/r/swift-fox`
2. If room has space → you're Player 2, game starts
3. If room is full → you're a spectator (watch in real-time)
4. If room doesn't exist → "This room has expired"

### After the game
- Results screen: who won, rally stats, latency between players
- "Play again?" or "Share result"
- Result saved to leaderboard

---

## Architecture

```
                   pong.jeka.org
                        │
                   ┌────▼─────┐
                   │  Worker   │  ← Serves UI, routes to rooms
                   │  (edge)   │
                   └────┬──────┘
                        │ WebSocket upgrade
                   ┌────▼──────┐
                   │  Durable  │  ← Game room: state, physics, sync
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
         └───────┘  │+board)│  │(analytics) │
                    └───────┘  └────────────┘
```

### Worker**What it does:**
- Serves the game frontend (canvas-based, single HTML file)
- Routes `/r/:roomId` to the correct Durable Object
- Upgrades HTTP to WebSocket for the game connection
- Generates human-readable room names ("swift-fox", "bold-tiger")
- Serves the leaderboard page and stats

**Code shape:**
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve frontend
    if (url.pathname === '/') return new Response(GAME_HTML, { headers: { 'content-type': 'text/html' }});
    if (url.pathname === '/stats') return handleStats(env);

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
      // Log to D1
      await env.DB.prepare(
        "INSERT INTO rooms (id, created_at, creator_colo) VALUES (?, ?, ?)"
      ).bind(roomId, new Date().toISOString(), request.cf?.colo).run();
      return Response.json({ roomId, url: `https://pong.jeka.org/r/${roomId}` });
    }
  }
};
```

### Durable Object - GameRoom**What it does:**
- Manages one game room (2 players + spectators)
- Runs authoritative game physics at 60fps via `setInterval`
- Broadcasts state to all connected clients via WebSocket
- Stores game state in co-located SQLite (survives hibernation)
- Uses DO Alarm for room cleanup (expire after 30 min of inactivity)

**Why Durable Objects:**
This is the textbook DO use case: Each game room needs:
1. **WebSocket connections** - DO natively supports WebSocket hibernation
2. **Authoritative state** - single-threaded means no physics race conditions
3. **Low latency** - game state and compute in same thread, no DB round-trip
4. **Natural lifecycle** - room exists while game is active, self-destructs after

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
  ball: { x: number, y: number, vx: number, vy: number };
  paddles: [number, number]; // y positions
  scores: [number, number];
  gameLoop: ReturnType<typeof setInterval> | null = null;

  async webSocketMessage(ws: WebSocket, msg: string) {
    const data = JSON.parse(msg);
    if (data.type === 'paddle') {
      // Update paddle position for this player
      const player = this.players.get(ws);
      if (player) this.paddles[player.slot - 1] = data.y;
    }
  }

  startGameLoop() {
    this.gameLoop = setInterval(() => {
      // Update ball position
      this.ball.x += this.ball.vx;
      this.ball.y += this.ball.vy;

      // Wall bounces (top/bottom)
      if (this.ball.y <= 0 || this.ball.y >= 1) this.ball.vy *= -1;

      // Paddle collisions
      // ... (standard pong physics)

      // Scoring
      if (this.ball.x <= 0) { this.scores[1]++; this.resetBall(); }
      if (this.ball.x >= 1) { this.scores[0]++; this.resetBall(); }

      // Broadcast state to all connected players + spectators
      const state = JSON.stringify({
        type: 'state',
        ball: this.ball,
        paddles: this.paddles,
        scores: this.scores
      });
      for (const ws of this.players.keys()) {
        ws.send(state);
      }
    }, 1000 / 60); // 60fps server-side tick
  }

  async alarm() {
    // Room expired - clean up
    // Save final stats to D1 before dying
    await this.saveGameResults();
    // Close all connections
    for (const ws of this.players.keys()) {
      ws.close(1000, "Room expired");
    }
  }
}
```

**Why not a client-side game loop?**
Server-authoritative physics means:
- No cheating (can't modify ball position client-side)
- Both players see identical state
- The DO is the single source of truth
- Latency is the only variable - and Cloudflare's network minimizes it

### D1**What it does:**
- Stores room metadata (who created it, when, from where)
- Stores completed game results (scores, rally stats, duration)
- Powers the leaderboard and "recent games" feed
- Tracks which Cloudflare colos are generating the most games

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
  winner_slot INTEGER,
  final_score TEXT,                  -- "5-3"
  total_rallies INTEGER,
  longest_rally INTEGER,
  game_duration_seconds REAL
);

CREATE TABLE leaderboard (
  player_id TEXT PRIMARY KEY,       -- hash of IP + user-agent (anonymous)
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  longest_rally INTEGER DEFAULT 0,
  games_played INTEGER DEFAULT 0,
  last_played TEXT
);

CREATE INDEX idx_rooms_status ON rooms(status);
CREATE INDEX idx_rooms_created ON rooms(created_at);
CREATE INDEX idx_leaderboard_wins ON leaderboard(wins DESC);
```

### Hyperdrive + Postgres**What it does:**
- Rich analytics on game data:
  - "Players in Tokyo vs London have Xms average latency"
  - "Games created during lunch hours last 40% longer"
  - "The busiest Cloudflare colo for pong is GRU (São Paulo)"
  - Geographic matchup heatmap (which city pairs play most)
- Time-series data for a "Global Pong Activity" live dashboard
- Demonstrates Hyperdrive's query caching on read-heavy analytics

**Why Hyperdrive + Postgres:**
- PostGIS for geographic calculations (distance between players)
- Window functions for trending/ranking queries
- Materialized views for dashboard performance
- Pre-aggregate to avoid NOW() in queries (Hyperdrive cache gotcha)
- Shows the D1-for-app-data + Postgres-for-analytics pattern

**Postgres schema:**
```sql
CREATE TABLE game_events (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,     -- room_created | player_joined | game_started | point_scored | game_ended
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  player_slot INTEGER,
  colo TEXT,
  city TEXT,
  country TEXT,
  latitude FLOAT,
  longitude FLOAT,
  metadata JSONB                -- flexible: { score: "3-2", rally_length: 15, ... }
);

-- Materialized view for the dashboard (cacheable by Hyperdrive)
CREATE MATERIALIZED VIEW hourly_activity AS
SELECT
  date_trunc('hour', timestamp) AS hour,
  COUNT(DISTINCT room_id) AS games,
  COUNT(DISTINCT city) AS cities,
  COUNT(*) FILTER (WHERE event_type = 'point_scored') AS total_points
FROM game_events
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY 1 DESC;

-- Refresh periodically, not per-query (avoids NOW() in live queries)
-- Could use a Cron Trigger Worker to refresh every 5 minutes
```

---

## Frontend

### Game canvas
- HTML5 Canvas, no dependencies
- Renders at 60fps, interpolating between server state updates
- Client-side prediction for paddle movement (immediate response)
- Server reconciliation when authoritative state arrives
- Touch controls for mobile (swipe up/down)

### Visual style
- Retro arcade aesthetic: black background, white paddles/ball, neon score
- Scanline overlay effect (CSS)
- CRT screen curve effect (CSS border-radius trick)
- Satisfying "pock" sound on paddle hits (Web Audio API, tiny)
- Screen shake on scoring

### Screens
1. **Home** (`/`) - "Create Room" button, recent games feed, leaderboard
2. **Waiting** (`/r/swift-fox` with 1 player) - room code displayed large, "Share this link" with copy button, QR code for in-person play
3. **Playing** (`/r/swift-fox` with 2 players) - the game
4. **Game Over** - scores, stats, "Play Again?" button
5. **Spectating** (`/r/swift-fox` with 2 players + extras) - watch live, player count shown
6. **Stats** (`/stats`) - global activity dashboard

### Latency display
Show each player's latency to the DO in real-time (ping/pong WebSocket frames). This is both a game feature AND a Cloudflare network demonstration:
```
Player 1: 12ms (SFO)  |  Player 2: 45ms (FRA)
```

---

## Architecture Dashboard - Real-Time System View

A live dashboard at `pong.jeka.org/dashboard` that visualizes what's happening inside the system in real-time.

### What it shows

```
┌─────────────────────────────────────────────────────────────────┐
│  GLOBAL PONG - ARCHITECTURE DASHBOARD          pong.jeka.org   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─ WORKERS (edge) ──────────────────────────────────────────┐  │
│  │  Requests: 342/min   Colos active: 12   Avg latency: 4ms │  │
│  │  [SFO] [LAX] [ORD] [JFK] [LHR] [FRA] [NRT] [GRU] ...   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                      │
│                     WebSocket upgrade                           │
│                          │                                      │
│  ┌─ DURABLE OBJECTS (game rooms) ────────────────────────────┐  │
│  │                                                           │  │
│  │  Active rooms: 3        Idle (hibernating): 7             │  │
│  │                                                           │  │
│  │  [swift-fox]  ● PLAYING   P1: SFO (12ms) vs P2: FRA (45ms) │
│  │  [bold-tiger] ● WAITING   P1: NRT (8ms)  waiting...      │  │
│  │  [red-panda]  ● PLAYING   P1: GRU (23ms) vs P2: LAX (18ms) │
│  │                                                           │  │
│  │  Game loop tick rate: 60fps   State updates/sec: 180      │  │
│  │  SQLite writes/sec: 12   Alarms pending: 7                │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                      │
│              ┌───────────┼───────────┐                          │
│              │           │           │                          │
│  ┌─ DO SQLite ──┐  ┌─ D1 ────────┐  ┌─ Hyperdrive → PG ────┐  │
│  │ Live state   │  │ Rooms: 156  │  │ Pool: 4/20 active    │  │
│  │ per room     │  │ Players: 89 │  │ Cache hit: 87%       │  │
│  │ (in-thread)  │  │ Avg query:  │  │ Avg query: 12ms      │  │
│  │              │  │   3ms       │  │ (cached: 2ms)        │  │
│  └──────────────┘  └─────────────┘  └───────────────────────┘  │
│                                                                 │
│  ┌─ WORLD MAP ───────────────────────────────────────────────┐  │
│  │  [animated dots showing active players by city]            │  │
│  │  [lines connecting player pairs in active games]           │  │
│  │  [pulse animation when a point is scored]                  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ EVENT STREAM ────────────────────────────────────────────┐  │
│  │  14:23:01  swift-fox    point scored     P1 leads 3-2     │  │
│  │  14:23:00  bold-tiger   player joined    NRT → waiting    │  │
│  │  14:22:58  red-panda    rally: 15 hits   longest today!   │  │
│  │  14:22:55  swift-fox    paddle hit       ball speed: 1.2x │  │
│  │  ...                                                      │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### How it works technically

The dashboard itself connects via WebSocket to a **dedicated "Dashboard" Durable Object** that aggregates events from all game rooms:

1. **Game rooms emit events**: Each GameRoom DO sends events (player joined, point scored, game ended) to the Dashboard DO via Service Binding RPC or by writing to D1
2. **Dashboard DO aggregates**: Collects events, maintains running counters, and pushes updates to all connected dashboard viewers via WebSocket
3. **D1 provides historical data**: Room counts, leaderboard, query timing
4. **Hyperdrive provides analytics**: Cache hit rates, connection pool status, geographic queries
5. **World map**: Uses `request.cf.latitude` / `request.cf.longitude` from player connections to plot dots on a canvas map

### Architecture data sources

| Dashboard Section | Data Source | Update Frequency |
|-------------------|------------|-----------------|
| Workers stats (requests/min, colos) | D1 access_log table + `request.cf.colo` | Every 5 seconds |
| Active rooms list | Dashboard DO (aggregated from game rooms) | Real-time via WebSocket |
| Per-room player latency | GameRoom DO (WebSocket ping/pong) | Real-time |
| DO SQLite stats | GameRoom DO state counters | Real-time |
| D1 query stats | D1 query timing (measured in Worker) | Every 5 seconds |
| Hyperdrive stats | Measured query times (cached vs uncached) | Every 10 seconds |
| World map | D1 player locations (from `request.cf`) | Real-time |
| Event stream | Dashboard DO event buffer | Real-time |

### Why bother with a dashboard
- You can see the entire request lifecycle in one place
- The Hyperdrive section showing cache hit rate vs uncached query time makes the performance difference obvious
- The DO section showing game loop tick rate and SQLite writes makes the co-located compute model visible
- The world map is just cool
- The event stream is a live log of Durable Objects doing their thing

### Implementation
The dashboard is a single HTML page with:
- Canvas for the world map (lightweight, no library)
- WebSocket connection to Dashboard DO for real-time updates
- Periodic fetch to `/api/stats` for D1/Hyperdrive metrics
- CSS grid layout, dark theme matching the game aesthetic
- Auto-updates, no manual refresh needed

---

## Testing

Testing covers unit tests for pure logic, integration tests for the Cloudflare bindings, and end-to-end tests for the full game flow.

### Testing stack
- **Vitest** - fast, TypeScript-native, recommended by Cloudflare
- **`@cloudflare/vitest-pool-workers`** - Cloudflare's official Vitest integration for Workers, D1, and Durable Objects
- **Miniflare** - local Cloudflare simulator (used under the hood by the Vitest pool)

### vitest.config.ts
```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // D1 available in tests via env.DB
          // DO available in tests via env.GAME_ROOM
          // Hyperdrive mocked (can't connect to real Postgres in unit tests)
        },
      },
    },
  },
});
```

### Test categories

#### 1. Physics engine (unit tests) - `tests/physics.test.ts`
The physics module is pure functions with no Cloudflare dependencies. These are fast, simple unit tests.

```typescript
import { describe, it, expect } from 'vitest';
import { updateBall, checkPaddleCollision, checkWallBounce, checkScore } from '../src/physics';

describe('ball movement', () => {
  it('moves ball by velocity each tick', () => {
    const ball = { x: 0.5, y: 0.5, vx: 0.01, vy: 0.005 };
    const next = updateBall(ball);
    expect(next.x).toBe(0.51);
    expect(next.y).toBe(0.505);
  });

  it('bounces off top wall', () => {
    const ball = { x: 0.5, y: 0.01, vx: 0.01, vy: -0.02 };
    const next = checkWallBounce(ball);
    expect(next.vy).toBeGreaterThan(0); // reversed
  });

  it('bounces off bottom wall', () => {
    const ball = { x: 0.5, y: 0.99, vx: 0.01, vy: 0.02 };
    const next = checkWallBounce(ball);
    expect(next.vy).toBeLessThan(0);
  });
});

describe('paddle collision', () => {
  it('detects hit on left paddle', () => {
    const ball = { x: 0.02, y: 0.5, vx: -0.01, vy: 0 };
    const paddleY = 0.5; // paddle center at 0.5, height 0.15
    const result = checkPaddleCollision(ball, paddleY, 'left');
    expect(result.hit).toBe(true);
    expect(result.ball.vx).toBeGreaterThan(0); // reversed
  });

  it('misses when paddle is elsewhere', () => {
    const ball = { x: 0.02, y: 0.5, vx: -0.01, vy: 0 };
    const paddleY = 0.9; // paddle far away
    const result = checkPaddleCollision(ball, paddleY, 'left');
    expect(result.hit).toBe(false);
  });

  it('increases ball speed after each hit', () => {
    const ball = { x: 0.02, y: 0.5, vx: -0.01, vy: 0 };
    const result = checkPaddleCollision(ball, 0.5, 'left');
    expect(Math.abs(result.ball.vx)).toBeGreaterThan(0.01);
  });

  it('adds angle based on where ball hits paddle', () => {
    // Hit top of paddle → ball goes up
    const ball = { x: 0.02, y: 0.42, vx: -0.01, vy: 0 };
    const result = checkPaddleCollision(ball, 0.5, 'left');
    expect(result.ball.vy).toBeLessThan(0); // upward
  });
});

describe('scoring', () => {
  it('scores for player 2 when ball passes left edge', () => {
    const ball = { x: -0.01, y: 0.5, vx: -0.01, vy: 0 };
    const result = checkScore(ball);
    expect(result.scored).toBe(true);
    expect(result.scorer).toBe(2);
  });

  it('scores for player 1 when ball passes right edge', () => {
    const ball = { x: 1.01, y: 0.5, vx: 0.01, vy: 0 };
    const result = checkScore(ball);
    expect(result.scored).toBe(true);
    expect(result.scorer).toBe(1);
  });

  it('no score when ball is in play', () => {
    const ball = { x: 0.5, y: 0.5, vx: 0.01, vy: 0 };
    expect(checkScore(ball).scored).toBe(false);
  });
});
```

#### 2. Room name generator (unit test) - `tests/room-names.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { generateRoomName } from '../src/room-names';

describe('room name generator', () => {
  it('generates adjective-noun format', () => {
    const name = generateRoomName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('generates unique names', () => {
    const names = new Set(Array.from({ length: 100 }, () => generateRoomName()));
    expect(names.size).toBeGreaterThan(90); // at least 90% unique
  });
});
```

#### 3. Durable Object integration tests - `tests/game-room.test.ts`
These use `@cloudflare/vitest-pool-workers` to test the actual DO with real SQLite storage.

```typescript
import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, SELF } from 'cloudflare:test';

describe('GameRoom DO', () => {
  it('accepts first player as Player 1', async () => {
    const id = env.GAME_ROOM.idFromName('test-room-1');
    const stub = env.GAME_ROOM.get(id);

    // Simulate WebSocket upgrade
    const resp = await stub.fetch('http://localhost/ws', {
      headers: { Upgrade: 'websocket' },
    });
    expect(resp.status).toBe(101);
    expect(resp.webSocket).toBeDefined();
  });

  it('accepts second player and starts game', async () => {
    const id = env.GAME_ROOM.idFromName('test-room-2');
    const stub = env.GAME_ROOM.get(id);

    // Player 1 connects
    const resp1 = await stub.fetch('http://localhost/ws', {
      headers: { Upgrade: 'websocket' },
    });
    const ws1 = resp1.webSocket!;
    ws1.accept();

    // Player 2 connects
    const resp2 = await stub.fetch('http://localhost/ws', {
      headers: { Upgrade: 'websocket' },
    });
    const ws2 = resp2.webSocket!;
    ws2.accept();

    // Should receive game_start message
    const messages: string[] = [];
    ws1.addEventListener('message', (e) => messages.push(e.data as string));

    // Wait for game start broadcast
    await new Promise((r) => setTimeout(r, 100));
    const startMsg = messages.find(m => JSON.parse(m).type === 'game_start');
    expect(startMsg).toBeDefined();
  });

  it('rejects third player as spectator', async () => {
    const id = env.GAME_ROOM.idFromName('test-room-3');
    const stub = env.GAME_ROOM.get(id);

    // Fill room
    await stub.fetch('http://localhost/ws', { headers: { Upgrade: 'websocket' } });
    await stub.fetch('http://localhost/ws', { headers: { Upgrade: 'websocket' } });

    // Third connection
    const resp3 = await stub.fetch('http://localhost/ws', {
      headers: { Upgrade: 'websocket' },
    });
    const ws3 = resp3.webSocket!;
    ws3.accept();

    // Should receive spectator role
    const messages: string[] = [];
    ws3.addEventListener('message', (e) => messages.push(e.data as string));
    await new Promise((r) => setTimeout(r, 100));
    const roleMsg = messages.find(m => JSON.parse(m).type === 'role');
    expect(JSON.parse(roleMsg!).role).toBe('spectator');
  });

  it('handles paddle input from correct player', async () => {
    const id = env.GAME_ROOM.idFromName('test-room-4');
    const stub = env.GAME_ROOM.get(id);

    const resp = await stub.fetch('http://localhost/ws', {
      headers: { Upgrade: 'websocket' },
    });
    const ws = resp.webSocket!;
    ws.accept();

    // Send paddle position
    ws.send(JSON.stringify({ type: 'paddle', y: 0.7 }));

    // Should not crash, state should update
    await new Promise((r) => setTimeout(r, 50));
    // If we get here without error, the DO handled it
  });

  it('detects game over at 5 points', async () => {
    // This would test the scoring logic within the DO
    // by simulating enough game ticks for one player to score 5
    // Implementation depends on exposing a test helper or
    // manipulating ball position via messages
  });
});
```

#### 4. D1 integration tests - `tests/d1-queries.test.ts`
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

describe('D1 room operations', () => {
  beforeEach(async () => {
    // Reset D1 tables
    await env.DB.exec('DELETE FROM rooms');
    await env.DB.exec('DELETE FROM leaderboard');
  });

  it('creates a room record', async () => {
    await env.DB.prepare(
      "INSERT INTO rooms (id, created_at, creator_colo) VALUES (?, ?, ?)"
    ).bind('test-room', '2026-03-04T00:00:00Z', 'SFO').run();

    const result = await env.DB.prepare("SELECT * FROM rooms WHERE id = ?")
      .bind('test-room').first();
    expect(result?.id).toBe('test-room');
    expect(result?.status).toBe('waiting');
  });

  it('updates room status to playing', async () => {
    await env.DB.prepare(
      "INSERT INTO rooms (id, created_at, creator_colo) VALUES (?, ?, ?)"
    ).bind('test-room', '2026-03-04T00:00:00Z', 'SFO').run();

    await env.DB.prepare(
      "UPDATE rooms SET status = 'playing', player1_colo = ?, player2_colo = ? WHERE id = ?"
    ).bind('SFO', 'FRA', 'test-room').run();

    const result = await env.DB.prepare("SELECT status FROM rooms WHERE id = ?")
      .bind('test-room').first();
    expect(result?.status).toBe('playing');
  });

  it('returns leaderboard sorted by wins', async () => {
    await env.DB.exec(`
      INSERT INTO leaderboard (player_id, wins, losses, games_played) VALUES
      ('player-a', 10, 3, 13),
      ('player-b', 5, 8, 13),
      ('player-c', 15, 1, 16)
    `);

    const results = await env.DB.prepare(
      "SELECT * FROM leaderboard ORDER BY wins DESC LIMIT 10"
    ).all();
    expect(results.results[0].player_id).toBe('player-c');
    expect(results.results[1].player_id).toBe('player-a');
  });

  it('records game result and updates leaderboard atomically', async () => {
    // Test the batch operation that writes game result + updates leaderboard
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rooms (id, created_at, status, winner_slot, final_score) VALUES (?, ?, 'finished', ?, ?)"
      ).bind('game-1', '2026-03-04T00:00:00Z', 1, '5-3'),
      env.DB.prepare(
        "INSERT INTO leaderboard (player_id, wins, losses, games_played) VALUES (?, 1, 0, 1) ON CONFLICT(player_id) DO UPDATE SET wins = wins + 1, games_played = games_played + 1"
      ).bind('winner-id'),
      env.DB.prepare(
        "INSERT INTO leaderboard (player_id, wins, losses, games_played) VALUES (?, 0, 1, 1) ON CONFLICT(player_id) DO UPDATE SET losses = losses + 1, games_played = games_played + 1"
      ).bind('loser-id'),
    ]);

    const winner = await env.DB.prepare("SELECT * FROM leaderboard WHERE player_id = ?")
      .bind('winner-id').first();
    expect(winner?.wins).toBe(1);
  });
});
```

#### 5. Worker route tests - `tests/worker.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('Worker routes', () => {
  it('serves homepage at /', async () => {
    const resp = await SELF.fetch('http://localhost/');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const text = await resp.text();
    expect(text).toContain('Global Pong');
  });

  it('creates a new room via /api/create', async () => {
    const resp = await SELF.fetch('http://localhost/api/create', { method: 'POST' });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { roomId: string; url: string };
    expect(data.roomId).toMatch(/^[a-z]+-[a-z]+$/);
    expect(data.url).toContain('pong.jeka.org/r/');
  });

  it('routes /r/:roomId to Durable Object', async () => {
    // First create a room
    const createResp = await SELF.fetch('http://localhost/api/create', { method: 'POST' });
    const { roomId } = await createResp.json() as { roomId: string };

    // Then access it (non-WebSocket = should get room info or upgrade prompt)
    const resp = await SELF.fetch(`http://localhost/r/${roomId}`);
    expect(resp.status).toBe(200);
  });

  it('returns 404 for unknown routes', async () => {
    const resp = await SELF.fetch('http://localhost/nonexistent');
    expect(resp.status).toBe(404);
  });

  it('serves stats page at /stats', async () => {
    const resp = await SELF.fetch('http://localhost/stats');
    expect(resp.status).toBe(200);
  });
});
```

#### 6. Hyperdrive analytics tests - `tests/analytics.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { queryGameAnalytics, queryHourlyActivity } from '../src/analytics';

// Hyperdrive can't be tested against real Postgres in unit tests.
// These test the query builders and response parsing.
// Integration testing against real Postgres happens via wrangler dev.

describe('analytics query builders', () => {
  it('builds hourly activity query without NOW()', () => {
    // Important: queries must avoid NOW() for Hyperdrive cache compatibility
    const query = queryHourlyActivity('2026-03-01');
    expect(query.sql).not.toContain('NOW()');
    expect(query.sql).not.toContain('CURRENT_TIMESTAMP');
    expect(query.sql).toContain('$1'); // parameterized date
  });

  it('builds geographic matchup query', () => {
    const query = queryGameAnalytics({ type: 'matchups', limit: 10 });
    expect(query.sql).toContain('GROUP BY');
    expect(query.params).toContain(10);
  });
});
```

### Running tests
```bash
# Run all tests
npx vitest

# Run with watch mode during development
npx vitest --watch

# Run specific test file
npx vitest tests/physics.test.ts

# Run with coverage
npx vitest --coverage
```

### Test/CI configuration in package.json
```json
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ tests/"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20240925.0",
    "vitest": "^2.1.0",
    "typescript": "^5.5.0"
  }
}
```

---

## Project Structure

```
pong/
├── wrangler.toml               # Cloudflare config (Workers, DO, D1, Hyperdrive)
├── vitest.config.ts             # Test config with Cloudflare Workers pool
├── tsconfig.json
├── package.json
├── src/
│   ├── index.ts                 # Worker: routes, room creation, frontend serving
│   ├── game-room.ts             # Durable Object: WebSocket, physics, game state
│   ├── dashboard-do.ts          # Durable Object: aggregates events for dashboard
│   ├── physics.ts               # Ball/paddle physics engine (pure functions, testable)
│   ├── room-names.ts            # Human-readable room name generator
│   ├── d1-queries.ts            # D1: rooms, leaderboard, results
│   ├── analytics.ts             # Hyperdrive: Postgres analytics query builders
│   └── frontend/
│       ├── game.html            # Main game page (canvas + WebSocket client)
│       ├── home.html            # Landing page + leaderboard
│       ├── dashboard.html       # Real-time architecture dashboard
│       ├── stats.html           # Analytics (Hyperdrive-powered)
│       ├── renderer.ts          # Canvas rendering (retro arcade style)
│       └── audio.ts             # Sound effects (Web Audio API)
├── tests/
│   ├── physics.test.ts          # Unit: ball movement, collisions, scoring
│   ├── room-names.test.ts       # Unit: name generation
│   ├── game-room.test.ts        # Integration: DO WebSocket, game lifecycle
│   ├── d1-queries.test.ts       # Integration: D1 room/leaderboard operations
│   ├── worker.test.ts           # Integration: Worker routing, API endpoints
│   └── analytics.test.ts        # Unit: query builders (no real Postgres)
├── schema/
│   ├── d1-schema.sql
│   └── postgres-schema.sql
```

---

## Accounts & Keys - What You Need to Sign Up For

### 1. Cloudflare (you already have an account)
**Upgrade to Workers Paid Plan ($5/mo):**
- Go to: https://dash.cloudflare.com → Workers & Pages → Plans → Select "Workers Paid"
- This unlocks: Durable Objects, D1, Hyperdrive, higher limits

**Get your Cloudflare API token** (for Wrangler CLI):
- Go to: https://dash.cloudflare.com/profile/api-tokens
- Click "Create Token"
- Use the **"Edit Cloudflare Workers"** template (gives access to Workers, D1, DO, R2)
- Copy the token - the OpenClaw bot will need this
- Also note your **Account ID** (visible on any Workers page in the dashboard)

**Keys to provide to OpenClaw:**
```
CLOUDFLARE_API_TOKEN=<your-token>
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
```

### 2. VPS Postgres
**On your VPS**, set up a Postgres database for analytics:
```bash
# Install Postgres if not already present
sudo apt update && sudo apt install postgresql postgresql-contrib

# Create database and user
sudo -u postgres createuser pong_user -P  # set a strong password
sudo -u postgres createdb pong_analytics -O pong_user
```

**Expose Postgres to Hyperdrive (pick one):**

**Option A: Cloudflare Tunnel (recommended - no public port needed)**
```bash
# Install cloudflared on VPS
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
cloudflared tunnel login
cloudflared tunnel create pong-db
# Configure tunnel to forward TCP to localhost:5432
# Use the tunnel hostname in the Hyperdrive connection string
```

**Option B: Public IP (simpler, less secure)**
```bash
# Edit pg_hba.conf to allow Cloudflare IPs
# Edit postgresql.conf: listen_addresses = '*'
sudo systemctl restart postgresql
# Use your VPS public IP in the Hyperdrive connection string
```

**Key to provide to OpenClaw:**
```
POSTGRES_CONNECTION_STRING=postgres://pong_user:PASSWORD@VPS_HOST:5432/pong_analytics
```

### 3. That's it
No other accounts needed. Everything else (DNS, domain, hosting) is already on Cloudflare. Postgres runs on your own VPS.

### Summary for OpenClaw

Give it the spec file path and these credentials:

```
Read the spec at ~/dev/cloudflare/pong-spec.md and build the project.

Credentials:
- Cloudflare API Token: <token>
- Cloudflare Account ID: <account-id>
- VPS Postgres connection string: postgres://pong_user:PASSWORD@VPS_HOST:5432/pong_analytics
- Domain: pong.jeka.org (jeka.org already on Cloudflare DNS)

Steps:
1. Read the full spec
2. Scaffold the project at ~/dev/cloudflare/pong/
3. Install dependencies (wrangler, vitest, @cloudflare/vitest-pool-workers)
4. Implement: Worker, GameRoom DO, Dashboard DO, physics engine, frontend, D1 schema, Hyperdrive analytics
5. Write tests (physics unit tests, DO integration tests, D1 tests, Worker route tests)
6. Run tests to verify everything passes
7. Create the D1 database: wrangler d1 create pong-db
8. Create the Hyperdrive config: wrangler hyperdrive create pong-analytics --connection-string="<postgres-string>"
9. Run D1 migrations
10. Run Postgres migrations against VPS Postgres (psql -f ./schema/postgres-schema.sql)
11. Deploy: wrangler deploy
12. Verify pong.jeka.org loads and works
```

---

## Estimated Build Time

| Component | Time |
|-----------|------|
| Worker routing + room creation | 1 hour |
| Durable Object - GameRoom (WebSocket + game loop) | 2-3 hours |
| Durable Object - Dashboard (event aggregation) | 1-2 hours |
| Physics engine (ball, paddles, collisions, scoring) | 1-2 hours |
| Frontend game canvas (retro style) | 2-3 hours |
| Frontend architecture dashboard | 2-3 hours |
| Client-side prediction + server reconciliation | 1-2 hours |
| D1 schema + leaderboard | 1 hour |
| Hyperdrive + Postgres analytics | 1-2 hours |
| Tests (physics, DO, D1, Worker, analytics) | 2-3 hours |
| Sound effects + polish | 1 hour |
| Mobile touch controls | 30 min |
| Deployment + verification | 1 hour |
| **Total** | **~16-22 hours** |

A working "play pong with someone" demo in a weekend. The architecture dashboard and analytics are stretch goals.

