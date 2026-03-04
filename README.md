# Global Pong - Real-Time Multiplayer on Cloudflare's Edge

**Live at:** `pong.jeka.org`  
**Stack:** Workers + Durable Objects + D1 + Hyperdrive + Postgres

Real-time multiplayer pong running entirely on Cloudflare's edge. Two players connect via WebSocket to a Durable Object that runs authoritative game physics server-side.

---

## Features

- **Real-time multiplayer** - WebSocket connections to Durable Objects
- **AI opponent** - Play solo against a smart (but beatable) AI
- **Live analytics dashboard** - See global activity, player cities, top games in real-time
- **Auto-generated player names** - "Swift Fox" vs "Bold Tiger"
- **Geographic matchups** - Players from different cities/countries
- **Retro aesthetic** - Ember-themed (orange/purple) with CRT scanlines
- **Cloud + flare atmosphere** - Drifting clouds and rising embers around game canvas
- **Sound effects** - Satisfying paddle hits via Web Audio API
- **Latency display** - Shows ping to Cloudflare's edge in real-time

---

## How to Play

### Multiplayer
1. Visit `pong.jeka.org`
2. Click **CREATE ROOM** → get a shareable link like `pong.jeka.org/r/swift-fox`
3. Share with opponent
4. Both players see **START GAME** button when connected
5. Either clicks START → 3-2-1 countdown → play!
6. First to 5 points wins

### vs AI
1. Click **PLAY VS AI 🤖**
2. Game starts immediately
3. AI tracks the ball with slight imperfection - challenging but beatable

---

## Architecture

```
pong.jeka.org (Worker)
    │
    ├─ WebSocket upgrade
    │     ↓
    │  Durable Object (game room)
    │     ├─ DO SQLite (live state)
    │     ├─ D1 (rooms + leaderboard)
    │     └─ Hyperdrive → Postgres (analytics)
    │
    └─ Homepage w/ live dashboard
```

### Why These Products?

| Product | Role | Why Not Alternatives |
|---------|------|---------------------|
| **Workers** | Routes requests, serves UI | Sub-ms cold starts. `request.cf` gives geo data for free |
| **Durable Objects** | Game room physics + WebSocket | Single-threaded = no race conditions. WebSocket hibernation = idle rooms free. Textbook DO use case |
| **D1** | Room metadata, leaderboard | Cross-entity queries. Better than DO for aggregation |
| **Hyperdrive + Postgres** | Rich analytics | Window functions, PostGIS, CTEs - analytics queries more natural in Postgres |

---

## Game Physics

- **Server-authoritative** - All physics runs in the Durable Object, no client prediction for ball
- **60fps game loop** - `setInterval` in DO, state broadcast to clients
- **Client-side paddle prediction** - Your paddle moves instantly, server reconciles
- **Collision detection** - Paddle hits add spin based on where ball strikes
- **Progressive difficulty** - Ball speeds up after each paddle hit

---

## Deploy Your Own

### Prerequisites
- Cloudflare Workers Paid plan ($5/mo) for DO, D1, Hyperdrive
- Postgres instance (local, VPS, or cloud)

### Steps

```bash
# 1. Create D1 database
wrangler d1 create pong-db
wrangler d1 execute pong-db --file=./schema/d1-schema.sql

# 2. Create Hyperdrive config
wrangler hyperdrive create pong-analytics \
  --connection-string="postgres://user:pass@host:5432/pong_analytics"

# 3. Run Postgres migrations
psql $POSTGRES_URL -f ./schema/postgres-schema.sql

# 4. Update wrangler.toml with created IDs

# 5. Deploy
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
database_id = "<from wrangler d1 create>"

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<from wrangler hyperdrive create>"
```

---

## Project Structure

```
pong/
├── wrangler.toml
├── src/
│   ├── index.ts              # Worker: routing, homepage, API
│   ├── game-room.ts          # Durable Object: game loop + WebSocket
│   ├── physics.ts            # Ball/paddle collision logic
│   ├── room-names.ts         # "swift-fox" generator
│   ├── d1-queries.ts         # D1 room/leaderboard queries
│   └── analytics.ts          # Hyperdrive analytics queries
├── schema/
│   ├── d1-schema.sql
│   └── postgres-schema.sql
└── tests/
    ├── physics.test.ts
    ├── game-room.test.ts
    └── worker.test.ts
```

---

## Tech Highlights

### Durable Objects
Each game room is an isolated DO instance with:
- WebSocket connections (hibernating when idle)
- 60fps game loop via `setInterval`
- Co-located SQLite for game state (zero-latency reads)
- DO Alarms for auto-cleanup after 30min inactivity

### D1
Stores room metadata and completed games:
```sql
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  status TEXT,  -- waiting | playing | finished
  player1_name TEXT,
  player2_name TEXT,
  player1_city TEXT,
  player2_city TEXT,
  final_score TEXT,
  longest_rally INTEGER,
  game_duration_seconds REAL
);
```

### Hyperdrive + Postgres
Analytics via Postgres with Hyperdrive connection pooling + query caching:
```sql
-- Live event stream
SELECT room_id, event_type, city, timestamp, metadata
FROM game_events
ORDER BY timestamp DESC
LIMIT 20;

-- Geographic activity
SELECT city, country, COUNT(*) AS games
FROM game_events
WHERE event_type = 'player_joined'
GROUP BY city, country
ORDER BY games DESC;
```

---

## Visual Design

- **Spark theme** - Warm ember colors (orange/gold) + purple accents
- **Atmosphere** - Drifting cloud shapes + rising ember particles around canvas
- **Retro CRT** - Scanline overlay, glowing paddles, fire-themed shadows
- **Canvas rendering** - 60fps interpolation between server state updates
- **Sound** - Web Audio API for paddle hits, scoring

---

## Live Dashboard

The homepage features a real-time dashboard showing:
- **Live event feed** - Player joins, scores, game overs (updates every 3s)
- **24h activity** - Bar chart of games by hour
- **Top cities** - Where players are connecting from
- **Top games** - Highest scores + longest rallies
- **Recent games** - Completed matches with player names + cities

Data sources:
- **Live events** - Postgres via Hyperdrive (game_events table)
- **Aggregated stats** - Postgres analytics queries
- **Recent games** - D1 (rooms table)

---

## Testing

Uses **Vitest** with `@cloudflare/vitest-pool-workers` for testing Workers, D1, and Durable Objects in a local Miniflare environment.

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

Test categories:
- **Unit**: Physics engine, room name generation
- **Integration**: Durable Object WebSocket flow, D1 queries, Worker routing
- **End-to-end**: Full game lifecycle (manual via wrangler dev)

---

## Performance Notes

### Client-side optimizations
- Cached canvas gradients (no re-creation per frame)
- Ball glow uses translucent circles instead of expensive `shadowBlur`
- Paddle prediction eliminates input lag
- State interpolation between server updates (smooth 60fps visuals)

### Server-side optimizations
- Throttled paddle sends (15/sec max, was unlimited)
- Zero allocations in physics loop (flat variables, no object spread)
- WebSocket hibernation for idle rooms
- DO Alarms for automatic cleanup

### Database optimizations
- D1 indexed on status + created_at for "Recent Games"
- Postgres materialized views for dashboard (avoids NOW() for Hyperdrive cache)
- Hyperdrive query caching (~87% hit rate on analytics queries)

---

## Credits

Built by **[Spark](https://spark.jeka.org)** ✨

Deployed on Cloudflare Workers + Durable Objects + D1 + Hyperdrive
