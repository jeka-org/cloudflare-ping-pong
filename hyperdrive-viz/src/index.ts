import pg from 'pg';

interface Env {
  HYPERDRIVE: Hyperdrive;
}

// Database location (VPS in Amsterdam)
const DB_LAT = 52.3676;
const DB_LON = 4.9041;
const DB_LOCATION = 'Amsterdam, NL';

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function estimateDirectLatency(userLat: number, userLon: number) {
  const distKm = haversine(userLat, userLon, DB_LAT, DB_LON);
  const oneWayMs = distKm / 200; // ~200km/ms fiber speed
  const rttMs = oneWayMs * 2;
  return {
    distanceKm: Math.round(distKm),
    rttMs: Math.round(rttMs * 10) / 10,
    breakdown: {
      tcp_handshake: Math.round(rttMs),
      tls_negotiation: Math.round(rttMs * 3),
      db_auth: Math.round(rttMs * 3),
      query_rtt: Math.round(rttMs),
    },
    totalMs: Math.round(rttMs * 8),
  };
}

const QUERIES: Record<string, { label: string; sql: string; params?: any[] }> = {
  events: {
    label: 'Recent Game Events',
    sql: `SELECT room_id, event_type, player_slot, colo, city, country, metadata, timestamp
          FROM game_events ORDER BY timestamp DESC LIMIT 15`,
  },
  cities: {
    label: 'Top Cities by Games',
    sql: `SELECT city, country, COUNT(DISTINCT room_id) AS games, COUNT(*) AS events
          FROM game_events WHERE city IS NOT NULL
          GROUP BY city, country ORDER BY games DESC LIMIT 15`,
  },
  stats: {
    label: 'Aggregate Stats',
    sql: `SELECT
            COUNT(*) AS total_events,
            COUNT(DISTINCT room_id) AS total_rooms,
            COUNT(DISTINCT city) AS unique_cities,
            COUNT(*) FILTER (WHERE event_type = 'point_scored') AS total_points,
            COUNT(*) FILTER (WHERE event_type = 'game_over') AS games_finished
          FROM game_events`,
  },
  matchups: {
    label: 'Geographic Matchups',
    sql: `SELECT city, country, colo, COUNT(*) as joins, 
            MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
          FROM game_events WHERE event_type = 'player_joined' AND city IS NOT NULL
          GROUP BY city, country, colo ORDER BY joins DESC LIMIT 15`,
  },
};

// Fallback city coordinates for events missing lat/lon
const CITY_COORDS: Record<string, [number, number]> = {
  'Seattle': [47.6062, -122.3321],
  'Amsterdam': [52.3676, 4.9041],
  'London': [51.5074, -0.1278],
  'Tokyo': [35.6762, 139.6503],
  'Singapore': [1.3521, 103.8198],
  'San Francisco': [37.7749, -122.4194],
  'New York': [40.7128, -74.0060],
  'Los Angeles': [34.0522, -118.2437],
  'Paris': [48.8566, 2.3522],
  'Sydney': [-33.8688, 151.2093],
  'Toronto': [43.6532, -79.3832],
  'Berlin': [52.5200, 13.4050],
  'Mumbai': [19.0760, 72.8777],
  'São Paulo': [-23.5505, -46.6333],
  'Dubai': [25.2048, 55.2708],
  'Seoul': [37.5665, 126.9780],
  'Chicago': [41.8781, -87.6298],
  'Austin': [30.2672, -97.7431],
  'Portland': [45.5152, -122.6784],
  'Denver': [39.7392, -104.9903],
  'Miami': [25.7617, -80.1918],
  'Dallas': [32.7767, -96.7970],
  'Atlanta': [33.7490, -84.3880],
  'Vancouver': [49.2827, -123.1207],
  'Phoenix': [33.4484, -112.0740],
  'Sheffield': [53.3811, -1.4701],
  'Manchester': [53.4808, -2.2426],
  'Edinburgh': [55.9533, -3.1883],
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname === '/') {
        return new Response(PAGE_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (url.pathname === '/api/query-replay') {
        const queryType = url.searchParams.get('type') || 'events';
        const queryDef = QUERIES[queryType] || QUERIES.events;

        const cf = request.cf as any;
        const userLat = parseFloat(cf?.latitude) || 47.6;
        const userLon = parseFloat(cf?.longitude) || -122.3;
        const userCity = (cf?.city as string) || 'Unknown';
        const userCountry = (cf?.country as string) || '??';
        const userColo = (cf?.colo as string) || '???';

        const estimated = estimateDirectLatency(userLat, userLon);

        // Measure actual Hyperdrive query
        const startTime = performance.now();
        const client = new pg.Client(env.HYPERDRIVE.connectionString);
        await client.connect();
        const result = await client.query(queryDef.sql);
        await client.end();
        const hyperdriveMs = Math.round((performance.now() - startTime) * 100) / 100;

        return Response.json({
          queryType,
          queryLabel: queryDef.label,
          sql: queryDef.sql.trim(),
          hyperdrive: {
            latencyMs: hyperdriveMs,
            cached: hyperdriveMs < 15,
            rowCount: result.rows.length,
            rows: result.rows,
          },
          estimated_direct: estimated,
          speedup: estimated.totalMs > 0 ? Math.round(estimated.totalMs / Math.max(hyperdriveMs, 1) * 10) / 10 : 0,
          user: {
            city: userCity,
            country: userCountry,
            colo: userColo,
            latitude: userLat,
            longitude: userLon,
          },
          database: {
            location: DB_LOCATION,
            latitude: DB_LAT,
            longitude: DB_LON,
          },
        }, { headers: corsHeaders });
      }

      if (url.pathname === '/api/live-feed') {
        const client = new pg.Client(env.HYPERDRIVE.connectionString);
        const startTime = performance.now();
        await client.connect();
        const result = await client.query(
          `SELECT room_id, event_type, player_slot, colo, city, country, metadata, timestamp
           FROM game_events ORDER BY timestamp DESC LIMIT 20`
        );
        await client.end();
        const latencyMs = Math.round((performance.now() - startTime) * 100) / 100;

        return Response.json({
          events: result.rows,
          queryLatencyMs: latencyMs,
        }, { headers: corsHeaders });
      }

      if (url.pathname === '/api/map-data') {
        const client = new pg.Client(env.HYPERDRIVE.connectionString);
        const startTime = performance.now();
        await client.connect();
        const result = await client.query(
          `SELECT city, country, latitude, longitude, 
                  COUNT(DISTINCT room_id) AS games, COUNT(*) AS events
           FROM game_events 
           WHERE city IS NOT NULL
           GROUP BY city, country, latitude, longitude
           ORDER BY games DESC LIMIT 50`
        );
        await client.end();
        const latencyMs = Math.round((performance.now() - startTime) * 100) / 100;

        // Fill in missing coordinates from fallback map
        const cities = result.rows.map((row: any) => {
          if (!row.latitude && !row.longitude && row.city && CITY_COORDS[row.city]) {
            const [lat, lon] = CITY_COORDS[row.city];
            return { ...row, latitude: lat, longitude: lon };
          }
          return row;
        }).filter((row: any) => row.latitude && row.longitude);

        return Response.json({
          cities,
          queryLatencyMs: latencyMs,
        }, { headers: corsHeaders });
      }

      return new Response('Not found', { status: 404 });
    } catch (err: any) {
      console.error('Error:', err);
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  },
};

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hyperdrive Visualizer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      background: #0a0a0a;
      color: #f5f5f5;
      min-height: 100vh;
      padding: 2rem 1rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    
    /* Header */
    .header { text-align: center; margin-bottom: 3rem; }
    .header h1 {
      font-size: 3rem;
      background: linear-gradient(135deg, #f97316, #fbbf24, #f97316);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      background-clip: text;
      animation: glow 3s ease-in-out infinite alternate;
    }
    @keyframes glow {
      from { filter: drop-shadow(0 0 20px rgba(249,115,22,0.5)); }
      to { filter: drop-shadow(0 0 40px rgba(249,115,22,0.8)); }
    }
    .header .sub { color: #999; margin-top: 0.5rem; font-size: 0.95rem; }
    .header .sub a { color: #f97316; text-decoration: none; }
    
    /* Section titles */
    .section-title {
      font-size: 1.4rem; color: #fbbf24; margin: 2.5rem 0 1.5rem;
      display: flex; align-items: center; gap: 0.5rem;
    }
    
    /* Query Replay */
    .replay-controls {
      display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.5rem; align-items: center;
    }
    .query-btn {
      background: rgba(249,115,22,0.15); border: 1px solid rgba(249,115,22,0.3);
      color: #f5f5f5; padding: 0.5rem 1rem; font-family: inherit; font-size: 0.85rem;
      cursor: pointer; transition: all 0.2s;
    }
    .query-btn:hover { background: rgba(249,115,22,0.25); border-color: #f97316; }
    .query-btn.active { background: rgba(249,115,22,0.3); border-color: #f97316; color: #fbbf24; }
    .run-btn {
      background: linear-gradient(135deg, #f97316, #ea580c); color: #000;
      border: none; padding: 0.5rem 1.5rem; font-family: inherit; font-size: 0.9rem;
      font-weight: bold; cursor: pointer; transition: all 0.2s;
    }
    .run-btn:hover { box-shadow: 0 0 20px rgba(249,115,22,0.5); transform: scale(1.03); }
    .run-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    
    /* Race container */
    .race { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-bottom: 2rem; }
    @media (max-width: 768px) { .race { grid-template-columns: 1fr; } }
    .race-lane {
      background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08);
      padding: 1.5rem; position: relative; min-height: 420px;
    }
    .race-lane h3 { font-size: 1rem; margin-bottom: 1rem; }
    .lane-direct h3 { color: #ef4444; }
    .lane-hyper h3 { color: #22c55e; }
    
    /* Waterfall steps */
    .step {
      display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;
      opacity: 0.2; transition: opacity 0.3s;
    }
    .step.active { opacity: 1; }
    .step.done { opacity: 0.8; }
    .step-label { font-size: 0.75rem; min-width: 120px; }
    .step-bar-wrap { flex: 1; height: 20px; background: rgba(255,255,255,0.05); position: relative; overflow: hidden; }
    .step-bar { height: 100%; width: 0; transition: width 0.3s ease-out; }
    .step-bar.tcp { background: linear-gradient(90deg, #6b7280, #9ca3af); }
    .step-bar.tls { background: linear-gradient(90deg, #3b82f6, #60a5fa); }
    .step-bar.auth { background: linear-gradient(90deg, #8b5cf6, #a78bfa); }
    .step-bar.query { background: linear-gradient(90deg, #f97316, #fbbf24); }
    .step-bar.hyper { background: linear-gradient(90deg, #22c55e, #4ade80); }
    .step-time { font-size: 0.75rem; min-width: 55px; text-align: right; color: #999; }
    
    /* Total time */
    .total-time {
      margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid rgba(255,255,255,0.1);
      font-size: 1.8rem; font-weight: bold; text-align: center;
    }
    .total-time .unit { font-size: 0.9rem; opacity: 0.5; }
    .total-direct { color: #ef4444; }
    .total-hyper { color: #22c55e; }
    
    /* Speedup badge */
    .speedup-badge {
      text-align: center; padding: 1rem; background: rgba(34,197,94,0.1);
      border: 1px solid rgba(34,197,94,0.3); margin-bottom: 2rem; font-size: 1.2rem;
    }
    .speedup-badge .big { font-size: 2.5rem; color: #22c55e; font-weight: bold; }
    
    /* Location info */
    .location-info {
      display: flex; justify-content: space-between; margin-bottom: 1.5rem;
      padding: 0.75rem 1rem; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
      font-size: 0.8rem; color: #999; flex-wrap: wrap; gap: 0.5rem;
    }
    .location-info span { display: flex; align-items: center; gap: 0.3rem; }
    
    /* Query results */
    .results-card {
      background: rgba(249,115,22,0.05); border: 1px solid rgba(249,115,22,0.15);
      padding: 1.25rem; margin-bottom: 1.5rem;
    }
    .results-card h4 { color: #fbbf24; font-size: 0.85rem; margin-bottom: 0.75rem; }
    .results-card .sql {
      background: rgba(0,0,0,0.3); padding: 0.75rem; font-size: 0.7rem;
      color: #999; overflow-x: auto; margin-bottom: 1rem; white-space: pre-wrap; word-break: break-all;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    th { text-align: left; padding: 0.4rem 0.5rem; color: #fbbf24; font-size: 0.7rem;
      text-transform: uppercase; border-bottom: 1px solid rgba(249,115,22,0.2); }
    td { padding: 0.4rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.04); }
    
    /* Live section */
    .live-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    @media (max-width: 768px) { .live-grid { grid-template-columns: 1fr; } }
    .live-grid-full { grid-column: 1 / -1; }
    
    .card {
      background: rgba(249,115,22,0.05); border: 1px solid rgba(249,115,22,0.15);
      padding: 1.25rem;
    }
    .card h4 { color: #fbbf24; font-size: 0.85rem; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
    .live-dot { display: inline-block; width: 7px; height: 7px; background: #22c55e; border-radius: 50%; }
    .query-timing { font-size: 0.7rem; color: #22c55e; opacity: 0.7; margin-left: auto; }
    
    /* World map */
    #mapCanvas { width: 100%; height: 300px; background: rgba(0,0,0,0.3); border: 1px solid rgba(249,115,22,0.1); }
    
    /* Event feed */
    .event-item {
      padding: 0.4rem 0; border-bottom: 1px solid rgba(255,255,255,0.04);
      display: flex; align-items: center; gap: 0.6rem; font-size: 0.8rem;
    }
    .event-icon { font-size: 1rem; min-width: 20px; text-align: center; }
    .event-text { flex: 1; }
    .event-time { font-size: 0.7rem; opacity: 0.4; }
    .event-room { color: #f97316; font-size: 0.75rem; }
    
    /* Stats */
    .stat-row { display: flex; gap: 2rem; flex-wrap: wrap; justify-content: center; }
    .stat { text-align: center; }
    .stat-val { font-size: 2rem; color: #f97316; }
    .stat-lbl { font-size: 0.75rem; opacity: 0.5; }
    
    /* Hyper stats */
    .hyper-stats {
      display: flex; gap: 1.5rem; flex-wrap: wrap; padding: 0.75rem 1rem;
      background: rgba(34,197,94,0.05); border: 1px solid rgba(34,197,94,0.15);
      margin-bottom: 1.5rem; font-size: 0.8rem;
    }
    .hyper-stat { display: flex; align-items: center; gap: 0.4rem; }
    .hyper-stat .label { color: #999; }
    .hyper-stat .value { color: #22c55e; font-weight: bold; }
    
    /* Footer */
    .footer { text-align: center; margin-top: 3rem; font-size: 0.8rem; opacity: 0.3; }
    .footer a { color: #f97316; text-decoration: none; }
    
    /* Waiting state */
    .waiting { opacity: 0.4; font-style: italic; }
    
    /* Fade in animation */
    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    .fade-in { animation: fadeIn 0.3s ease-out; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>&#9889; HYPERDRIVE VISUALIZER</h1>
    <div class="sub">Visualizing Cloudflare Hyperdrive with real data from <a href="https://pong.jeka.org">Global Pong</a></div>
  </div>
  
  <!-- SECTION 1: Query Replay -->
  <div class="section-title">&#127916; Query Replay</div>
  
  <div class="location-info" id="locationInfo">
    <span>&#128205; You: detecting...</span>
    <span>&#128451; DB: ${DB_LOCATION}</span>
    <span>&#128225; Distance: calculating...</span>
  </div>
  
  <div class="replay-controls">
    <button class="query-btn active" data-type="events">Recent Events</button>
    <button class="query-btn" data-type="cities">Top Cities</button>
    <button class="query-btn" data-type="stats">Aggregate Stats</button>
    <button class="query-btn" data-type="matchups">Matchups</button>
    <button class="run-btn" id="runBtn" onclick="runReplay()">&#9654; RUN QUERY</button>
  </div>
  
  <div class="race">
    <!-- Direct Connection Lane -->
    <div class="race-lane lane-direct">
      <h3>&#10060; Direct Connection</h3>
      <div id="directSteps">
        <div class="step" data-step="tcp">
          <span class="step-label">TCP Handshake</span>
          <div class="step-bar-wrap"><div class="step-bar tcp" id="bar-tcp"></div></div>
          <span class="step-time" id="time-tcp">--</span>
        </div>
        <div class="step" data-step="tls1">
          <span class="step-label">TLS ClientHello</span>
          <div class="step-bar-wrap"><div class="step-bar tls" id="bar-tls1"></div></div>
          <span class="step-time" id="time-tls1">--</span>
        </div>
        <div class="step" data-step="tls2">
          <span class="step-label">TLS ServerHello</span>
          <div class="step-bar-wrap"><div class="step-bar tls" id="bar-tls2"></div></div>
          <span class="step-time" id="time-tls2">--</span>
        </div>
        <div class="step" data-step="tls3">
          <span class="step-label">TLS Finished</span>
          <div class="step-bar-wrap"><div class="step-bar tls" id="bar-tls3"></div></div>
          <span class="step-time" id="time-tls3">--</span>
        </div>
        <div class="step" data-step="auth1">
          <span class="step-label">DB StartupMsg</span>
          <div class="step-bar-wrap"><div class="step-bar auth" id="bar-auth1"></div></div>
          <span class="step-time" id="time-auth1">--</span>
        </div>
        <div class="step" data-step="auth2">
          <span class="step-label">DB AuthChallenge</span>
          <div class="step-bar-wrap"><div class="step-bar auth" id="bar-auth2"></div></div>
          <span class="step-time" id="time-auth2">--</span>
        </div>
        <div class="step" data-step="auth3">
          <span class="step-label">DB AuthOK</span>
          <div class="step-bar-wrap"><div class="step-bar auth" id="bar-auth3"></div></div>
          <span class="step-time" id="time-auth3">--</span>
        </div>
        <div class="step" data-step="query">
          <span class="step-label">SQL Query + Response</span>
          <div class="step-bar-wrap"><div class="step-bar query" id="bar-query"></div></div>
          <span class="step-time" id="time-query">--</span>
        </div>
      </div>
      <div class="total-time total-direct" id="directTotal">
        <span id="directCounter">--</span> <span class="unit">ms</span>
      </div>
    </div>
    
    <!-- Hyperdrive Lane -->
    <div class="race-lane lane-hyper">
      <h3>&#9889; Via Hyperdrive</h3>
      <div id="hyperSteps">
        <div class="step" data-step="edge">
          <span class="step-label">Edge Auth</span>
          <div class="step-bar-wrap"><div class="step-bar hyper" id="bar-edge"></div></div>
          <span class="step-time" id="time-edge">--</span>
        </div>
        <div class="step" data-step="pool">
          <span class="step-label">Connection Pool</span>
          <div class="step-bar-wrap"><div class="step-bar hyper" id="bar-pool"></div></div>
          <span class="step-time" id="time-pool">--</span>
        </div>
        <div class="step" data-step="hquery">
          <span class="step-label">SQL Query</span>
          <div class="step-bar-wrap"><div class="step-bar query" id="bar-hquery"></div></div>
          <span class="step-time" id="time-hquery">--</span>
        </div>
      </div>
      <div class="total-time total-hyper" id="hyperTotal">
        <span id="hyperCounter">--</span> <span class="unit">ms</span>
      </div>
      <div id="cacheIndicator" style="text-align:center;margin-top:0.5rem;font-size:0.8rem;color:#22c55e;opacity:0;transition:opacity 0.3s"></div>
    </div>
  </div>
  
  <div class="speedup-badge" id="speedupBadge" style="display:none">
    <div class="big" id="speedupValue">--x</div>
    <div>speedup via Hyperdrive</div>
  </div>
  
  <!-- Query results -->
  <div class="results-card" id="resultsCard" style="display:none">
    <h4>&#128202; Query Results</h4>
    <div class="sql" id="sqlDisplay"></div>
    <div id="resultsTable"></div>
  </div>
  
  <!-- SECTION 2: Live from Global Pong -->
  <div class="section-title"><span class="live-dot"></span> Live from Global Pong</div>
  
  <div class="hyper-stats" id="hyperStats">
    <div class="hyper-stat"><span class="label">Queries:</span> <span class="value" id="statQueries">0</span></div>
    <div class="hyper-stat"><span class="label">Avg latency:</span> <span class="value" id="statAvgLatency">--</span></div>
    <div class="hyper-stat"><span class="label">Cache hits:</span> <span class="value" id="statCacheHits">0%</span></div>
    <div class="hyper-stat"><span class="label">Total saved:</span> <span class="value" id="statTimeSaved">--</span></div>
  </div>
  
  <div class="live-grid">
    <div class="card live-grid-full">
      <h4><span class="live-dot"></span> World Map <span class="query-timing" id="mapTiming"></span></h4>
      <canvas id="mapCanvas"></canvas>
    </div>
    <div class="card">
      <h4><span class="live-dot"></span> Live Event Feed <span class="query-timing" id="feedTiming"></span></h4>
      <div id="liveFeed" class="waiting">Loading events...</div>
    </div>
    <div class="card">
      <h4>&#128200; Global Pong Stats <span class="query-timing" id="statsTiming"></span></h4>
      <div id="globalStats" class="waiting">Loading stats...</div>
    </div>
  </div>
  
  <div style="text-align:center;margin-top:2rem">
    <a href="https://pong.jeka.org" style="background:linear-gradient(135deg,#f97316,#ea580c);color:#000;padding:0.75rem 2rem;font-family:inherit;font-weight:bold;text-decoration:none;font-size:1rem;display:inline-block">&#127955; Play Global Pong</a>
  </div>
  
  <div class="footer">
    Built by <a href="https://spark.jeka.org">Spark</a> &bull;
    Data from <a href="https://pong.jeka.org">pong.jeka.org</a> &bull;
    Powered by Cloudflare Workers + Hyperdrive
  </div>
</div>

<script>
// ---- State ----
let selectedQuery = 'events';
let queryStats = { count: 0, totalMs: 0, cacheHits: 0, directSaved: 0 };
let lastData = null;

// ---- Query type selection ----
document.querySelectorAll('.query-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.query-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedQuery = btn.dataset.type;
  });
});

// ---- Helpers ----
function timeAgo(ts) {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm';
  return Math.floor(s/3600) + 'h';
}

function trackQuery(latencyMs, cached, estimatedDirectMs) {
  queryStats.count++;
  queryStats.totalMs += latencyMs;
  if (cached) queryStats.cacheHits++;
  queryStats.directSaved += (estimatedDirectMs - latencyMs);
  
  document.getElementById('statQueries').textContent = queryStats.count;
  document.getElementById('statAvgLatency').textContent = Math.round(queryStats.totalMs / queryStats.count) + 'ms';
  document.getElementById('statCacheHits').textContent = Math.round(queryStats.cacheHits / queryStats.count * 100) + '%';
  document.getElementById('statTimeSaved').textContent = Math.round(queryStats.directSaved) + 'ms';
}

// ---- Query Replay ----
async function runReplay() {
  const runBtn = document.getElementById('runBtn');
  runBtn.disabled = true;
  runBtn.textContent = 'QUERYING...';
  
  // Reset steps
  document.querySelectorAll('.step').forEach(s => { s.classList.remove('active', 'done'); });
  document.querySelectorAll('[id^="bar-"]').forEach(b => { b.style.width = '0'; });
  document.querySelectorAll('[id^="time-"]').forEach(t => { t.textContent = '--'; });
  document.getElementById('directCounter').textContent = '--';
  document.getElementById('hyperCounter').textContent = '--';
  document.getElementById('speedupBadge').style.display = 'none';
  document.getElementById('cacheIndicator').style.opacity = '0';
  
  try {
    const res = await fetch('/api/query-replay?type=' + selectedQuery);
    const data = await res.json();
    lastData = data;
    
    if (data.error) {
      runBtn.disabled = false;
      runBtn.textContent = '\\u25b6 RUN QUERY';
      alert('Query error: ' + data.error);
      return;
    }
    
    // Update location info
    document.getElementById('locationInfo').innerHTML =
      '<span>\\ud83d\\udccd You: ' + data.user.city + ', ' + data.user.country + ' (' + data.user.colo + ')</span>' +
      '<span>\\ud83d\\uddb3 DB: ' + data.database.location + '</span>' +
      '<span>\\ud83d\\udce1 Distance: ' + data.estimated_direct.distanceKm.toLocaleString() + ' km (' + data.estimated_direct.rttMs + 'ms RTT)</span>';
    
    // Track stats
    trackQuery(data.hyperdrive.latencyMs, data.hyperdrive.cached, data.estimated_direct.totalMs);
    
    // Animate Hyperdrive side (fast!)
    animateHyperdrive(data);
    
    // Animate Direct side (slow, step by step)
    await animateDirect(data);
    
    // Show speedup
    const badge = document.getElementById('speedupBadge');
    badge.style.display = 'block';
    document.getElementById('speedupValue').textContent = data.speedup + 'x';
    
    // Show results
    showResults(data);
    
  } catch (err) {
    console.error(err);
  }
  
  runBtn.disabled = false;
  runBtn.textContent = '\\u25b6 RUN QUERY';
}

function animateHyperdrive(data) {
  const hyperMs = data.hyperdrive.latencyMs;
  const cached = data.hyperdrive.cached;
  
  // Edge auth: ~1ms
  const edgeMs = Math.min(1, hyperMs * 0.05);
  const poolMs = Math.min(2, hyperMs * 0.1);
  const queryMs = hyperMs - edgeMs - poolMs;
  
  // Animate instantly (relative to direct side)
  setTimeout(() => {
    const el = document.querySelector('[data-step="edge"]');
    el.classList.add('active');
    document.getElementById('bar-edge').style.width = '100%';
    document.getElementById('time-edge').textContent = '<1ms';
    setTimeout(() => el.classList.add('done'), 100);
  }, 50);
  
  setTimeout(() => {
    const el = document.querySelector('#hyperSteps [data-step="pool"]');
    el.classList.add('active');
    document.getElementById('bar-pool').style.width = '100%';
    document.getElementById('time-pool').textContent = cached ? 'CACHED' : '<2ms';
    setTimeout(() => el.classList.add('done'), 100);
  }, 150);
  
  setTimeout(() => {
    const el = document.querySelector('[data-step="hquery"]');
    el.classList.add('active');
    document.getElementById('bar-hquery').style.width = '100%';
    document.getElementById('time-hquery').textContent = Math.round(queryMs) + 'ms';
    setTimeout(() => el.classList.add('done'), 100);
    
    document.getElementById('hyperCounter').textContent = hyperMs;
    
    if (cached) {
      const ci = document.getElementById('cacheIndicator');
      ci.textContent = '\\u2728 Cache hit! Query served from edge.';
      ci.style.opacity = '1';
    }
  }, 300);
}

async function animateDirect(data) {
  const bd = data.estimated_direct.breakdown;
  const rtt = data.estimated_direct.rttMs;
  const steps = [
    { id: 'tcp', ms: bd.tcp_handshake, label: bd.tcp_handshake + 'ms' },
    { id: 'tls1', ms: rtt, label: Math.round(rtt) + 'ms' },
    { id: 'tls2', ms: rtt, label: Math.round(rtt) + 'ms' },
    { id: 'tls3', ms: rtt, label: Math.round(rtt) + 'ms' },
    { id: 'auth1', ms: rtt, label: Math.round(rtt) + 'ms' },
    { id: 'auth2', ms: rtt, label: Math.round(rtt) + 'ms' },
    { id: 'auth3', ms: rtt, label: Math.round(rtt) + 'ms' },
    { id: 'query', ms: rtt, label: Math.round(rtt) + 'ms' },
  ];
  
  // Scale animation: we don't want to wait the ACTUAL time (could be seconds)
  // Instead, animate proportionally over ~3-4 seconds
  const totalEstimated = data.estimated_direct.totalMs;
  const animScale = 3000 / Math.max(totalEstimated, 1);
  let runningTotal = 0;
  
  for (const step of steps) {
    const stepEl = document.querySelector('#directSteps [data-step="' + step.id + '"]');
    stepEl.classList.add('active');
    
    const animDuration = Math.max(step.ms * animScale, 80);
    document.getElementById('bar-' + step.id).style.transition = 'width ' + animDuration + 'ms ease-out';
    document.getElementById('bar-' + step.id).style.width = '100%';
    
    await new Promise(r => setTimeout(r, animDuration));
    
    runningTotal += step.ms;
    document.getElementById('time-' + step.id).textContent = step.label;
    document.getElementById('directCounter').textContent = Math.round(runningTotal);
    stepEl.classList.add('done');
  }
}

function showResults(data) {
  document.getElementById('resultsCard').style.display = 'block';
  document.getElementById('sqlDisplay').textContent = data.sql;
  
  const rows = data.hyperdrive.rows;
  if (!rows || rows.length === 0) {
    document.getElementById('resultsTable').innerHTML = '<div class="waiting">No data yet. <a href="https://pong.jeka.org" style="color:#f97316">Play a game!</a></div>';
    return;
  }
  
  const keys = Object.keys(rows[0]);
  let html = '<table><tr>';
  keys.forEach(k => { html += '<th>' + k + '</th>'; });
  html += '</tr>';
  rows.slice(0, 10).forEach(row => {
    html += '<tr>';
    keys.forEach(k => {
      let val = row[k];
      if (val && typeof val === 'object') val = JSON.stringify(val);
      if (typeof val === 'string' && val.length > 40) val = val.substring(0, 37) + '...';
      html += '<td>' + (val !== null && val !== undefined ? val : '-') + '</td>';
    });
    html += '</tr>';
  });
  html += '</table>';
  if (rows.length > 10) html += '<div style="font-size:0.7rem;opacity:0.4;margin-top:0.5rem">Showing 10 of ' + rows.length + ' rows</div>';
  document.getElementById('resultsTable').innerHTML = html;
}

// ---- Live Feed ----
async function loadLiveFeed() {
  try {
    const res = await fetch('/api/live-feed');
    const data = await res.json();
    
    document.getElementById('feedTiming').textContent = 'Hyperdrive: ' + data.queryLatencyMs + 'ms';
    trackQuery(data.queryLatencyMs, data.queryLatencyMs < 15, 200);
    
    const icons = { player_joined: '\\ud83c\\udfae', point_scored: '\\u26a1', game_over: '\\ud83c\\udfc6' };
    const el = document.getElementById('liveFeed');
    
    if (data.events && data.events.length > 0) {
      el.innerHTML = data.events.slice(0, 12).map(e => {
        const icon = icons[e.event_type] || '\\u2022';
        const meta = e.metadata ? (typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata) : {};
        let detail = '';
        if (e.event_type === 'player_joined') detail = (meta.name || 'Player') + ' from ' + (e.city || '?');
        else if (e.event_type === 'point_scored') detail = (meta.score1||0) + '-' + (meta.score2||0);
        else if (e.event_type === 'game_over') detail = 'Winner: P' + (e.player_slot||'?');
        
        return '<div class="event-item fade-in">' +
          '<span class="event-icon">' + icon + '</span>' +
          '<div class="event-text"><span class="event-room">' + (e.room_id||'') + '</span> ' + detail + '</div>' +
          '<span class="event-time">' + timeAgo(e.timestamp) + '</span></div>';
      }).join('');
      el.classList.remove('waiting');
    } else {
      el.innerHTML = '<div class="waiting">No events yet. <a href="https://pong.jeka.org" style="color:#f97316">Play a game!</a></div>';
    }
  } catch (err) { console.error('Feed error:', err); }
}

// ---- Global Stats ----
async function loadGlobalStats() {
  try {
    const res = await fetch('/api/query-replay?type=stats');
    const data = await res.json();
    
    document.getElementById('statsTiming').textContent = 'Hyperdrive: ' + data.hyperdrive.latencyMs + 'ms';
    trackQuery(data.hyperdrive.latencyMs, data.hyperdrive.cached, data.estimated_direct.totalMs);
    
    const s = data.hyperdrive.rows[0] || {};
    document.getElementById('globalStats').innerHTML =
      '<div class="stat-row">' +
      '<div class="stat"><div class="stat-val">' + (s.total_rooms || 0) + '</div><div class="stat-lbl">Games</div></div>' +
      '<div class="stat"><div class="stat-val">' + (s.total_events || 0) + '</div><div class="stat-lbl">Events</div></div>' +
      '<div class="stat"><div class="stat-val">' + (s.unique_cities || 0) + '</div><div class="stat-lbl">Cities</div></div>' +
      '<div class="stat"><div class="stat-val">' + (s.total_points || 0) + '</div><div class="stat-lbl">Points</div></div>' +
      '<div class="stat"><div class="stat-val">' + (s.games_finished || 0) + '</div><div class="stat-lbl">Finished</div></div>' +
      '</div>';
    document.getElementById('globalStats').classList.remove('waiting');
  } catch (err) { console.error('Stats error:', err); }
}

// ---- World Map ----
function drawMap(cities) {
  const canvas = document.getElementById('mapCanvas');
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * 2;
  canvas.height = rect.height * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  const w = rect.width;
  const h = rect.height;
  
  // Background
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);
  
  // Simple world outline (equirectangular)
  // Draw a grid for reference
  ctx.strokeStyle = 'rgba(249,115,22,0.08)';
  ctx.lineWidth = 0.5;
  for (let lat = -60; lat <= 80; lat += 30) {
    const y = h/2 - (lat / 180) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  for (let lon = -180; lon <= 180; lon += 60) {
    const x = w/2 + (lon / 360) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  
  // Label axes
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.font = '9px Courier New';
  ctx.fillText('90\\u00b0N', 2, h/2 - (90/180)*h + 10);
  ctx.fillText('0\\u00b0', 2, h/2 + 3);
  ctx.fillText('90\\u00b0S', 2, h/2 + (90/180)*h - 2);
  
  if (!cities || cities.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '14px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('No location data yet. Play Global Pong!', w/2, h/2);
    return;
  }
  
  const maxGames = Math.max(...cities.map(c => parseInt(c.games)));
  
  // Draw city dots
  cities.forEach(city => {
    const lat = parseFloat(city.latitude);
    const lon = parseFloat(city.longitude);
    const x = w/2 + (lon / 360) * w;
    const y = h/2 - (lat / 180) * h;
    const games = parseInt(city.games);
    const radius = Math.max(3, (games / maxGames) * 15);
    
    // Outer glow
    ctx.fillStyle = 'rgba(249,115,22,0.15)';
    ctx.beginPath();
    ctx.arc(x, y, radius * 2.5, 0, Math.PI * 2);
    ctx.fill();
    
    // Main dot
    ctx.fillStyle = 'rgba(249,115,22,0.8)';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    
    // Core
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.4, 0, Math.PI * 2);
    ctx.fill();
    
    // Label
    if (games > 1 || cities.length < 15) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '9px Courier New';
      ctx.textAlign = 'center';
      ctx.fillText(city.city + ' (' + games + ')', x, y - radius - 4);
    }
  });
}

async function loadMapData() {
  try {
    const res = await fetch('/api/map-data');
    const data = await res.json();
    document.getElementById('mapTiming').textContent = 'Hyperdrive: ' + data.queryLatencyMs + 'ms';
    trackQuery(data.queryLatencyMs, data.queryLatencyMs < 15, 200);
    drawMap(data.cities);
  } catch (err) {
    console.error('Map error:', err);
    drawMap([]);
  }
}

// ---- Init ----
loadLiveFeed();
loadGlobalStats();
loadMapData();

// Auto-refresh
setInterval(loadLiveFeed, 5000);
setInterval(loadGlobalStats, 15000);
setInterval(loadMapData, 30000);

// Resize map on window resize
window.addEventListener('resize', () => { if (lastData) loadMapData(); else drawMap([]); });

// Auto-run first query on load
setTimeout(runReplay, 500);
</script>
</body>
</html>`;
