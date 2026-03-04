# Hyperdrive Visualizer - Build Spec

## What This Is
An interactive web page that visualizes how Cloudflare Hyperdrive works, using REAL data from our Global Pong game (pong.jeka.org). Deployed as a Cloudflare Worker at `hyperdrive.jeka.org`.

## Two Core Sections

### Section 1: "Query Replay" - Live Proof
The page itself queries the same Postgres database that Global Pong uses, via Hyperdrive. On load (and on a "Run Query" button), it:

1. **Fires a real query through Hyperdrive** to the pong analytics Postgres DB (e.g., "SELECT count of games, top cities, recent events from game_events"). Times it precisely (performance.now()).
2. **Calculates what the direct connection would have cost** based on the user's approximate location (from request.cf) and the database location (Virginia/the VPS at 46.225.65.112 which is in Europe). Uses great-circle distance to compute realistic latency for the 7 round trips (TCP 1x, TLS 3x, auth 3x) plus the query itself.
3. **Displays both side by side** with a visual timeline:
   - Left: "Direct Connection" - animated timeline showing each of the 7 handshake steps with realistic delay. Each step labeled (TCP SYN/ACK, TLS ClientHello, TLS ServerHello, TLS Finished, Auth Request, Auth Challenge, Auth OK, then finally the Query + Response).
   - Right: "Via Hyperdrive" - shows the actual measured time. Edge auth (near-zero), pooled connection (near-zero), single query round trip. Highlights cached vs uncached.
4. **Shows the REAL query results** from Global Pong below both timelines - recent game events, top cities, total games played. This is live data from pong.jeka.org's Postgres.
5. **"Run Again" button** - fires another query, shows fresh timing. Toggle between different queries (recent events, top cities, game stats) to show cached vs uncached behavior.

### Section 2: "Live from Global Pong" - Real System Dashboard  
A live view of the pong analytics data flowing through Hyperdrive:

1. **World map** (canvas-based, lightweight) showing cities where games have been played as glowing dots. Lines connecting player pairs. Dot size = number of games from that city.
2. **Live event feed** pulling from the pong game_events table via Hyperdrive - shows player_joined, point_scored, game_over events in real time.
3. **Hyperdrive stats overlay**: Each API call to the Postgres DB shows its timing in a small overlay: "Hyperdrive: 14ms (cached)" or "Hyperdrive: 48ms (uncached)". Accumulates a running average and cache hit rate.
4. **"Play a game to generate data" CTA** - links to pong.jeka.org to drive traffic.

## Technical Architecture

### Stack
- **Cloudflare Worker** (TypeScript)
- **Same Hyperdrive binding** as Global Pong (same Postgres DB: pong_analytics on the VPS)
- **Single HTML page** served inline from the Worker (same pattern as Global Pong)
- **Canvas** for world map visualization
- **No external dependencies** on the frontend (vanilla JS + Canvas)

### Worker Structure
```
hyperdrive-viz/
├── wrangler.toml          # Worker config, Hyperdrive binding
├── src/
│   └── index.ts           # Worker: serves page + API endpoints
├── package.json
└── tsconfig.json
```

### API Endpoints (Worker)
- `GET /` - serves the visualization page
- `GET /api/query-replay` - fires a timed query to Postgres via Hyperdrive, returns results + timing + user location info
- `GET /api/query-replay?type=cities` - different query for cache comparison
- `GET /api/query-replay?type=events` - recent events query
- `GET /api/query-replay?type=stats` - aggregate stats query
- `GET /api/live-feed` - recent game events for the live dashboard
- `GET /api/map-data` - city-level aggregates with lat/long for the world map

### Query Replay API Response Shape
```json
{
  "query": "SELECT ... (the actual SQL that ran)",
  "hyperdrive": {
    "latencyMs": 14,
    "cached": true,
    "rows": [...actual results...]
  },
  "estimated_direct": {
    "latencyMs": 487,
    "breakdown": {
      "tcp_handshake": 68,
      "tls_negotiation": 204,
      "db_auth": 204,
      "query_rtt": 11
    }
  },
  "user": {
    "city": "Tokyo",
    "country": "JP",
    "colo": "NRT",
    "latitude": 35.6762,
    "longitude": 139.6503
  },
  "database": {
    "location": "Amsterdam, NL",
    "latitude": 52.3676,
    "longitude": 4.9041
  }
}
```

### Estimating Direct Connection Latency
The VPS (database) is at 46.225.65.112 (Amsterdam area). Use request.cf.latitude/longitude for the user's location.

```
distance_km = haversine(user_lat, user_lon, db_lat, db_lon)
one_way_ms = distance_km / 200  // ~200km/ms for fiber (speed of light in fiber * overhead)
rtt_ms = one_way_ms * 2

// Direct connection: 7 round trips before query
tcp_handshake = 1 * rtt_ms      // SYN + SYN-ACK
tls_negotiation = 3 * rtt_ms    // ClientHello, ServerHello+Cert, Finished
db_auth = 3 * rtt_ms            // StartupMessage, AuthRequest, AuthOK
query_rtt = 1 * rtt_ms          // The actual query

total_direct = tcp_handshake + tls_negotiation + db_auth + query_rtt  // = 8 * rtt_ms
```

For Hyperdrive: measure actual time of the pg query (performance.now before/after).

### World Map
Use a simplified equirectangular world map projection drawn with Canvas paths (or a minimal SVG map as background). Plot cities from the game_events table as orange glowing dots. No heavy map library needed.

City coordinates come from the `latitude` and `longitude` columns in game_events (populated from request.cf when players join).

### wrangler.toml
```toml
name = "hyperdrive-viz"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

routes = [
  { pattern = "hyperdrive.jeka.org", custom_domain = true }
]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "ccb1ff52dfd043809598a5a3bbcaaca9"
localConnectionString = "postgres://pong_user:aeqhbtOnb3GRiQPudS2tKtAt@localhost:5432/pong_analytics"
```

## Visual Design

### Style
- Dark theme matching Global Pong (black background, orange/amber accents)
- Ember/fire aesthetic (warm glows, orange gradients)
- Monospace font (Courier New)
- Clean, not cluttered - let the data breathe
- Responsive (works on mobile)

### Query Replay Animation
The "Direct Connection" side should animate the 7 steps as a vertical waterfall/timeline:
- Each step appears one at a time with the calculated delay
- Shows the step name, a progress bar filling, and the time it took
- Steps cascade like a waterfall chart
- Color-coded: TCP = gray, TLS = blue, Auth = purple, Query = orange
- Total time counter at the bottom ticking up

The "Hyperdrive" side starts simultaneously but resolves almost instantly:
- Shows "Edge Auth ✓" (near-zero), "Pool Hit ✓" (near-zero), then the query time
- The actual Hyperdrive result populates immediately while the "Direct" side is still animating through its handshakes
- This creates the visceral "holy crap that's fast" moment

### Header
```
⚡ HYPERDRIVE VISUALIZER
See how Cloudflare Hyperdrive makes databases fast, using real data from Global Pong
```

### Footer
```
Built by Spark • Data from pong.jeka.org • Powered by Cloudflare Workers + Hyperdrive
```

## Important Implementation Notes

1. **Use `pg` (node-postgres) package** for Postgres via Hyperdrive, same as Global Pong
2. **CORS headers** on all API endpoints (Access-Control-Allow-Origin: *)
3. **The estimated direct latency is calculated server-side** using request.cf geolocation
4. **Cache behavior**: Hyperdrive caches read queries. Running the same query twice should show the second one as cached (faster). Different query types help demonstrate this.
5. **No actual direct connection is made** - we only estimate it. The Hyperdrive query is the only real DB call.
6. **Error handling**: If Postgres is down or Hyperdrive fails, show a graceful error state
7. **Make the page feel alive** - subtle animations, pulsing dots, the live feed auto-refreshing

## Postgres Connection
Same database as Global Pong:
- Host: 46.225.65.112 (VPS in Amsterdam)
- Database: pong_analytics  
- User: pong_user
- The Hyperdrive config (id: ccb1ff52dfd043809598a5a3bbcaaca9) already points to this DB

## Database Schema (already exists, read-only access)
```sql
CREATE TABLE game_events (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,     -- player_joined, point_scored, game_over
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  player_slot INTEGER,
  colo TEXT,
  city TEXT,
  country TEXT,
  latitude FLOAT,
  longitude FLOAT,
  metadata JSONB
);
```

## Deploy
```bash
cd /root/dev/cloudflare/hyperdrive-viz
npm install
npx wrangler deploy
```

Cloudflare credentials are already configured (wrangler is authenticated). The domain jeka.org is on Cloudflare DNS, so `hyperdrive.jeka.org` will auto-provision.
