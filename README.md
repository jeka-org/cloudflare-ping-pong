# Global Pong 🔥🏓

Real-time multiplayer pong on Cloudflare's edge.

**Live:** [pong.jeka.org](https://pong.jeka.org)
**Stack:** Workers + Durable Objects + D1 + Hyperdrive + Postgres

---

## Features

- **Multiplayer** - Create a room, share the link, play via WebSocket
- **AI opponent** - Solo play against a beatable AI with reaction delays
- **Auto-generated names** - "Swift Fox" vs "Bold Tiger", AI shows as "AI 🤖"
- **Live dashboard** - Event feed, 24h activity, top cities, top games (on homepage)
- **Recent games** - Completed matches with player names, cities, scores
- **Latency display** - Shows ping to the Durable Object during gameplay
- **Retro visuals** - Ember palette, scanline overlay, glowing ball, screen shake
- **Cloud + flare atmosphere** - Drifting clouds and rising embers around game canvas
- **Sound effects** - Web Audio API paddle hits and score sounds
- **Spectator mode** - Third+ connections watch in real-time

---

## How to Play

### Multiplayer
1. Visit [pong.jeka.org](https://pong.jeka.org)
2. Click **CREATE ROOM** and share the link
3. Opponent joins, either player clicks **START GAME**
4. First to 5 wins

### vs AI
1. Click **PLAY VS AI 🤖**
2. Game starts after countdown

---

## Architecture

```
                   pong.jeka.org
                        │
                   ┌────▼─────┐
                   │  Worker   │  Serves UI, routes to rooms, API
                   │  (edge)   │
                   └────┬──────┘
                        │
                   ┌────▼──────┐
                   │  Durable  │  Game room: physics, WebSockets, AI
                   │  Object   │  (one DO per active game)
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

| Product | Role |
|---------|------|
| **Workers** | Serves UI, routes HTTP, API endpoints. `request.cf` gives player geo for free |
| **Durable Objects** | Each game room is an isolated DO. Physics loop, WebSocket management, AI logic, co-located SQLite |
| **D1** | Room metadata, game results, recent games feed |
| **Hyperdrive + Postgres** | Analytics: live event feed, activity charts, geographic data |

---

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Homepage with live dashboard |
| `/r/:roomId` | GET/WS | Game page / WebSocket connection |
| `/api/create` | POST | Create new room |
| `/api/stats` | GET | Active games, total games, players |
| `/api/recent` | GET | Recent completed games |
| `/api/analytics` | GET | 24h activity, top cities, top games |
| `/api/events/live` | GET | Last 20 raw game events |
| `/api/event` | POST | Log analytics event |

---

## Project Structure

```
pong/
├── wrangler.toml            # Workers, DO, D1, Hyperdrive config
├── src/
│   ├── index.ts             # Worker: routes, API, homepage + game HTML
│   ├── game-room.ts         # Durable Object: WebSocket, physics, AI
│   ├── physics.ts           # Ball/paddle physics (pure functions)
│   ├── room-names.ts        # Room + player name generator
│   └── d1-queries.ts        # D1 room/game queries
└── schema/
    ├── d1-schema.sql        # Rooms + leaderboard tables
    └── postgres-schema.sql  # game_events table
```

---

## Deploy

```bash
# Create D1 database
wrangler d1 create pong-db
wrangler d1 execute pong-db --file=./schema/d1-schema.sql

# Create Hyperdrive config
wrangler hyperdrive create pong-analytics \
  --connection-string="postgres://user:pass@host:5432/pong_analytics"

# Run Postgres migrations
psql $POSTGRES_URL -f ./schema/postgres-schema.sql

# Deploy
wrangler deploy
```

Requires Cloudflare Workers Paid plan ($5/mo) and a Postgres instance.

---

## Why Durable Objects?

Traditional multiplayer: a server process manages all rooms. Crashes kill all games. Scaling requires sharding + routing.

With DOs: each room is an isolated instance with its own compute thread and storage. Cloudflare handles routing. Rooms scale horizontally by definition. WebSocket hibernation means empty rooms cost nothing.

---

Built by [Spark](https://spark.jeka.org) ✨
