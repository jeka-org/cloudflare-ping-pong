// Main Worker - routes HTTP requests, serves UI, creates rooms

import { GameRoom } from './game-room';
import { LobbyRoom } from './lobby-room';
import { generateRoomName } from './room-names';
import {
  createRoom,
  getRoom,
  getRecentGames,
  getLeaderboard,
  getGlobalStats,
  cleanStaleRooms,
} from './d1-queries';
import pg from 'pg';

export { GameRoom, LobbyRoom };

interface Env {
  GAME_ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  DB: D1Database;
  HYPERDRIVE: Hyperdrive;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // CORS headers for API endpoints
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    try {
      // Serve homepage
      if (url.pathname === '/') {
        return new Response(HOME_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      
      // API: Create new room (Fix 10: collision retry)
      if (url.pathname === '/api/create' && request.method === 'POST') {
        const cf = request.cf;
        let roomId: string | null = null;
        
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidateId = generateRoomName();
          try {
            const existing = await getRoom(env.DB, candidateId);
            if (existing) continue; // collision, retry
            
            await createRoom(
              env.DB,
              candidateId,
              (cf?.colo as string) || null,
              (cf?.city as string) || null,
              (cf?.country as string) || null
            );
            roomId = candidateId;
            break;
          } catch (err) {
            // D1 unique constraint violation = collision, retry
            continue;
          }
        }
        
        if (!roomId) {
          return Response.json(
            { error: 'Server busy, please try again' },
            { status: 503, headers: corsHeaders }
          );
        }
        
        return Response.json(
          {
            roomId,
            url: `https://${url.hostname}/r/${roomId}`,
          },
          { headers: corsHeaders }
        );
      }
      
      // API: Get recent games
      if (url.pathname === '/api/recent') {
        const games = await getRecentGames(env.DB, 10);
        return Response.json({ games }, { headers: corsHeaders });
      }
      
      // API: Get leaderboard
      if (url.pathname === '/api/leaderboard') {
        const leaderboard = await getLeaderboard(env.DB, 20);
        return Response.json({ leaderboard }, { headers: corsHeaders });
      }
      
      // API: Get global stats (Fix 11: clean stale rooms)
      if (url.pathname === '/api/stats') {
        await cleanStaleRooms(env.DB).catch(() => {});
        const stats = await getGlobalStats(env.DB);
        return Response.json({ stats }, { headers: corsHeaders });
      }
      
      // API: Log analytics event to Postgres via Hyperdrive
      if (url.pathname === '/api/event' && request.method === 'POST') {
        try {
          const event = await request.json() as any;
          const client = new pg.Client(env.HYPERDRIVE.connectionString);
          await client.connect();
          await client.query(
            `INSERT INTO game_events (room_id, event_type, player_slot, colo, city, country, latitude, longitude, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [event.room_id, event.event_type, event.player_slot, event.colo, event.city, event.country, event.latitude, event.longitude, JSON.stringify(event.metadata || {})]
          );
          await client.end();
          return Response.json({ ok: true }, { headers: corsHeaders });
        } catch (err: any) {
          console.error('Analytics event error:', err);
          return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
        }
      }
      
      // API: Analytics data from Postgres
      if (url.pathname === '/api/analytics') {
        try {
          const client = new pg.Client(env.HYPERDRIVE.connectionString);
          await client.connect();
          
          const [activity, cities, topGames, eventCount] = await Promise.all([
            client.query(
              `SELECT date_trunc('hour', timestamp) AS hour, COUNT(DISTINCT room_id) AS games, COUNT(*) AS events
               FROM game_events WHERE timestamp > NOW() - INTERVAL '24 hours'
               GROUP BY 1 ORDER BY 1 DESC LIMIT 24`
            ),
            client.query(
              `SELECT city, country, COUNT(DISTINCT room_id) AS games, COUNT(*) AS events
               FROM game_events WHERE city IS NOT NULL
               GROUP BY city, country ORDER BY games DESC LIMIT 20`
            ),
            client.query(
              `SELECT room_id, 
                      COUNT(*) FILTER (WHERE event_type = 'point_scored') AS points,
                      MAX((metadata->>'rally_hits')::int) AS longest_rally,
                      MAX((metadata->>'duration_seconds')::int) AS duration
               FROM game_events 
               WHERE event_type IN ('point_scored', 'game_over')
               GROUP BY room_id ORDER BY longest_rally DESC NULLS LAST LIMIT 10`
            ),
            client.query(`SELECT COUNT(*) AS total, COUNT(DISTINCT room_id) AS rooms FROM game_events`),
          ]);
          
          await client.end();
          
          return Response.json({
            activity: activity.rows,
            cities: cities.rows,
            topGames: topGames.rows,
            totals: eventCount.rows[0],
          }, { headers: corsHeaders });
        } catch (err: any) {
          console.error('Analytics query error:', err);
          return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
        }
      }
      
      // API: Recent live events
      if (url.pathname === '/api/events/live') {
        try {
          const client = new pg.Client(env.HYPERDRIVE.connectionString);
          await client.connect();
          const result = await client.query(
            `SELECT room_id, event_type, player_slot, colo, city, country, metadata, timestamp
             FROM game_events ORDER BY timestamp DESC LIMIT 20`
          );
          await client.end();
          return Response.json({ events: result.rows }, { headers: corsHeaders });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
        }
      }
      
      // API: Get lobby room list (HTTP fallback, Fix 11: clean stale)
      if (url.pathname === '/api/lobby') {
        await cleanStaleRooms(env.DB).catch(() => {});
        try {
          const lobbyId = env.LOBBY.idFromName('global');
          const lobby = env.LOBBY.get(lobbyId);
          const response = await lobby.fetch('https://lobby/list');
          const data = await response.json() as any;
          return Response.json(data, { headers: corsHeaders });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
        }
      }
      
      // WebSocket: Live lobby updates
      if (url.pathname === '/ws/lobby') {
        try {
          const lobbyId = env.LOBBY.idFromName('global');
          const lobby = env.LOBBY.get(lobbyId);
          return lobby.fetch(request);
        } catch (err: any) {
          return new Response(`Lobby error: ${err.message}`, { status: 500 });
        }
      }
      
      // Analytics dashboard page (both paths)
      if (url.pathname === '/analytics' || url.pathname === '/dashboard') {
        return new Response(ANALYTICS_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      
      // Route to game room (both game page and WebSocket)
      if (url.pathname.startsWith('/r/')) {
        const roomId = url.pathname.split('/')[2];
        
        if (!roomId) {
          return new Response('Room ID required', { status: 400 });
        }
        
        const upgradeHeader = request.headers.get('Upgrade');
        
        if (upgradeHeader === 'websocket') {
          // Route WebSocket to Durable Object (DO also rejects terminal states)
          const id = env.GAME_ROOM.idFromName(roomId);
          const stub = env.GAME_ROOM.get(id);
          return stub.fetch(request);
        } else {
          // Fix 5: Check D1 before serving game HTML
          try {
            const room = await getRoom(env.DB, roomId);
            if (!room || room.status === 'expired') {
              return new Response(ERROR_HTML('This room has expired or does not exist.'), {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                status: 404,
              });
            }
            if (['finished', 'disconnected', 'abandoned'].includes(room.status)) {
              return new Response(ERROR_HTML('This game has ended.'), {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                status: 410,
              });
            }
          } catch (err) {
            // D1 error - serve page anyway (room might be new)
            console.error('D1 room check error:', err);
          }
          
          return new Response(GAME_HTML, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
      }
      
      // 404 for unknown routes
      return new Response('Not found', { status: 404 });
    } catch (err: any) {
      console.error('Error handling request:', err);
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  },
};

// Fix 5: Error page for expired/ended rooms
function ERROR_HTML(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Global Pong - Room Not Available</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      background: #0a0a0a;
      color: #f5f5f5;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 40px 20px;
    }
    h1 { font-size: 2rem; color: #f97316; margin-bottom: 1rem; }
    p { font-size: 1.2rem; opacity: 0.7; margin-bottom: 2rem; text-align: center; }
    a {
      background: linear-gradient(135deg, #f97316, #ea580c);
      color: #000;
      text-decoration: none;
      padding: 1rem 3rem;
      font-size: 1.2rem;
      font-weight: bold;
      font-family: 'Courier New', monospace;
    }
    a:hover { box-shadow: 0 0 30px rgba(249,115,22,0.5); }
  </style>
</head>
<body>
  <h1>🏓 Room Not Available</h1>
  <p>${message}</p>
  <a href="/">Back to Lobby</a>
</body>
</html>`;
}

// Inline HTML - Frontend will be defined below
const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Global Pong - Real-Time Multiplayer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      background: #0a0a0a;
      color: #f5f5f5;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      padding: 40px 20px 20px;
      position: relative;
    }
    body::before {
      content: '';
      position: fixed;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at center, rgba(249,115,22,0.08) 0%, transparent 60%);
      animation: ember-pulse 6s ease-in-out infinite alternate;
      pointer-events: none;
      z-index: 0;
    }
    @keyframes ember-pulse {
      from { opacity: 0.4; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1.05); }
    }
    h1 {
      font-size: 4rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #f97316, #fbbf24, #f97316);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      text-shadow: none;
      animation: title-glow 3s ease-in-out infinite alternate;
      position: relative;
      z-index: 1;
    }
    @keyframes title-glow {
      from { filter: drop-shadow(0 0 20px rgba(249,115,22,0.5)); }
      to { filter: drop-shadow(0 0 40px rgba(249,115,22,0.8)) drop-shadow(0 0 60px rgba(251,191,36,0.3)); }
    }
    .spark-badge {
      font-size: 0.9rem;
      color: #f97316;
      margin-bottom: 0.5rem;
      opacity: 0.9;
      position: relative;
      z-index: 1;
    }
    .subtitle {
      font-size: 1.2rem;
      margin-bottom: 3rem;
      opacity: 0.6;
      position: relative;
      z-index: 1;
    }
    .button {
      background: linear-gradient(135deg, #f97316, #ea580c);
      color: #000;
      border: none;
      padding: 1rem 3rem;
      font-size: 1.5rem;
      font-family: 'Courier New', monospace;
      font-weight: bold;
      cursor: pointer;
      box-shadow: 0 0 20px rgba(249,115,22,0.4);
      transition: all 0.3s;
      position: relative;
      z-index: 1;
    }
    .button:hover {
      box-shadow: 0 0 40px rgba(249,115,22,0.6), 0 0 60px rgba(251,191,36,0.3);
      transform: scale(1.05);
    }
    .button:active {
      transform: scale(0.95);
    }
    .button-secondary {
      background: linear-gradient(135deg, #7c3aed, #6d28d9);
      box-shadow: 0 0 20px rgba(124,58,237,0.4);
    }
    .button-secondary:hover {
      box-shadow: 0 0 40px rgba(124,58,237,0.6), 0 0 60px rgba(139,92,246,0.3);
    }
    .stats {
      margin-top: 2rem;
      display: flex;
      gap: 3rem;
      flex-wrap: wrap;
      justify-content: center;
      position: relative;
      z-index: 1;
    }
    .stat { text-align: center; }
    .stat-value { font-size: 3rem; color: #f97316; text-shadow: 0 0 10px rgba(249,115,22,0.5); }
    .stat-label { font-size: 0.9rem; opacity: 0.5; margin-top: 0.3rem; }
    .dashboard {
      margin-top: 3rem;
      width: 100%;
      max-width: 1000px;
      position: relative;
      z-index: 1;
    }
    .dash-header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }
    .dash-header h2 { font-size: 1.3rem; color: #fbbf24; }
    .live-dot { display: inline-block; width: 8px; height: 8px; background: #22c55e; border-radius: 50%; }
    .dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .dash-grid-full { grid-column: 1 / -1; }
    .card {
      background: rgba(249,115,22,0.05);
      border: 1px solid rgba(249,115,22,0.2);
      padding: 1.2rem;
    }
    .card h3 { color: #fbbf24; font-size: 0.9rem; margin-bottom: 0.8rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid rgba(249,115,22,0.1); }
    th { color: #fbbf24; font-size: 0.7rem; text-transform: uppercase; }
    td { font-size: 0.85rem; }
    .bar-container { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
    .bar { height: 12px; background: linear-gradient(90deg, #f97316, #fbbf24); min-width: 2px; transition: width 0.3s; }
    .event-feed { }
    .event-item { padding: 0.4rem 0; border-bottom: 1px solid rgba(249,115,22,0.08); display: flex; align-items: center; gap: 0.6rem; animation: fadeIn 0.3s; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .event-icon { font-size: 1.1rem; min-width: 22px; text-align: center; }
    .event-text { font-size: 0.8rem; flex: 1; }
    .event-time { font-size: 0.7rem; opacity: 0.4; min-width: 45px; text-align: right; }
    .event-room { color: #f97316; font-size: 0.75rem; }
    .loading { opacity: 0.5; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
    .footer {
      margin-top: 3rem;
      font-size: 0.8rem;
      opacity: 0.3;
      position: relative;
      z-index: 1;
    }
    .footer a { color: #f97316; text-decoration: none; }
    .footer a:hover { opacity: 0.8; }
    @media (max-width: 768px) { .dash-grid { grid-template-columns: 1fr; } }
    
    /* Lobby Section - Fix 15: Brighter border with glow */
    .lobby-section {
      width: 100%;
      max-width: 1000px;
      margin: 2rem auto 2rem;
      padding: 2rem;
      background: rgba(25,25,25,0.8);
      border: 2px solid rgba(249,115,22,0.5);
      border-radius: 12px;
      backdrop-filter: blur(10px);
      position: relative;
      z-index: 1;
      box-shadow: 0 0 20px rgba(249,115,22,0.3), 0 0 40px rgba(249,115,22,0.1);
    }
    .lobby-rooms {
      margin-top: 1.5rem;
    }
    .lobby-rooms.loading {
      text-align: center;
      opacity: 0.5;
      padding: 2rem;
    }
    .lobby-empty {
      text-align: center;
      opacity: 0.6;
      padding: 2rem;
    }
    .lobby-category {
      margin: 1.5rem 0 1rem;
    }
    .lobby-category h3 {
      font-size: 1rem;
      color: #fbbf24;
      opacity: 0.8;
      text-transform: uppercase;
    }
    .lobby-room {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.5rem 2rem;
      margin-bottom: 1rem;
      background: rgba(30,30,30,0.5);
      border: 1px solid rgba(249,115,22,0.2);
      border-radius: 8px;
      transition: all 0.3s ease;
      animation: roomFadeIn 0.3s ease;
    }
    @keyframes roomFadeIn {
      from { opacity: 0; max-height: 0; }
      to { opacity: 1; max-height: 200px; }
    }
    .lobby-room:hover {
      border-color: rgba(249,115,22,0.5);
      background: rgba(40,40,40,0.6);
    }
    .lobby-room-info {
      flex: 1;
    }
    .lobby-room-name {
      font-weight: bold;
      color: #fbbf24;
      margin-bottom: 0.25rem;
    }
    .lobby-room-players {
      font-size: 1.1rem;
      opacity: 0.7;
    }
    .lobby-room-score {
      font-size: 1.3rem;
      font-weight: bold;
      margin-top: 0.25rem;
      color: #f97316;
    }
    .btn-join, .btn-spectate, .btn-secondary {
      padding: 0.5rem 1.5rem;
      font-family: 'Courier New', monospace;
      font-size: 0.9rem;
      font-weight: bold;
      border: 2px solid;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      background: transparent;
    }
    .btn-join {
      color: #0a0a0a;
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      border-color: #fbbf24;
      min-width: 140px;
      height: 48px;
      font-size: 1rem;
    }
    .btn-join:hover {
      box-shadow: 0 0 20px rgba(251,191,36,0.5);
      transform: scale(1.05);
    }
    .btn-spectate {
      color: #a78bfa;
      border-color: #a78bfa;
      min-width: 140px;
      height: 48px;
      font-size: 1rem;
    }
    .btn-spectate:hover {
      background: #a78bfa;
      color: #0a0a0a;
      box-shadow: 0 0 20px rgba(167,139,250,0.4);
    }
    .lobby-empty-actions {
      display: flex;
      gap: 1rem;
      justify-content: center;
      margin-top: 1.5rem;
    }
    .btn-secondary {
      color: #f97316;
      border-color: #f97316;
    }
    .btn-secondary:hover {
      background: #f97316;
      color: #0a0a0a;
      box-shadow: 0 0 20px rgba(249,115,22,0.4);
    }
  </style>
</head>
<body>
  <h1>🔥 GLOBAL PONG 🔥</h1>
  <div class="subtitle">Real-Time Multiplayer on Cloudflare's Edge</div>
  
  <button class="button" id="createBtn">CREATE ROOM</button>
  <button class="button button-secondary" id="aiBtn" style="margin-top: 0.5rem;">PLAY VS AI 🤖</button>
  
  <!-- Fix 15: Live Lobby Section - immediately after hero buttons -->
  <div class="lobby-section">
    <div class="dash-header">
      <span class="live-dot"></span>
      <h2>🏓 ACTIVE GAMES</h2>
    </div>
    
    <div id="lobbyRooms" class="lobby-rooms loading">
      Connecting to lobby...
    </div>
  </div>
  
  <div class="stats">
    <div class="stat">
      <div class="stat-value" id="totalGames">--</div>
      <div class="stat-label">Total Games</div>
    </div>
    <div class="stat">
      <div class="stat-value" id="activeGames">--</div>
      <div class="stat-label">Active Now</div>
    </div>
    <div class="stat">
      <div class="stat-value" id="totalPlayers">--</div>
      <div class="stat-label">Players</div>
    </div>
  </div>

  <div class="dashboard">
    <div class="dash-header">
      <span class="live-dot"></span>
      <h2>LIVE DASHBOARD</h2>
      <span style="opacity:0.4;font-size:0.75rem;margin-left:0.5rem">Hyperdrive + Postgres</span>
    </div>
    
    <div class="dash-grid">
      <div class="card dash-grid-full">
        <h3>LIVE EVENT FEED</h3>
        <div id="liveFeed" class="event-feed loading">Waiting for events...</div>
      </div>
      <div class="card">
        <h3>ACTIVITY (24H)</h3>
        <div id="activity" class="loading">Loading...</div>
      </div>
      <div class="card">
        <h3>TOP CITIES</h3>
        <div id="cities" class="loading">Loading...</div>
      </div>
      <div class="card">
        <h3>TOP GAMES</h3>
        <div id="topGames" class="loading">Loading...</div>
      </div>
      <div class="card">
        <h3>TOTALS</h3>
        <div id="totals" class="loading">Loading...</div>
      </div>
    </div>
  </div>

  <script>
    // Only update DOM if content changed (prevents blink)
    function setHTML(el, html) { if (el && el.innerHTML !== html) el.innerHTML = html; }
    
    const eventIcons = { player_joined: '🎮', point_scored: '⚡', game_over: '🏆' };
    const eventLabels = { player_joined: 'Player joined', point_scored: 'Point scored', game_over: 'Game over' };
    
    function timeAgo(ts) {
      const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
      if (s < 5) return 'now';
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s/60) + 'm';
      return Math.floor(s/3600) + 'h';
    }
    
    function renderEvent(e) {
      const icon = eventIcons[e.event_type] || '•';
      const label = eventLabels[e.event_type] || e.event_type;
      let detail = '';
      if (e.event_type === 'player_joined') {
        const m0 = e.metadata ? (typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata) : {}; detail = (m0.name ? m0.name + ' from ' : '') + (e.city || 'Unknown') + (e.country ? ', ' + e.country : '') + (e.colo ? ' (via ' + e.colo + ')' : '');
      } else if (e.event_type === 'point_scored' && e.metadata) {
        const m = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
        detail = (m.score1||0) + '-' + (m.score2||0) + (m.rally_hits ? ' (' + m.rally_hits + ' hits)' : '');
      } else if (e.event_type === 'game_over' && e.metadata) {
        const m = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
        detail = 'P' + (e.player_slot||'?') + ' wins | ' + (m.score1||0) + '-' + (m.score2||0) + (m.duration_seconds ? ' | ' + m.duration_seconds + 's' : '');
      }
      return '<div class="event-item">' +
        '<span class="event-icon">' + icon + '</span>' +
        '<div class="event-text">' + label + '<br><span class="event-room">' + (e.room_id||'') + '</span> <span style="opacity:0.5;font-size:0.75rem">' + detail + '</span></div>' +
        '<span class="event-time">' + timeAgo(e.timestamp) + '</span></div>';
    }
    
    async function loadLiveFeed() {
      try {
        const res = await fetch('/api/events/live');
        const data = await res.json();
        const el = document.getElementById('liveFeed');
        if (data.events && data.events.length > 0) {
          setHTML(el, data.events.slice(0, 10).map(renderEvent).join(''));
        } else {
          setHTML(el, '<span style="opacity:0.5">No events yet. Play a game!</span>');
        }
        el.classList.remove('loading');
      } catch (err) { console.error('Live feed error:', err); }
    }
    
    async function loadStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('totalGames').textContent = data.stats.total_games;
        document.getElementById('activeGames').textContent = data.stats.active_games;
        document.getElementById('totalPlayers').textContent = data.stats.total_players;
      } catch (err) { console.error('Stats error:', err); }
    }
    
    async function loadAnalytics() {
      try {
        const res = await fetch('/api/analytics');
        const data = await res.json();
        if (data.error) return;
        
        const actEl = document.getElementById('activity');
        if (data.activity.length === 0) {
          setHTML(actEl, '<span style="opacity:0.5">No activity in last 24h</span>');
        } else {
          const maxG = Math.max(...data.activity.map(a => parseInt(a.games)));
          setHTML(actEl, data.activity.slice(0,12).map(a => {
            const hr = new Date(a.hour).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
            const pct = Math.max(5, (parseInt(a.games)/maxG)*100);
            return '<div class="bar-container"><span style="min-width:50px;font-size:0.7rem">' + hr + '</span><div class="bar" style="width:' + pct + '%"></div><span style="font-size:0.7rem;opacity:0.5">' + a.games + '</span></div>';
          }).join(''));
        }
        actEl.classList.remove('loading');
        
        const citEl = document.getElementById('cities');
        if (data.cities.length === 0) {
          setHTML(citEl, '<span style="opacity:0.5">No city data yet</span>');
        } else {
          setHTML(citEl, '<table><tr><th>City</th><th>Country</th><th>Games</th></tr>' +
            data.cities.slice(0,8).map(c => '<tr><td>' + c.city + '</td><td>' + (c.country||'?') + '</td><td style="color:#f97316">' + c.games + '</td></tr>').join('') + '</table>');
        }
        citEl.classList.remove('loading');
        
        const topEl = document.getElementById('topGames');
        if (data.topGames && data.topGames.length > 0) {
          setHTML(topEl, '<table><tr><th>Room</th><th>Best Rally</th><th>Points</th></tr>' +
            data.topGames.slice(0,8).map(g => '<tr><td style="font-size:0.75rem">' + g.room_id + '</td><td style="color:#f97316">' + (g.longest_rally||0) + ' hits</td><td>' + (g.points||0) + '</td></tr>').join('') + '</table>');
        } else {
          setHTML(topEl, '<span style="opacity:0.5">No games yet</span>');
        }
        topEl.classList.remove('loading');
        
        const totEl = document.getElementById('totals');
        if (data.totals) {
          setHTML(totEl, '<div style="display:flex;gap:2rem;justify-content:center">' +
            '<div style="text-align:center"><div style="font-size:2rem;color:#f97316">' + (data.totals.total||0) + '</div><div style="font-size:0.75rem;opacity:0.5">Events</div></div>' +
            '<div style="text-align:center"><div style="font-size:2rem;color:#fbbf24">' + (data.totals.rooms||0) + '</div><div style="font-size:0.75rem;opacity:0.5">Rooms</div></div></div>');
        } else {
          setHTML(totEl, '<span style="opacity:0.5">No data</span>');
        }
        totEl.classList.remove('loading');
      } catch (err) { console.error('Analytics error:', err); }
    }
    
    // Create room
    document.getElementById('createBtn').addEventListener('click', async () => {
      const btn = document.getElementById('createBtn');
      btn.disabled = true; btn.textContent = 'CREATING...';
      try {
        const res = await fetch('/api/create', { method: 'POST' });
        const data = await res.json();
        window.location.href = data.url;
      } catch (err) {
        alert('Error creating room.');
        btn.disabled = false; btn.textContent = 'CREATE ROOM';
      }
    });
    
    // Play vs AI
    document.getElementById('aiBtn').addEventListener('click', async () => {
      const btn = document.getElementById('aiBtn');
      btn.disabled = true; btn.textContent = 'CREATING...';
      try {
        const res = await fetch('/api/create', { method: 'POST' });
        const data = await res.json();
        window.location.href = data.url + '?ai=true';
      } catch (err) {
        alert('Error creating room.');
        btn.disabled = false; btn.textContent = 'PLAY VS AI 🤖';
      }
    });
    
    // Live Lobby WebSocket
    function connectLobby() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = proto + '//' + location.host + '/ws/lobby';
      const ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        console.log('Lobby connected');
        ws.send(JSON.stringify({ type: 'subscribe' }));
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'lobby_state' || data.type === 'lobby_update') {
            renderLobby(data.rooms || []);
          }
        } catch (err) {
          console.error('Lobby message error:', err);
        }
      };
      
      ws.onerror = (err) => {
        console.error('Lobby WebSocket error:', err);
      };
      
      ws.onclose = () => {
        console.log('Lobby disconnected, reconnecting in 3s...');
        setTimeout(connectLobby, 3000);
      };
    }
    
    function renderLobby(rooms) {
      const el = document.getElementById('lobbyRooms');
      el.classList.remove('loading');
      
      if (!rooms || rooms.length === 0) {
        setHTML(el, '<div class="lobby-empty"><p style="margin-bottom:0">No active games right now</p><div class="lobby-empty-actions"><button onclick="document.getElementById(&quot;createBtn&quot;).click()" class="btn-join">CREATE ROOM</button><button onclick="document.getElementById(&quot;aiBtn&quot;).click()" class="btn-spectate">PLAY VS AI 🤖</button></div></div>');
        return;
      }
      
      // Separate waiting vs playing rooms
      const waiting = rooms.filter(r => r.status === 'waiting' || r.status === 'ready');
      const playing = rooms.filter(r => r.status === 'playing');
      
      let html = '';
      
      if (waiting.length > 0) {
        html += '<div class="lobby-category"><h3>🟡 WAITING FOR PLAYER</h3></div>';
        waiting.forEach(r => {
          const p1 = r.player1Name || 'Player 1';
          const p1Loc = r.player1City ? r.player1City + (r.player1Colo ? ' (' + r.player1Colo + ')' : '') : (r.player1Colo || '');
          html += '<div class="lobby-room">';
          html += '<div class="lobby-room-info">';
          html += '<div class="lobby-room-name">' + r.roomId + '</div>';
          html += '<div class="lobby-room-players">' + p1 + (p1Loc ? ' from ' + p1Loc : '') + ' waiting...</div>';
          html += '</div>';
          html += '<button onclick="window.location.href=&quot;/r/' + r.roomId + '&quot;" class="btn-join">JOIN</button>';
          html += '</div>';
        });
      }
      
      if (playing.length > 0) {
        html += '<div class="lobby-category"><h3>🟢 IN PROGRESS</h3></div>';
        playing.forEach(r => {
          const p1 = r.player1Name || 'P1';
          const p2 = r.player2Name || 'P2';
          const p1Loc = r.player1City || r.player1Colo || '';
          const p2Loc = r.player2City || r.player2Colo || '';
          const score = r.score[0] + ' - ' + r.score[1];
          const spectators = r.spectatorCount > 0 ? ' 👁 ' + r.spectatorCount + ' watching' : '';
          html += '<div class="lobby-room">';
          html += '<div class="lobby-room-info">';
          html += '<div class="lobby-room-name">' + r.roomId + '</div>';
          html += '<div class="lobby-room-players">' + p1 + (p1Loc ? ' (' + p1Loc + ')' : '') + ' vs ' + p2 + (p2Loc ? ' (' + p2Loc + ')' : '') + '</div>';
          html += '<div class="lobby-room-score">Score: ' + score + spectators + '</div>';
          html += '</div>';
          html += '<button onclick="window.location.href=&quot;/r/' + r.roomId + '&quot;" class="btn-spectate">SPECTATE</button>';
          html += '</div>';
        });
      }
      
      setHTML(el, html);
    }
    
    // Load everything
    loadStats();
    loadLiveFeed();
    loadAnalytics();
    connectLobby();
    
    // Recent games from D1
    async function loadRecentGames() {
      try {
        const res = await fetch('/api/recent');
        const data = await res.json();
        const el = document.getElementById('recentGamesList');
        if (data.games && data.games.length > 0) {
          setHTML(el, data.games.map(g => {
            const p1 = g.player1_name || g.player1_city || '?';
            const p2 = g.player2_name || g.player2_city || '?';
            const score = g.final_score || 'In progress';
            const ago = timeAgo(g.created_at);
            return '<div style="background:rgba(249,115,22,0.05);border:1px solid rgba(249,115,22,0.15);padding:0.7rem 1rem;margin-bottom:0.4rem;display:flex;justify-content:space-between;align-items:center">' +
              '<div><span style="color:#f97316">' + p1 + '</span> vs <span style="color:#8b5cf6">' + p2 + '</span>' +
              (g.player1_city ? '<br><span style="font-size:0.7rem;opacity:0.4">' + (g.player1_city||'') + ' vs ' + (g.player2_city||'') + '</span>' : '') +
              '</div><div style="text-align:right"><span style="font-size:1.3rem;font-weight:bold;color:#f97316">' + score + '</span><br><span style="font-size:0.7rem;opacity:0.3">' + ago + '</span></div></div>';
          }).join(''));
        } else {
          setHTML(el, '<div style="text-align:center;opacity:0.5">No games yet. Be the first!</div>');
        }
        el.classList.remove('loading');
      } catch (err) { console.error('Recent games error:', err); }
    }
    
    // Live feed: 3s, stats: 10s, analytics: 15s, recent: 30s
    setInterval(loadLiveFeed, 3000);
    setInterval(loadStats, 10000);
    setInterval(loadAnalytics, 15000);
    setInterval(loadRecentGames, 30000);
    loadRecentGames();
  </script>
  
  <div style="width:100%;max-width:1000px;margin-top:3rem;position:relative;z-index:1">
    <h2 style="font-size:1.3rem;color:#fbbf24;text-align:center;margin-bottom:1rem">RECENT GAMES</h2>
    <div id="recentGamesList" class="loading">Loading...</div>
  </div>
  
  <div class="footer">Built by <a href="https://spark.jeka.org">Spark</a> • Workers + Durable Objects + D1 + Hyperdrive</div>
</body>
</html>`;

const GAME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔥 Global Pong</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      background: #0a0a0a;
      color: #f5f5f5;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      overflow: hidden;
      touch-action: none;
      -webkit-overflow-scrolling: none;
    }
    .game-wrap {
      position: relative;
      padding: 20px;
      max-width: 100%;
    }
    @media (min-width: 900px) {
      .game-wrap { padding: 40px 60px; }
    }
    .cloud {
      position: absolute;
      border-radius: 50%;
      background: radial-gradient(ellipse, rgba(255,255,255,0.12), rgba(249,115,22,0.06) 40%, transparent 70%);
      filter: blur(25px);
      pointer-events: none;
      z-index: 0;
    }
    .cloud-1 { width: 200px; height: 80px; top: -30px; left: -40px; animation: cloud-drift 12s ease-in-out infinite alternate; }
    .cloud-2 { width: 250px; height: 90px; top: -20px; right: -50px; animation: cloud-drift 15s ease-in-out infinite alternate-reverse; }
    .cloud-3 { width: 180px; height: 70px; bottom: -20px; left: 20px; animation: cloud-drift 10s ease-in-out infinite alternate; }
    .cloud-4 { width: 220px; height: 80px; bottom: -25px; right: 10px; animation: cloud-drift 14s ease-in-out infinite alternate-reverse; }
    .cloud-5 { width: 160px; height: 60px; top: 40%; left: -50px; animation: cloud-drift 11s ease-in-out infinite alternate; }
    .cloud-6 { width: 160px; height: 60px; top: 35%; right: -45px; animation: cloud-drift 13s ease-in-out infinite alternate-reverse; }
    @keyframes cloud-drift {
      0% { transform: translateX(0) translateY(0); opacity: 0.6; }
      50% { opacity: 1; }
      100% { transform: translateX(15px) translateY(-8px); opacity: 0.5; }
    }
    .flare {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 110%;
      height: 110%;
      background: radial-gradient(ellipse at center,
        rgba(249,115,22,0.12) 0%,
        rgba(251,191,36,0.06) 30%,
        rgba(249,115,22,0.03) 50%,
        transparent 70%
      );
      pointer-events: none;
      z-index: 0;
      animation: flare-pulse 4s ease-in-out infinite alternate;
    }
    @keyframes flare-pulse {
      from { opacity: 0.7; transform: translate(-50%, -50%) scale(1); }
      to { opacity: 1; transform: translate(-50%, -50%) scale(1.05); }
    }
    .ember {
      position: absolute;
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: #f97316;
      pointer-events: none;
      z-index: 0;
      opacity: 0;
    }
    .ember-1 { bottom: 10%; left: 15%; animation: ember-rise 3s ease-out infinite; animation-delay: 0s; }
    .ember-2 { bottom: 5%; left: 45%; animation: ember-rise 4s ease-out infinite; animation-delay: 1s; }
    .ember-3 { bottom: 8%; right: 20%; animation: ember-rise 3.5s ease-out infinite; animation-delay: 0.5s; }
    .ember-4 { bottom: 12%; right: 35%; animation: ember-rise 5s ease-out infinite; animation-delay: 2s; }
    .ember-5 { bottom: 3%; left: 70%; animation: ember-rise 3.8s ease-out infinite; animation-delay: 1.5s; }
    @keyframes ember-rise {
      0% { opacity: 0; transform: translateY(0) scale(1); }
      10% { opacity: 0.8; }
      80% { opacity: 0.3; }
      100% { opacity: 0; transform: translateY(-120px) translateX(20px) scale(0.3); }
    }
    #gameCanvas {
      border: 2px solid #f97316;
      box-shadow: 0 0 20px rgba(249,115,22,0.4), 0 0 40px rgba(249,115,22,0.2), inset 0 0 60px rgba(249,115,22,0.05);
      background: #0f0f0f;
      position: relative;
      z-index: 1;
      max-width: 100%;
      height: auto;
      touch-action: none;
    }
    #status {
      position: absolute;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 2rem;
      text-align: center;
      color: #fbbf24;
      text-shadow: 0 0 10px rgba(249,115,22,0.8);
      z-index: 10;
      pointer-events: none;
    }
    #startBtn {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: linear-gradient(135deg, #f97316, #ea580c);
      color: #000;
      border: none;
      padding: 1rem 3rem;
      font-size: 1.5rem;
      font-family: 'Courier New', monospace;
      font-weight: bold;
      cursor: pointer;
      box-shadow: 0 0 20px rgba(249,115,22,0.4);
      z-index: 15;
      display: none;
    }
    #startBtn:hover {
      box-shadow: 0 0 40px rgba(249,115,22,0.6);
      transform: translate(-50%, -50%) scale(1.05);
    }
    #latency {
      position: absolute;
      bottom: 8px;
      right: 12px;
      font-size: 0.75rem;
      color: rgba(251,191,36,0.5);
      z-index: 10;
      pointer-events: none;
    }
    .player-names {
      width: 100%;
      max-width: 800px;
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      font-size: 1.1rem;
      font-weight: bold;
      letter-spacing: 0.05em;
    }
    .p1-name { color: #f97316; text-shadow: 0 0 8px rgba(249,115,22,0.4); }
    .p2-name { color: #8b5cf6; text-shadow: 0 0 8px rgba(139,92,246,0.4); }
    .home-link {
      position: absolute;
      top: 12px;
      left: 12px;
      font-size: 0.8rem;
      font-weight: 600;
      color: #fbbf24;
      text-decoration: none;
      background: rgba(249, 115, 22, 0.1);
      border: 1px solid rgba(249, 115, 22, 0.3);
      padding: 6px 14px;
      border-radius: 6px;
      transition: all 0.2s;
      z-index: 20;
      letter-spacing: 0.5px;
    }
    .home-link:hover { background: rgba(249, 115, 22, 0.25); border-color: rgba(249, 115, 22, 0.6); color: #fff; }
    /* Fix 14: SPECTATING badge */
    #spectatorBadge {
      position: absolute;
      top: 12px;
      left: 80px;
      background: rgba(139,92,246,0.7);
      color: white;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 0.75rem;
      z-index: 10;
      pointer-events: none;
      display: none;
      font-weight: bold;
      letter-spacing: 1px;
    }
    /* Fix 3: Pause overlay */
    #pauseOverlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.6);
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 12;
      pointer-events: none;
    }
    #pauseOverlay .pause-text {
      color: #fbbf24;
      font-size: 1.5rem;
      text-shadow: 0 0 10px rgba(249,115,22,0.8);
      margin-bottom: 1rem;
    }
    #pauseOverlay .pause-timer {
      color: #ef4444;
      font-size: 3rem;
      font-weight: bold;
      text-shadow: 0 0 20px rgba(239,68,68,0.6);
    }
    /* Fix 9: Emoji reaction bar */
    #emojiBar {
      position: absolute;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      display: none;
      gap: 6px;
      z-index: 15;
      background: rgba(20,20,20,0.8);
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid rgba(249,115,22,0.3);
    }
    #emojiBar button {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 6px;
      transition: all 0.2s;
    }
    #emojiBar button:hover { background: rgba(249,115,22,0.2); transform: scale(1.2); }
    #emojiBar button:disabled { opacity: 0.3; cursor: default; transform: none; }
    /* Fix 9: Floating emoji animations */
    .floating-emoji {
      position: absolute;
      bottom: 60px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 2rem;
      pointer-events: none;
      z-index: 11;
      animation: emoji-float 1.5s ease-out forwards;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .floating-emoji .emoji-name {
      font-size: 0.6rem;
      color: rgba(255,255,255,0.5);
      margin-top: 2px;
    }
    @keyframes emoji-float {
      0% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
      70% { opacity: 0.8; }
      100% { opacity: 0; transform: translateX(-50%) translateY(-150px) scale(1.3); }
    }
    .scanlines {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(
        to bottom,
        rgba(0, 0, 0, 0) 50%,
        rgba(0, 0, 0, 0.15) 50%
      );
      background-size: 100% 4px;
      pointer-events: none;
      z-index: 5;
    }
  </style>
</head>
<body>
  <a href="/" class="home-link">🏠 LOBBY</a>
  <!-- Fix 14: Dedicated spectator badge element -->
  <div id="spectatorBadge">SPECTATING</div>
  <div class="player-names"><span id="p1name" class="p1-name"></span><span id="p2name" class="p2-name"></span></div>
  <div class="game-wrap">
    <div class="flare"></div>
    <div class="cloud cloud-1"></div>
    <div class="cloud cloud-2"></div>
    <div class="cloud cloud-3"></div>
    <div class="cloud cloud-4"></div>
    <div class="cloud cloud-5"></div>
    <div class="cloud cloud-6"></div>
    <div class="ember ember-1"></div>
    <div class="ember ember-2"></div>
    <div class="ember ember-3"></div>
    <div class="ember ember-4"></div>
    <div class="ember ember-5"></div>
    <div style="position: relative;">
      <canvas id="gameCanvas" width="800" height="600"></canvas>
      <div class="scanlines"></div>
      <div id="status">CONNECTING...</div>
      <button id="startBtn">START GAME 🔥</button>
      <!-- Fix 3: Pause overlay -->
      <div id="pauseOverlay">
        <div class="pause-text" id="pauseText">Opponent disconnected. Reconnecting...</div>
        <div class="pause-timer" id="pauseTimer">15</div>
      </div>
      <!-- Fix 9: Emoji bar for spectators -->
      <div id="emojiBar">
        <button data-emoji="🔥">🔥</button>
        <button data-emoji="👏">👏</button>
        <button data-emoji="😱">😱</button>
        <button data-emoji="💀">💀</button>
        <button data-emoji="😂">😂</button>
        <button data-emoji="👀">👀</button>
        <button data-emoji="❤️">❤️</button>
        <button data-emoji="🏓">🏓</button>
      </div>
      <div id="latency"></div>
    </div>
  </div>

  <script>
    // Fix 19: Embedded chiptune loop (Arcade Puzzler by Eric Matyas, soundimage.org, royalty-free with attribution)
    const MUSIC_B64 = 'SUQzBAAAAAAkXVRQRTEAAAANAAADRXJpYyBNYXR5YXMAVENPTgAAAAwAAANTb3VuZHRyYWNrAFRJVDIAAAAQAAADQXJjYWRlIFB1enpsZXIAVFhYWAAAABYAAANjb21tZW50AFFNQVlUMTQwMTA4OABUWFhYAAAACAAAA1RZRVIANwBUWFhYAAAACwAAA1REQVQAMTcwOQBUQ09NAAAADQAAA0VyaWMgTWF0eWFzAFRDT1AAAAAGAAADMjAxNwBQUklWAAAiewAAWE1QADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+Cjx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuMy1jMDExIDY2LjE0NTY2MSwgMjAxMi8wMi8wNi0xNDo1NjoyNyAgICAgICAgIj4KIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIKICAgIHhtbG5zOnhtcERNPSJodHRwOi8vbnMuYWRvYmUuY29tL3htcC8xLjAvRHluYW1pY01lZGlhLyIKICAgIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIKICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIKICAgIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIgogICAgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIKICAgIHhtbG5zOnN0UmVmPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VSZWYjIgogICB4bXBETTpsb2dDb21tZW50PSJRTUFZVDE0MDEwODgiCiAgIHhtcERNOmFydGlzdD0iRXJpYyBNYXR5YXMiCiAgIHhtcERNOmdlbnJlPSJTb3VuZHRyYWNrIgogICB4bXBETTpjb21wb3Nlcj0iRXJpYyBNYXR5YXMiCiAgIGRjOmZvcm1hdD0iYXVkaW8vbXBlZyIKICAgeG1wOkNyZWF0ZURhdGU9IjctOS0xNyIKICAgeG1wOk1ldGFkYXRhRGF0ZT0iMjAxNy0wNy0wOVQxMTo1ODoyNy0wNDowMCIKICAgeG1wOk1vZGlmeURhdGU9IjIwMTctMDctMDlUMTE6NTg6MjctMDQ6MDAiCiAgIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6NUM0OTg4NjdCRjY0RTcxMUE0M0FDMTI2QTg0Q0M1MkIiCiAgIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6NUM0OTg4NjdCRjY0RTcxMUE0M0FDMTI2QTg0Q0M1MkIiCiAgIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDo1QjQ5ODg2N0JGNjRFNzExQTQzQUMxMjZBODRDQzUyQiI+CiAgIDx4bXBETTpUcmFja3M+CiAgICA8cmRmOkJhZz4KICAgICA8cmRmOmxpCiAgICAgIHhtcERNOnRyYWNrTmFtZT0iQ3VlUG9pbnQgTWFya2VycyIKICAgICAgeG1wRE06dHJhY2tUeXBlPSJDdWUiCiAgICAgIHhtcERNOmZyYW1lUmF0ZT0iZjk2MDAwIi8+CiAgICAgPHJkZjpsaQogICAgICB4bXBETTp0cmFja05hbWU9IlN1YmNsaXAgTWFya2VycyIKICAgICAgeG1wRE06dHJhY2tUeXBlPSJJbk91dCIKICAgICAgeG1wRE06ZnJhbWVSYXRlPSJmOTYwMDAiLz4KICAgIDwvcmRmOkJhZz4KICAgPC94bXBETTpUcmFja3M+CiAgIDxkYzp0aXRsZT4KICAgIDxyZGY6QWx0PgogICAgIDxyZGY6bGkgeG1sOmxhbmc9IngtZGVmYXVsdCI+QXJjYWRlIFB1enpsZXI8L3JkZjpsaT4KICAgIDwvcmRmOkFsdD4KICAgPC9kYzp0aXRsZT4KICAgPGRjOnJpZ2h0cz4KICAgIDxyZGY6QWx0PgogICAgIDxyZGY6bGkgeG1sOmxhbmc9IngtZGVmYXVsdCI+MjAxNzwvcmRmOmxpPgogICAgPC9yZGY6QWx0PgogICA8L2RjOnJpZ2h0cz4KICAgPHhtcE1NOkhpc3Rvcnk+CiAgICA8cmRmOlNlcT4KICAgICA8cmRmOmxpCiAgICAgIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiCiAgICAgIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6NUI0OTg4NjdCRjY0RTcxMUE0M0FDMTI2QTg0Q0M1MkIiCiAgICAgIHN0RXZ0OndoZW49IjIwMTctMDctMDlUMTE6NTg6MjctMDQ6MDAiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIEF1ZGl0aW9uIENTNiAoV2luZG93cykiCiAgICAgIHN0RXZ0OmNoYW5nZWQ9Ii9tZXRhZGF0YSIvPgogICAgIDxyZGY6bGkKICAgICAgc3RFdnQ6YWN0aW9uPSJzYXZlZCIKICAgICAgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo1QzQ5ODg2N0JGNjRFNzExQTQzQUMxMjZBODRDQzUyQiIKICAgICAgc3RFdnQ6d2hlbj0iMjAxNy0wNy0wOVQxMTo1ODoyNy0wNDowMCIKICAgICAgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgQXVkaXRpb24gQ1M2IChXaW5kb3dzKSIKICAgICAgc3RFdnQ6Y2hhbmdlZD0iLyIvPgogICAgPC9yZGY6U2VxPgogICA8L3htcE1NOkhpc3Rvcnk+CiAgIDx4bXBNTTpEZXJpdmVkRnJvbQogICAgc3RSZWY6aW5zdGFuY2VJRD0ieG1wLmlpZDo1QjQ5ODg2N0JGNjRFNzExQTQzQUMxMjZBODRDQzUyQiIKICAgIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6NUI0OTg4NjdCRjY0RTcxMUE0M0FDMTI2QTg0Q0M1MkIiCiAgICBzdFJlZjpvcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6NUI0OTg4NjdCRjY0RTcxMUE0M0FDMTI2QTg0Q0M1MkIiLz4KICA8L3JkZjpEZXNjcmlwdGlvbj4KIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVuZD0idyI/PgBUU1NFAAAADwAAA0xhdmY2MC4xNi4xMDAAAAAAAAAAAAAAAP/zWMAAAAAAAAAAAABJbmZvAAAADwAABTgAAjRUAAMFCAsNEBIUGBocHyIkJykrLzEzNjg7PkBCRUhKTU9SVVdZXF9hZGZpbG5wc3Z4e32Ag4WIio2QkpSXmpyfoaSnqauusbO2uLu+wMLFyMrNz9LV19nc3+Hk5uns7vDz9vj7/QAAAABMYXZjNjAuMzEAAAAAAAAAAAAAAAAkAkAAAAAAAAI0VGKzeygAAAAAAAAAAAAAAP/zOMQAEmqR6AFCEAD//Oc6AZ5GOHFoBi3Sp3IBgboSd0AwM8hCMHAABjneShCMpznQOd9TnnP/J5CEUIToQigAhpz///Qjf+T/+c7kAwMcGPwQ4Jh8os1IGD0DoMrmwXOBjbJyKBIj+EEuAP/zOMQVGhMO0AGSQACh6IX+4vYuSgPF/+LnyWeYCoOTSv/0mzEyQ9nUV//0SkSnayR7S3///u+73s2xy0Uv///82iaJV+685LWrNdf////v72non+7MtQqjsqIlf+//gaoAZtmRLxyMHMFeKf/zOMQLFsMu2b/PUAKgriemSoWV6+hJ48a/79sRsZzWuTtWXEs59u/846hxE4Wv//+oxQFQ+clF5KikrESnR79SELwC4em///4gVb//+oyBX///zhBCFNQ7//+MDgi7ar2e5bAvM6RQFFG6vf/zOMQPGLsuxb9ZaALlnn7j6LOXO/zWWNy/ul1gglM2TxhCj0l/akmaLRRWiOIiicMr///OnglGLqa0UmYwKj9r/ibFL///pBNjb/1/5qaEmCdN/7f6SIxhOXpP/b/xzGk9Mkg6bmuYsYLER//zOMQLF2MqiAGcOABzqJMSGuEoFZi8KiCBhEBbUO4tPlA8qLcAwKhPguAtjriWxN//nl2PUVjHjpvPRts4IW9U9GZzDPJnfzfP+rvxS30I87/u++f/0X9f53/7WMX5FTvMk8Dpv1+m+SLPVv/zOMQMF7siuAGaaAD2QlQCRB2UkQqGpXa530zUyyJk8W551Cg2JW/QHAaqy09uNPeYku3kf1FvWdSRX5G+cO+kXP8t/zX5mf90PY/8s8qf1HvU302+8+r0F+deh9J/OgwDITTDm2BAE4C6Af/zOMQMF6I+ul/RaAKqCHDNhlpo+g+QiR9mY2Uk55XWiw0jUbPnmedR/WYjKCrEs6Lf/kwhJazEyWmUWWkZG6QwwRYFEUkn//pF4FuPf/9Ikgv5r//0h3DX/xD/rd/iahG7a2Lp9bGwXsO12v/zOMQMF+LWwl9YaALZpfSLEoqjZ1UX45vDXMfxx/P/13gsQbLP/8xNUicICJcPFJHXUl/UFcHF1TyqKSn0ZKhvC8fWv1t75iBcjb//5PHgn//0B+CRP//5xf//zE1/4ao2wp8HQqAAX5s3Pf/zOMQLF7JSxAGZOADUlCmaaX/FNscm+DhmASOGeN3MCcSRKBQA744QqeI5EkLSX5p7n2KjUbsSLf0aY2xUwkWLv/+hh/QrQ9lMT//U9/zHnFhdwsX/9RnvFYj7f+Xf/lImVH7fWFGifCv1zv/zOMQLFOsq1F/YOAD8wBfp6lagi0O3tZ91c1vmv3TePKqWOOAmNr6OazbI6t88Rpz1Q5Tfnf1LDrJznNN5ynfUCL///9A9v//+Oio5///9Bcd///ytgHeQGUnH6mhVEYA0Sgk5maqBsgTNa//zOMQWFUrOpB1aUAAtHVpr2aGxWjNzLGzjjZrGHPpNDg4d+dzdWOQ41CEGlv//+VGpAab//+giA/U3//9FBBX///qS///m8XCd/8yqPY0szMMTTU+MQkE7cOQ49DoKBQJBQ4QVBoNUERp+HP/zOMQfHEMukAGcUACmgSnISVjjoNIAs6wSiZ+DeF+4N//k8RY/J4++3grBsYkM8q3/JFcwyITxWf+viuNx+P3H7z+Pv///JyAkHjOZ/536f/9o8Ki2Pz3P+eTf//4gAfzOjmFUFNFVrkifC//zOMQNF/N+xAGZaABww1qHIdwqO3x0QIAZJCNmUDyWgYmzpn1rPmtO7pIHHo+rGgxbj8WOrJ5Qq7f62q/WSj1fJPr8ndX84e/8yPf1c9/6zB7//M2t/8wf/0///53/rgNssXJpgBA4CsgFDP/zOMQMFStCxH/TOAA1RXyILJ5Et0yqySTqFpNqLeKgnN0mgJR/8VH/qaATMFZvOFRv//ud/qBU3++c3/+/84Rwyb+j//Uz0/zgjInP6Hf//3zX1GhlBjZV200serAn7wxDSZIx7K9kat6cbf/zOMQWFUNC1l9PUAK/9TOWvq2fygDT+cAcJprfxKEN/FwAIdMBufx9f//RzW/UoKqfzdW///9SEl///1HrcoTfzxcTzfQ7//9f8iYgVAUCgUCsUCkUCgUCgfXUNeF8f4rEsdyjMlE8Pv4BZP/zOMQgHSrm9l+MOADPqb4sEcSwkWVO+pMaM5IeNJHfjQgw4Qbocn9DDB4FgSC+7odT/mMYOEBLRm90r//U8SCxMAgHhAUA8FhT6HHLOX//g8EguNCBw0IHGGHDQxmv//DCKatstlkkjbDYyP/zOMQKFKFTDl/MQAJLEQQnr1WNPQMvrrdTMX9mTvBALSswoFivtP8MpTNF8p9DR0X8wy1Gs/+21cHCKdSEhwFKhJFzsYgsdWtx8YhpdqP3/V/2Ot6aABHKp6l//rIAHQey4iVBKeIj1pgQG//zOMQWFBlC6x56RhwDBvKUVb/rckcp2q4BOAgV4eaq+rMvqYJjjMdmar8ZaUPwpYWigOvEKSjWfcEw2i25wdM0PnrRVVZZ9QDyR4WSOOEBqp97mGO8sORwWyIbYEJIYzMtBk9u7nbRC1icXv/zOMQkFDDmwd7KRjyoIitt71dd0vzZtQY4gkSwaF2oMTIhB8kjkHc2XW0zRyXJqRGB1BElGBNvkbEACPa6yKtRoS8whwkaHUyLDWsUV2GpliuqxXoasPNYvrr2bVNb7xvZIo2/nU1jB8WHPv/zOMQyFTF+xl7LzjyHGjoLDkEn0cj//7jxpvdEFQ1d2If+U5cN+74kxXzXFv/srQCxJr/XWO6S5D8CkBqQaoY+qyo13lNAtydZ0BClHvWiYhwt5iAxSWRRajqlYnKP9guw8GjvKlv/+pJW/v/zOMQ8FUKqrbTTTpRQZ/z2lH//z/5ZC/9D//zfR/8j1nP9VLobAPkutlcbcCQhq2Y/pdlUM37Zvra5Lb8zlq8wGTXs/3+vMjFS62NgbwtXZ9WxNHL22TKj9L5ia//8xUi39Rt/o6X///0jJ//zOMRGE/oWvb9YaALz3yOR89yX/w1UAEJkMikYhEciEQiEQAB3K43F2PlbFPZDXbDbZGq5CS9+CzwKYrDMQlG3APAvEQJ4mCk4d+C2TOe5WlfwK55OK5ylh85C/9yEoWFcdEQXlZk//xXKE//zOMRVHkLq5l+PUAIYY4qMqVQ6f//lCRRXOIDUIiSdeY697f/9h+a6jjtV6k7FpukNzy63W5ySQLxm8ICpSEXtt8fl1ZD2jiBUPa9PTmFzQePOvKyWbO8kgCD87Kk2/y0jNkqSlf+Hl3//8v/zOMQ7FNFS+l/MWAJAkpz7SSV27sjtzPzuO2fOfdyt9ev69eQqCG14UABUAzHMuiHkCeTkt2W9uMwrWEL1l+o4/t7//9Z3jpLhPw4ElF5MLyzZMBtkCSRrN/U+Y1t50s/7kUjDToiyXyO3Dv/zOMRGFUE6rR9aaAD89q2/O/O8svXrf5WyfQ07kJDPgkPUwkx0BzNlKMiCdVyDw0AGIGAAYZdH7H4Cge2YjAqk0KtwGASBULpqkgdrPAD8OXImQ9G05qxzyDigyDk+gmy2/l0c8g5BCcXMWv/zOMRQJZvOiAGciADo/5OHSfEKB8g7CLpUqX/83THIFADsPmBoZV3q6X/+QAiBPuaHzA0WnL6ktv9L//ybK5UWmeJsiY4DRaCzcZh//////+TiFQLRv+YDWbT6N8pf4eQnwrIwZJxWBR5Cxv/zOMQYGvsKwMuZOACvQyO7J6gisNA+XHI1Ag7uEMrB1N2AgcdUbFtwvlTzRM80+KnjhKOP1OEv5oTerkM7EsxeRxYT98v89pjZbsV3ahbzX2lG7SG2Yvy0/fOf0anx91QA+D7NLhBJsCT0if/zOMQLF/I6tZ3ZUABL2LxnLsAqywLTRqmwy1lBchx///9D0PvKC0Vf6m1ECAkF8TfIgVCyaNaHnEQGi//6j1ypIE8Qpv5CUO9SEeggkzkX/+orHfnHkv6EQt/93LeT/1e2AIjTetlSTjCAoP/zOMQKFurSvl9ZaALaxpNnUps3/iMPZ3ZiBHitfyU2f///L47UO58UjQ2bnTVInBbThi7bysFtPKv2E+KX//JpIl1v60f6i8///rRb+i39ST//+tH+sut/UbEv5bydLzQcJVhsIcWc1ykgdP/zOMQNF4HC1AGYOADqdPfvI/cmoeD8aA/bZXcmMEgDkj5K74iiYeHxp/tkS6qWJR1++9mGxUcIi40d5T/fmHnDpxjsO5T08RgyKGgkFpbr/lWGgkHwkkX6f/5R/+gAiu1q6z3WwGI8AKGbW//zOMQOF9Mu8l/LUAJcVolqJJ+Tu9rv3tf1GKeQtkZYv2YazjiwjgaFo65pD/9vGQ9AVFk1heNUf/Q3oC8Sp3b6mmnSt2wCqtzqmmmfn+Qi0d5v/31NFUWn6f/t0ImVAG4JExzAYAGbCMClsP/zOMQNFVLOsZ1aOALkejM7u1VlUte+xuzhhB2Wv/f/mjm+4mbx7NoS9H6DoBLed//4qJj6rFItf/nMo1qB4MOdo63+bT0Ac/t5v/1Lf//fx07/aySVOFLQgRNiVxYKODenDj7tTjrF4zDgLv/zOMQWGhMmoAGbgABc+w2VXfa4sIpccx6fXC2ZNEEIl/5EC+KAFwLpf+OBjQmDyfU//NDM3Ok2bmfr//pFwyHMKiDV////l83T0EEFU2/////c0fQWbmi3pIE////kFQVHUvN4EbUystfTkP/zOMQMFqHqyAGaOACXKpYZS1f+B5uT4UVsSTFDyQuJDVgWCwcLhHOPEY1kmCMfVQuqOxYvIpUhVDipap0q11c8vbWZ9G2sT++Q/y/yrrkdOnZpyuU7357Jo161ANFlswwogNmIbHWkmFRJW//zOMQQFOI+vH3ZOABLTK3SKrey/GtlnzH8u//oEppuawrOebXygySOfKuomOQ1uOgRGG/1LecwRN26EW9poSl7P5v+cL2X6X/qPf8h/3/5NQ4nxl44lgARgpsjJw1lLLpJO2oMZzhlaua7N//zOMQbFUI6pR9bKABmCYrzL//LoSAwk/VhX/iQGP4eZQ6Om+Aor/Rxoq3coiK6t0f6UAIfT//Vqfo/XjQ7/qf/kf8q8q6TAf322QBi0uMddaBnTJd4MvWACwCcgOMtXnPvxqLHq46SxEKMTP/zOMQlHeJCwMuZUABScfhZHoSBSFOgMCefY9zy4L8iYmC8LmuYxI0oMhNFwmsVEss41mN+thbbxcNvoxnbLiuWtehIMP/34uJY8fL0cnDyaZD+VPMFw7lEbco7/r/5ZRD6mk27I5AZgzVejv/zOMQMFVGu6b/POAJlvCxK9zGZWKNBrVeSt///QJCR/jYqc/6FCX7bCkz3HSJv/vRTxqYTR6tqOpz1R1Zx1jtT8FQ0tICBojWMPM8Rf70CoKhr+rk61QQbItdbLbrQTAvrEbSKbLYy53Upjv/zOMQVFSl+4l9PaAKrxfeG1xzr/+wngng7jakdGFFAstWXahxF0zMEvfHEXicQlo8xR//629bdZrrkV/y1sqHfOtouE23ZdyT/8OSKABy48//7PDDAOJMSUDNUPAgmGskIC2CqxvtI2xLHRv/zOMQfHPsOrZWbUAE/fPTXn3LmkdWAsJDxFoJQ6LlPHSUYCwFPkPo8F8dEEDQP5jo+Uo8GgRAhAaxbP7N9Op7iLLyL/+viwrhcDRdv///z55xJmT4//////OJKEjnoXV1nCh0IHnFGFZE2Qf/zOMQKFdqSuAGaKACQAuA1t32Wvc4LTKKE4WI0HoOAUVDCxNRAGcoW+I2ULczIOfhLQRYa9RWr1uvyt8378+NX00Ty539cjfoz0b9U2b9K/EXfnujV0f9H/So5enMIIDW24zgFPYITEBJFNf/zOMQRGQKSoAGbOADiXXWBhbN88ZdNwvAKoUBKcZkHCMgao1FryjTgJltBq/FTyojSr2JMryg/V+5X8z9OSzDW7ZNPfZfKNObfQ12mt+67t+18zGrt7C89yv6Wf6Gf6D7oeBA3NKQwGhwx5f/zOMQMF2KWhAGcUAD0zmOQUSR4FsLVWT2SKXFhKKNXs8AiXQZPBQOKSQrF1nHE00y4rltB63fGQ9dXzH//K/3/3TJjPNzf/815C1fPR//+890MaTb49bFuW6zZB3jqCVRg1aEC2BK/ERiUMP/zOMQNFyo+5AGPKAAmvzoWoVw+dzILFbw444oskSMRjndSpNKxvU9V0MpL3+x6swk6TtSvz9dDIqd6V8hGD4u58i1agSAIRKInruIAG8EEzkGkBICLOv/V/9f/XQAgOjRKDAbUhKrqNTMSlv/zOMQPFUFG1ZnYGABMy6//Ldmlyy79Xmu/ruf7G4UwzVfUqqGRbMFWS0kswQ4pjnP6pBjMg1j5YqGmaeTZFMNIW3fFvrsRpa99Cq3CIhVTHGnJA70+utrYQEkCIBPFY1tRMY8LIubh18iFa//zOMQZFRF+0bx5hjzDznYOR73Ras3PDcqhqSiblqS/DFZM1ZjnOHxZ0vbIqVARIDAQzusg0mtxBM7nb6LAbNo/9eRlqw1bQtUOTZ4dm+/+/4KCqYbMaaGPACBQowwh02QWxd0hhAI/vkOLJ//zOMQjFSFXDn5JhDqRuHFi7Fq09CJ1Of2aZnPfOcWfFGQO92kQMFQE1adOLn+oEELQR3KBDTH96v7AcchhZRS8CTR3zZqqSCMEI1TrQTZetRe8vJWBGHIAxuePGHBCZf2IYCQr37/IwJTit//zOMQtFHGuqCrSBHgRgRzP7jP/792VOjdTfRyA8K6vxArBUnVt9J7EPuzQddT8eAetBJtjt/2+13HjiA1YsfxHr064kW+/6VJ3/wde7+oT/9a2omwvON/peseWqOpsMH/9ehUHqmjI8aKcu//zOMQ6FHse8l5iyrYgSeX//vX5kfr5v//o/+bb0t0f/1iTSVQdO6SWWy0PWbaEeoPblkMCzCLo9x1c0Zfv0QA0jJItgIIREA5RmX2s3qxcOSLHkE2CICVIE6CawoTd3bZADA5HcBhxo6ZDmv/zOMRHFMjCyR7CEjYa7+WPcroEwBq/FgJVEU8Ec2gCxpIVFRmDc3HT5ZMmmNBeMWk+LUcC2BvmoV9WL1z6CBBH2ax+5raNupKM4oB2NdBUf/0byOOH2t0X97pFA/+T7DNcq/5l1mjukDH+bf/zOMRSFNGupADTCngH1YucuKCxMEHK2EAy+odTbW9FmKmrT6UiGAsXnV2XOwfTNL9h4HN59hUw/5aCwULCnQwsP/6eYSOR+3Qf9KkUox9XLGk6SPu+j+yelXf2Nk4oActIHf6A6huBOtgawv/zOMRdE/mumADaynC7M3AjH5ayJmtPhT384GwmI7Q59/JJC2hCBay6mHoTIMha+dj1kIfkT/9H8oTHP/nfR52d//o838ifbKlt1T91crK4a3/W9VUiaOqQHSyZ/boUJT0QV+BhYjQBhqQbl//zOMRsFQoSiE1ZUAAwQBJi1aZs4wxBQZAAuBbAppVOJQHYmThBg+EOUFr+Zm5PmBoLkGcG+MMZWrycOm5mX3EdiMxlhwnBtfyfOGiBpYfiDEaRxRPFH/p01Mg1lJSTNXMWNf/1un9uYmTJVf/zOMR2IXsKmAGagABepD///Zv9JG6OTjc7///Sefcltv+22HaySTkDqvzYp5LQ5oNLU3C+a1hbQxlZ0EhYWFVKRxUpVFB+odKWwwxWLzCXm9DGMZjGDqGepfDFKUvKHeX//HfyGb/f/6H9H//zOMRPFVrK/b/PKAL838Yz/XK1AGTcdlr7yKCNAIrG12Pewm92BdUM7EbMfiv1p78K8o5ZwIRNZFHpIRAGoRObXRhKC0TtOmugNY1KD/RYyb1/nHMIwpJv8gFn04ydbvyPSS/9OnzvFP/ka//zOMRYFgGmvb1YUAIAUrWyzWQWTofC4aigAxjoBTUZKDG2BpoNqDRQW8AIDjAjLhZPLVIjLmQBLLSLZqbD0NgMjiskIcEFSRIieF0tJMydEvmaqJHH/yPHGKXKCCJk6m0vJwuEQGYI8cfV///zOMRfJxsmnl+bgACON0yDkMIgOA/lk1b/9boFMnxxlA0NGeXWrbU3/6CBOFMnxxlAqE5Y0q0qj6XqV//zM3J84aGi3ppm5gaGii1q8zCIEnIsg+FOsOnMmXBLc2n6jb6tn4RgmbFTYp38jP/zOMQhHZImzAGYSACfUcImCW+B01gwaFDkOJ4t/n6DJxbh28q49Pf+bKMKOm640lKVf+efrzRrEjTFsbG4ovUq//Vz/rtr6xJi2Jzvb7vCg9t/IgkCYDA4gDge5X+/h//j6uDkGbeQETRwtv/zOMQJF1suuF/ZUABvymkeXxabFdSqcmYSr6XZY4493n3WeHPc7zjgbib05ERH/Xj0QIBwtHLmkv/+pCWGJK12//s6iAEMab/+d9TRQd///0EK3//nTTSEJI2S23/5nF7VBaaub8tsAjcDuv/zOMQKF9MuyR9TUALB72LZ9kKMpFZq1MgYpn6R7Iy31BZL9DWzRkLTtx8yj0mKhet6t//xiJoFo3R0V5Ex5iIanOeBMNmT/6j2vUXAEjvN8799DhGFL///6CBNLV//5FyV1TWoISCzDztCMP/zOMQJF0sqsAGbaABAIPB0Uzh9Y6HCgsfL6eLX1JsYMsnmpV6y+maAupSj9CaLdExE/Z/2VLiGxqTh0/+pD1lRW3/9Bunyme//+36fKkaeo31f//v/9kUtVZcT9Z7///QqKiJBsz3COr1j0v/zOMQKFQrOrLHaaAD60anwEFlLuy7Wsfw5b3//+tibA50fOmSK+u1EaTht7aKC1+opjJR/1P0D5wiJf/60URKTZJaP/6ki+j//6yWf//1nv//UTjv+CNUUEIMCCTTNtdJEHN9HaKkXiBiaCv/zOMQUFWMenDlbUABmU9dtf/ZVT/j3HVW4MwATc44nt0szhiHwsdC84Vjv1EcLP+yE1DkPJRaLf7/4XR3//yn//yo5//9SX//5F//+MmUyJLnFNIy+MmfKMjSKApmSbyfEynipB1Gm09Kusf/zOMQdHFMOhAGcgACkT4fkNIaAzIzAzZFxYTVM1UkZSsalscdIV010VaCz5cNEUY+SR8xR1MmpusiP1c02s3Ia36kn9OpnN0M6e+a+i3/qQQ9kFvUd+bpfer6P/9aZu+YVUijQGzLGFwW/Z//zOMQKFvkazAGZSABr8a1AbTnR5blk9B1ZIScxImjFkkxAaYkRNzTKtIGNhCCU4Q8ZS1tJie+ZV3je21xED5cH3C4bbUhZrKPUFujODHZeVflJbr4Wfu539PT/yn/QCJMVSBTw7oxJgswrcv/zOMQNFUrOvL3ZOAJzPTA7kwmIqUv7HpZalszLtb/VNl2zmm0OcKnOppvN+hx3ZRSIxz+3/+g8aWIm2Z9Df9JwEv///gtb//+0qJR3//+o6JR7/w5VTJBWNoYKgasOYwSMiXLZ64rX4ZtS6f/zOMQWFNrOsF1aOAJtHds4445fa///uhqo45p2Ub0//znUj///4qLjcjnTnioSiXO6saI4ImHNb//48///+xUW//70RdGG32fDSjl0QiFzhAkOATJoMFGTHrWMTdBjde67dqRDIAusQTHesP/zOMQhHIPOsAGbkAAvA8Eb5FyfN2c+ThIfM05mbmJeLKC/xmCcQTeRcYJ46j/+mmhaiiil/y4aOg3ixrmZ5f//1p3Uz2dSM4S+/b//9NNBv+1Egidv///+pv//1lkAynhxdwLrJ9kRmYW4Lv/zOMQOFTNCyH/YOAA7TVKbGUz2WO9YxZvbP9//+R85Aoab+tRd/gtUsDkjsOgan//uc35oQio7+QOce///+YJi///+hvzV+ccJZv9n//+vR9RSXgd+uSX5wKKg85NpTGK3OSKtRZVqPHD8tP/zOMQYFWNCuH9ZUADVXt1+H5/0VBPLlFucBeNv6Iohv5wCxw8EN7hQt//7r/lRNb+d////uIJ/9v/oX9F/ZRNP/mP//+2TdBEDygLe23IYFJABIGBAACLMNCHG1CjhYcpxo48kdhMIdaCqDP/zOMQhHUMesb+ZUAChu0GgsHiENFsTg+C/IiM00hMOnlBYEza/y4sEmFUTa5pvjceM6v//k5l2PPFXNN87/3Y8n26N///mMhk08bsTjfyY6n///sTk7Hl57seTzav//5c33INQOZlIKyaM2//zOMQLFfJ26AGPKACnWN5EQl64aFiuYxyMNIICYdESkizjHMzIKWGr0yauRGqVL2fdlD6O1rlaqq2udB92/7EX9LJFQcCDFEBJN8rf3/xoiFhU2LBWvT/8WgUtJLdbZPsKCciNR3WUzUxSRv/zOMQSFVE/Bl3JQAKZKpso01KW/pCIIkVKkCGDpzX0iINU0faQzXKKSq1LMxR7TWqXEKaoJHgakWuXKkpwryYLqPbkoa2+nR6Va//TVlVmagD3dpG2cBcY5ZRZUkyTmBtlwigCwS6ca862Ev/zOMQbFICWxbrL0gByeNJAFcgxhSYEoUpJpPGhElS7wKLMQVINqeoeVLHlA1O/kp7U8Ga4UWMHuyx4ZQW+Snfo9/WNBdQUfHTYqUkJpYzHXalr1qRkq0iohoTLTIECI3Vnn8hbD9ct+hyBR//zOMQoFMF+qMLTCnBKsttiUvagCCrildji/b/5x6E9aoHDLcPlAgr1FBuXEBnh/4n/L/Po+1ufDivZol9ttvsMKSlYE0SYowxzpr6nnrhMLb7enZjwGMrlY57epkHWm2HEXNPvwVxW3bA9g//zOMQ0FGITBn5jyuqs+pB///Gsrf0Bf8Q3b//X+Ua7lvi7KvK9Zn/yuToA8kVp+2ukwQzPaRPbO0t52s9/ZzdW9UpccMJuiw/uPK+hSLGIDjnOD001blznWBwy/vUJFKBr5Qv//ypYdb+UJv/zOMRBFRISwd9YOAD/3x1v/87+Nh13Jfu/Ldbv/U+G6jrxGDmOa3Thm0iGVr4aqEJgsGLRMVActOYfAoQG3ohiWyuFNdHMfWPxg4n4LYOQmnUnKzBNgtgSAoDCaX8lFkodN0mdT/01IIj3fv/zOMRLHMJqkAGcaAC//L5fcl3Yvpbf/6c+hLhcZDo///6DFxp5N2MwPt//eH3HAI45///pHv08uhM3kCAACRAUYA6JzT2dxp33qutOcuRQbCnxDOsxGCRQFqaJDuIJdLCSIBMRLpYTj5JoHf/zOMQ3ILouwMuZaABZgVu0qRPvSPG7FZ9InGc0LZeNI/JZgpB3SpMk51p20wcwnEUKeuZ3oaVlrpamWZzutBSCjajMlT8Jk22OexiT8aiIapefW+6////RAIRsyACSsH3SJ6CBgSN0tsTUI//zOMQTFJE6tZvaWAAXil1N3mL01pb/97/7XaIrbtyarr+RSPXEO/+Clzk20XOdyYDydb//tIElBVnZW7Z8789gHPfO/PdS3+r5X4cVKCRhbj4b/KeVcAQQFC2Gb25XFpTXnnswo8vsRHGrYv/zOMQfFUk+oRVaUAC1WzlgeMCAQ49Rjx75oEo0dGKF/QfZzq3lBa/8YjXulnyuWdLPqf5V2mV+ItOS8kGslo+RyUkqEoCbaQI8s6Z1q0AUmNdfuql+niSkysjLNQBFE8I86SYwBJoDAmoxDP/zOMQoHxsmsMuaaABOPAkzYvkAC8rIPy0egxBgC/Phtmv8mlNAcBYmYEnFR/+gs6Pc+/H8eyf/mizp9BS6RdxhUP//JA0regmztSPUHqLf//6Zu3oP6B+XNeT29R////HVCQUhFut0LCRPS//zOMQKFSo+vjvZUAAJSbhmGYnmzwuc70PtrLeUn9eLG9//ll0QQLo1pOYiN/yogSIm/iKVEOOyIB4lb/8w1xZCS/9B3+gLyOY//+Pf9P9Sb/iH2dZ7/NoKcvsgYWgAbR6QpiuMbzcIuzLatP/zOMQUFMI+rNtZUAA2u8w3aorWu7//FwKjqKYhf/xJHCRPqDbQhdTXUCYUO3qb6mnEIhAoA3Z/ni1/hJLSJ//6D7/T/Ut/2e33/5Mbnp5HGJJBghyXa5SSOpTrrv53uvPUZETBsAoCYUPaqP/zOMQgG8MmtAGaUADxEAsCEH+v8iFgAWBXFv/8kWIgRAse//Ari24/EWLYXn//4iCQ9CQL8RY3ER///+PGVzBFiLJxYJGHn////5hg/H5OLA8JKMPyc8ef//4YCpkvA4IKGc1pdIKNVhl05f/zOMQQGSKS0AGYOADxNm0GwfVhWwDoPVMc6w4SEIiDewtxQaC4SmOHtKfHRoRKHLOZOVbnDYbCkiYvZ/j3UdOHi5s43uU/z/NNQeO0U0dfr/O5n9jk6mjoiPW89+joO/6KBQBsT97zAIAIFP/zOMQKFUMuxR/UUAAABagHLE8Zm7ObSZHclztlb6mNbnHiC+PdXX9epCLD///+NREmzij/9HacaQguk1dP+1DjWQZATiyb38v/9C///36CsIVev/1ZeUcMT/9+AVIkCQjUJEOxNUdrWGUqhf/zOMQUFTMqrD9aOABzHeWP6w39zu8Sju9o+Ip3o/VvndVGrev//qRHnx4l/46ao1Y4IgSPayt/nV6HjhNub/9vnepv/36uRJU//mzeSmDbLbI7VbRaLBaLRYKCqPF2Nqvudp2bOVGF7bzmX//zOMQeHOK7Dl+YaALICfZ2jkSHgyn1MFgRCMT09tsqOhdzYvl0zHKSZN/HuZm5IF0+szMRmv/LlbKZV1UFf+gg66b1upZg1kf/6R5GnWbqaozPXZSylf//6jR9+GV6NT/+ugWmlFbtaoAH8//zOMQJFWI69b/NQAIyo3QZE0lxJRiyNSjVbLVS1KZr9Wa6//4Hiwsc2KswkazPligHBCv//ynyxTA3CFai/Ukz/nuAnXb/7r/+VCHX/6ev5/EEQP+//I/5agCZJsrv0DHTWJAA40qmp/meff/zOMQSFNKGzZ1YOALKVZ3N81TZXc///4pH3ms7N+hIfnogTTBHMQd+DoMv/lRa3KExS2j9TflDnCQXypbx1v6CVT7r6dRJ///Jf6n/5Oo5pTULMpRAwSMVKR4Pc+gh+q1gHDeEin5anovwe//zOMQdHFPOoAGbaACWkc2MTgWZ0rPmKZmYGrHwvA8EQ5ek93vDnkMchcNPb+XxxjzNR7m//+gph6Gjf//7OTCU6////zM3QQQdTOggb/////uh5mbkoaULmH//////lw0qGiDxweqLBIX1h//zOMQKFjmyzAGYQAALtRBZTGo4/Hvbccy+LElwhC04E2lggcJzBFc1acQyfYdfEj/kc03yJGn+ab/y7/4HX/zV//I2v6+yvWS0l5GQYictOr9eU1Cj/inMdf/TAAhQZikl0uBBQEDRoXDKI//zOMQQFRIOyl/YKACX60Sb3BuME0st3+6381//9UHMMRqB4SK3dZhISP/iQsJH0KVW/95RUy0f+pv5VLEW//qSj9RAmFV1P/yXnSrrP+WiWtVO65LbJIAuQnGpapvA/UYeS9AJ1erwoyRmcf/zOMQaFIF+xP7C0CpmDQ0Nr8fZ96iPf9jBOytVxTiqlAGuvkVEWP7dJjb/Jth/xf5JvWwfcWf19JHz3y2V8Oswaf/rnf+MwGOqKVuS/YOuuERx7JHDTttCsxiVD+j2m5YsgSG9qVoCs1LW6v/zOMQnFKo+tArSBJ4nxgeHmMrTqfQwRHq7U8zrVP/UWrt+gj/CMgMf/+pm+oRn/qL/L5Pz/L/8kkKZkiSGhCD9owoVF5YBgMF2YcKkogDpWCJqweE1R3Y+yIX//qAgQ3Bmsrc1QS/1AqGF/f/zOMQzFDnusFzSSlxCI7/+yh0GM/8YK/mcB8UDV//ivWR6zn0/3cj/zFsKFAZwLp54YwaWFGPCYyCoTnejMmnaWWyPGW2+VYay+rdyrfcGgEUiMggBmZTB0U8KO/6AbN8Rb/60iIG/6P/tif/zOMRBFII6nD1bKAA//9Bb/N/qK/W79PU//LORkDOEEWwAdKFZ83C8MK+NuZMQGw3d2YYMECDpjcxWCjCxgLKEU3QSc0NBeC2hicNW/+Fh49EKICClP/xyCdNyDjOClP/7k0Ro4xyxzhHgn//zOMROJdvOsAGaiAD//38vlMvC4BOZQIIPf//63N1MgRQzE6D7NgbxhbQAuBqoTQLnw9X//rdOzfbht45Atw4BzxmRBc2IU0HPGyLnSLH//////loi6gC9/+/++//+sBeFzJ6oAFo8VA4p6P/zOMQVGqIG8ZWPMADUY7zUhv7advSVBbdyJiWF4QaISA2Yk6vP8Z2x3c0qXbW//f+d00AkYftr/s2+tyt85Dbu3WN+7zj/f+/ZvMkYLAIdUTJvmTDL3PBXIZXocxuEagDiOgEpJLLJI/YIIP/zOMQJFQl++l3MGAJAhmtavnrr3wOGJ8cuQxsNfbmvgAQ9DGjAQbVerC3GErF9TrHfpdoY9V1nP1iqf9RW0x1z2nioS3PIAFZxrz0xSu8JHg6P7P/rystVCe223//+2FFAQaFdUdZoSMJhBP/zOMQTFSF/Dl5JhnK1mQzwkk6L+Rz+5VrCWSWkF3OM9NNGpIGJmvSjMU8tmnGOlLJwVkg072Aql5KoiHAalh4lBUFTtEkCpoOpRo///qWRFRBBs8zxDgIxJdNkjAZotBNtIDhsUMaXITWx6v/zOMQdE+lWqArSRHjBKILkTMPkl1NjXip83S58SZcIkIwQplqgMf/37gx2dHoLpbcaEL6vAaqQf9b/oyfk/0IApRdxJ0yh1OMO4QKCydShyUcNr7pHHLUxoZDKLup2vkdolRbwcKzt/6tVoP/zOMQsFSnuqFTaynhLLPrQJjHMbR1H/+9UEjlb/v9UcRQxvr/xVfJdZzVDpLJ+xH0fkpGVfQAVG3Jt7ZtQcAcAVdAgRoYFucWuo6xkgfd7LWZJjhU1EU8uWP9NInFpboJRripR0JWpUYDS+//zOMQ2FRqC2l9SOALuVSpsdLJ79f1aUf+v/f/X/m/Vvm+Vdyt1T63etDlKAFYmMrlklF4GE4HA4CMDRwEfmJRyCYwktGQkwkSV4TBrVUk11wfdZPImTw4RyAXRwjjWAkxhCYXyOX5idE1YL//zOMRAJTMqsl+baABhUDMc6Net2yAHPH0LWbf17yAG2DvHeXzf//Nh6GJGdNX/934wjFhDBOBTJ9v///zA0JcwQQHAaljD3JH////8fhkE8Ycc4/lpKFpRKZwxJcpf//5SB9sOHLGx019CKP/zOMQKF5n2sAGZOAAVuaWos1B1lWPdJGr3oVNjoPQ4HpAbHsJwiMG5wknCEYVhYaiiY6ZPbY+g4JnR6HMUerMnsJnTU8rfRTm14/6a/bdPTK1YdvVrnfq8PJwJob393/NVPQ1IjAHBrjMcmP/zOMQKFpGOoAGaOACgMyJMR1HsdF/blDFLcC1QDhOKxaIAeiw0VCsZB0guGBUTGzjhdRw3NQpVnPqPiKbeVNe9h6j9TmTWr/99SrMQsKf7+qG79zPbYzQnR3O/BRUwhJJgM6csQqOIKQMMov/zOMQOGCD+gAGbeAAaVacpdNF8HAZECNBSZf0vzALgtG4YqTMc5Usj2MkK+mxYlhRvkINlycKWg7pPuFv1tb+A+mhb+JdJQT2GmfZPKOytX64bF3qXDv/vKNY6vR/+lQJIv/mFN5gL2BCBmv/zOMQMGCEavMuZYADoGJsS9M6uno3XHjJXTfymiudl15EL1b54scjYMliRUfl11ii9e+tbeWn8Prds5s5TmysuZ1TRdMDwfAkoJREeYUdLh91yGKTCuGPoQ8tS1Vv//p6VNqkku20u1EFlHv/zOMQKFVLK7b/POAIHCgWeHNWLqJrcWsXCsWpLyuqxaMJRzqRGpEixx3Oeg8GiRzvVB4NKwkzqHBYuh3/pOOFrN/Uh/m5v/+pb+qf6mf/m+v/X+VPf6XrVBCcck3v1u2DIQQZJ5n9prm8TEf/zOMQTFKsa2l9POALiNbrb2d9bFuqd64rFth4ksRlZ9GMLpB0zL2HQKlUJfHn//Spwkr/qR/x56P//R/5x3/N/+j+rf6f1t//8dfyaHNN+CTDTCplCiE1Yb5PFsP/XsNbdutZFE+CcN/Ig7f/zOMQfHCPOxAGYaAAhh7/tiYEmMKNxQ/75NHOYE4mlv/ty8OQky6Phqa//f82HIXCTJAli6Uz////54lzpgZl02NDRMuHP////1oGxqbnzQvrUZl02RNf//////N0KDVpNR1ziYGDJWK0MGv/zOMQNFRny4P/YKAAahnGZxrQdQdt8ubuaz1jruWNhxngAY5ZWDqUFWldilK1xZymZSs6GM+muY/VtWMa+1HzNr/6l+NFOIjzOWK/+p//nup8Gg5UFXnbpYqGsTpUpiAnb1lnhV34Oa5lxvP/zOMQXFSqi4P9PUALr+vnHPjctIiaZm0Q5/rKkxxMRoccUco6HZzIdNIwNOiFSwyfk3bSYLxmOerf/8C1vm/fzuKz///4uf/7vUj5TzYUjGpDotDyiCzxkRKlxMJX6GcS/SciC6YUPIrRwE//zOMQhGmKijAGaaABiIIhHFkQxyCUjtNh2hcCWNRyl0eIsB4jwJUuscTZaKlOggnkobVZeS3/0R4r+v/9Ieq0frMn//zjUtblban+ir//8yP6tZ/kaAcG/+gEFUJKAhp6DyWkVXW1dFucZtP/zOMQWGmLSwMuYUAAvsWoak+VUfjU0YoVHgFQsewFNyjhhSYYIsnMNOC5LmuweHXnmNXEYvnRGfmOY3mDVvIif1Iz2/FRPbH5vmGPzz25xamVTyrerfb/8yX+VbIFMpqoAwUUKwxPUAwSse//zOMQLFRMetX3aUABxoHzrPNaSZpo9avU28cdf/87rvSgIJKa2VY46vfEoeiyb1qUVvkQTj/+j6Go4wJn//5osEz//5pCHz/1/4Uv//0N//+Rf//lDass3AAYCGvVgGXlYJlrkXlTPxYGrSv/zOMQVFUo+nB1bUADkNnH95d3Ux/HdifDwIjyU9cwhRyP7CUOiexEZJmYLkynwXnfrzUJrbwWk/o/0dAKyU//yg2T+v+UJ/+z/Lf8O1TdrYwapJJTy6yiHRYzD9sQEAC9uGLEjh1SjxuXDQ//zOMQeGyMesAGaaABB3DIZJFJIuMoYMYYFgPdP9s+xKD0JT9k74zkkgaUv6bt5KDsOqzT/6H6Z0+UTRZ12//un91ZFI6qk3SJi1q/////UimXzRa9kCx1f//6VZoApRcJcrHk+pbRQFKnaaf/zOMQQFRL+xAHZOADwx2US6R8x5a3J62NBmcpiOOAvIjpYSjjznoO5Qu1zVRy7nDrMacdVHVnfqxJWVqsrVf/jqt/2/6o///+P///9W///5dUAQr36QcCAYxuBqclEgJEW3WgCcoW2psI1l//zOMQaFWKiwH9ZUAA3V//tc/8km2QeE5RHQ82bON/0QbSpQ1lU09r69UIQLc3N9fNqtBYD/7e//Kib///yR///8Xu/93etgGUAJtyRut2Wy2W222SAAxidwgmi2DMMfYg2YtIWEDYVgWdwy//zOMQjHfKK0l+YaAKHDbQHvJMlSwly4YG5OKwkYBvBdi8kbmx8unE4yndjUuOvHmggs3GglzyLa/RSQPOhH4+gkrUl6G1BnRE+S/UYt97/qKP1kt/6kW7bm+/5014H5L+lAswE237////IBv/zOMQKF4r+3ZWYOACNtUFIGRiylUOOzSWZXuGMZRbtBsw8ChEeBy7k2JkyOce55ZFuZUcaarspMcskD2S0IRnb+u1vb0YxfhLp8P1/5j/2lS39WlS23+Y//8q3/8o///WqFIxIqJhjIxNm7P/zOMQKFVtCzF/YOAJu66upTVkU3Ta7Vx5tu3dby79XE0w47O/OO0YqW/mhY4Sijvx8Mm/9D/c7+aEIoO9NP//2b80Kt/s1CZvb/KH/jqCs1/7/+v9v4oIVOIR0QR5IrCdtGRIIv07Sl2Vt9f/zOMQTFHtCqB9ZOACcprVburUPTlveP5fpiJlx0iiaW+pH+YEJY4224VDP/0//yok/7///v/jv/8a+nbyhL7jpoWJ2+j/+d+n+KiIKEryBvido752dBolv/m2W1LcboYPA+CHxoNGEhyoFRf/zOMQgHRMe1AGPOAA/NPMU8SRoLRSKP2V6uVKjyERV/PPefPMUoPjQNjb//fMMPH7kkVv/9lc0bkxLJxLHTB00cBaEgBw8NhGG3//dj89GPz+JRMeOOHhsxyOcSKf//4iqC1kZQFEMTHppyv/zOMQKFQkK2FHYKADJX1hmGWhQ3FLUutazx/uPMf7rMVDQ8ZBgCirCtRLoZBFS02cvbRRguRS0lQEjr2PatcggMnRZy2qUQW87uf7H0+u/Qv7t2hlBRVUJKS262yxxMWAcmAoHcGp9shchfP/zOMQUFWGDAl5KBpZYW5D3hF6JFil5UFiDGOZalNibpSH/riV12vAaNG4pdKdVvpExqzVguClivHLO6FXqTTnlnDImAQNNBnWEv691uNUABW2b3be1gNlNV0g04HdvwDN9CUwymaRPToz0lv/zOMQdFSjm0l7Bhlizxk1bJkF5G4PHbPPzp9ozjxFADPKQmkeTecKqgMkw0VOvw4RBQ24qGsqGxmIjzCREqdUe1cU/QgApBapAyIFNRsQRoQacE/kEAIajDosXdqXha7YbBu6zFnddMtm9uP/zOMQnFNl+tZLTCnBcVZn69iA5W0QowDiqmM9DCaP/0FUsziH+4IbPFzILF3fl/M+6AvxXsP///XUAKEe50kEYHFPUhWkEepJvRpDeu6LVYxhRvQW8iEe+WRDyoTtqpNZh026Y42yQ3X95UP/zOMQyFDmitj7KxJz7R41QPNa0KW1Uf4r9v6CfhcN/zHV6Jb9XUa/92vw2AOSSkzU/xTQ+FbQAMIh1+MkzppmESys9VXXH+5dz/Ov/qKx5hrj5UKq5qPa55FqhywrAhORCGO0UFliX/q31///zOMRAFIGiwb1YUAJH+zyrv8ryz+Rlf1P1A1/7/5AAACsVKoWkUioUisVAAHuDxgsoCEAUhAmh22SQGryMw5Yft+5+GTRWACLQPlBhjZE4L33CimNc/kUii4naRDX/8GgpwZhMgy6n//mEgf/zOMRNH6MGyl+YQABDLEZh8G////Xwhd4ozLY39f///06fyDIpzJQaLe03mf////9Z8IwpVu83vtHAyknY+lnY3L/TboSYsgZS8oiVnTEyy1fM2N9qshhjbn1rFuCUTW/A7WmKUJg0vPNJmv/zOMQtFUE+5bfPWAIvtJjo4lWtuYt7r/9G/mD2HPFn1avnpV1D2cluqb5XQdmvU/2oKoLKAIoAM6dIAMClgzIKEaW0sSAeeP0/ZdF6edpflXx61/713LIq2bZGaYjoGBEAS9NLrex/9dxn9f/zOMQ3FTk+tl9aMADMvZ//7yCB/WuNLSXkj3lft3VP8l9/p56d9WnanikAWOSWqySWy0TW4WCgADGfgGNfMUNKjJAv8GBVWDkNAlzRabNuK9wSCgfgYJhcT18pOgmC8lkwfxqJ5oO4uEi1pP/zOMRBJZMm0l+YWAK5Ln8hExmOiVzIvdaM3/m/Q/lBMPRb1v//zkvJ7jkDbaNDqc1E87+f8dixCE/XiluiqVpJNGspT///+/s0omKk8/f8e2P/+v////+T5PQOIMmn2fillQOdJE4LTrGdQf/zOMQJFfouxAGYOADsjeFYFLt004qKParfdKHOGY4N54bnuJF3G79BMRTCNrIJLyD2JsJsoX2lC+pyk+tTOuRz6jn0mD/zcz5narvyjeVRurdsRdoK5Z+56LcgACk1pYFUA3SQXKIg4+uy1P/zOMQQGOI+sXvZUABRZRchh1mzzf3s5iRa//3+IgRkTVMJ0exxq9XKCcPjuVJjxAm/OODIUndtR4Ph8M1MYiGQFIQrfnCc82oqoKwCYhWVv/N49N/r/xr/xJ7+VPf5DroElT77fI04I0Ibpv/zOMQLGBHyyj9YaAJitkLb+xTX3ZqW+19cxtx6jtbuZ4YZHSVRWu6ZgaKPKNlVZkSzM2yJNE+LUUVeCfBxO1lvMWOHA5R9FFQ9R2kH/S+p1j1Rr//1F5+vyP+t3K+n/LeG6liuOKk8hOkvvv/zOMQJFQmm2AGYEAC/dhhzpf9e3IZTw4GLAnAfCgbgY6i1+YAHCCCszG/CMLKedOX+LBCDEkVmVjf+pw4EAgAHjZb9YXAgEAAnS7FP+95QTmZw5E3f/8nVodQxpCB4DKNH1jkDjiK1rlh3l//zOMQTGMr+uF/ZUACSA2HbPfua72zlvu97ElKqQggC07T2nznMHw1qZ4TR8ccdIDmITCZ/XnIN26kJK39TKHkQTmQo8w7/r1IQsm//+c+JZK3b/b5pCTf//6kn9aoF7q3JJIwCaGaBHoqkDv/zOMQOFSr+zZ9SOAKxmowGsRMiRRNqSNNk06qJ5bPUHRBub70Nzc6Fe09MeL/No6D4OLY6Nf/NQ5lFwsn//28LCK/X/1NNNweE/b/b6DpL///QrRLs5LYDObtVhuDcTCRxYaPBjlM8eSA0R//zOMQYGksOoMubUAEvnD2WFIxOLmEI4aRkoDYSxDkhKCkhKkZxQnFQ0lb2nY/Jwvyc83/5GP3EOY2b//k5ASH5rf/58foYfno/7//8wwwzMkjU9/0///MmcxiRwBgqTEGqJHvCMYSFklMmVP/zOMQNFiluzAGYSAAAqsuh+5JefeU3D5IoISiRMVSFCPWyU3jQaTlJRAgTbc+VZer5qbSiXnXmo1Cv0t+bW78hfnLf/du0u53ltLt1ep1eruyWhOruOb9FAeclv32rcDk5TMp/IPkojjqeaf/zOMQTFFo++b/GaAI5lVVUrLK1zRNbrReklRcml5JE3UkkpMWyNqdIvB2N/nEuo3XpE4c4yUW+s0X6sT3R/9LrMP9X+o3/6P9f/QoNWo8lTCFpoyYwoPJHRpTLN/ZVatSqeq1rWNNf/D+b5f/zOMQgFMHutP1YOAKWWp7EjXVl/iksx7LoKRJ83YBQufYuC4udUqNCbKUAsIpH+rf42e///HXdnnv9n+Vd/hwBD3zgz0wwww8xTGanAWpwBX0hIFtroZu5ACBwvVXLjMfNsC6J4XYhjWZjYP/zOMQsH8sexZWZUADSDWeoDQxC8X5ASDckEWRmDOWb4gRDwvB64gC8YEz/yIcFsXjpIuOqOf/OJBUFheuTv//88w5rjwkFt9mppJP//55Y89jGPMjxXak/ryeQ/8//x9UAxXrx9hKA15r/F//zOMQLFMnqxFXYKAB8te9ma7W9XtPczzsZdv83Z5/MwFHFnHgveycaEQGEvzKO9aiTt/oVDPVClb/fVGFis+3/siiQsa2K5EshP1griUsuuoRfZTcqACqDe918lCfgWwVqjM+1ibljwsffZv/zOMQWFUHuwb9ZOACnd1zLLljP967/7Hl1NES3+adLIpHHiI4KWO2EUkohGPrNN3mvjrf1HjjnNdWm//0vkA2+sgvEpyd/9mz+V5AADr2T733PMMAW/1zJSS44N6Igo+pDMgUygJJhZ1V5PP/zOMQgHSL+rZWaUAG6DyDwqIMYjYVAC4FcG8Px4QoQR2F4F4PBFu5G3NwC4F4FALgQh2VyuuIsRYtheDwkq1/bxbH548HjH6//8+Lb597/p//x4Sfnn/////+YQEjQG/1aMolRzMy0QIBSCf/zOMQKF9IavAGaUABwEi2WJdsnXS2OS2otSfEwOMLYhBXLk5ERlFJWGQwNMIRgTqPTiQ4jHxQiQm1ZUNYwklaGNV7tTQ1u0v0am0y2l7m/bO+hb7Nzy2h8kvdql/ou29VC6gSpMyuMT2OQ4P/zOMQJFVHysH3ZUADalY4gWzirF5XCYAaFK7NDvDO73GrO7+5mVMMkQ+Fow9Dt2spM5N9TigFY44+yNEGBCPTfzpxP8r/ovyjyH//6kC9fist/d3ej79fkKgmpFZWjf/bbhcBLGlIzl8Xacf/zOMQSFTrS4n9POAK1zgO4eoDn9q584ZYYDyFtyyj56iKWHvRSJmOL/Hh1v4EQK//Hj9HZ/4qF29jsef//5xL+b/ztR1v/0/q3/Uj93dw5AghkgkkQBangMhYmFBL4ndS+WsyhnfXLtUuLtP/zOMQcG1LO4ZGYKAAMExAVZDoQUOLDQ6jMJn8BA+PEw4IqKKU/uwxRgiMR1IS+16GKgqPem6t/3ZyuPkdN5VL+RTnRmUhTHDwAgYJOIh32p///iBzKxRl4BYv1f/oVBULUlekc6SQFEEYOJv/zOMQNFWFC6l3PGABktqExON8S6r4NY9cSQ9WYqsonYOMpoKZYxkxQxNDOhrqffrGZEpscIuGoIcbUbInbioCEUSjtZQyKuUhzD2V/3bv+5KDztj6lBScdktkkpiASIpQ64oLm4Ch3s4u+PP/zOMQWFEnO7lx7BhrL80Ll1lqI8NkqltV1YNuEagQYfLdHLbNuBVnnFkf4cKH5VfyAmuU6X/S41ZRJ5m5hW3PdK7NPt/+p9CoAHO6Xbfa6gPoWbCSJAwGaIuOccPrjosLKceZmAhBO6JlEEP/zOMQjFKk6zl7DBhRfbWxkkAERISEgAIy0XxAxHzQssggooQOUKMQyaOCDaGQnJYx9KfpdfFAa/6v8XLUBGbfe7bW68QuNQVdIbrLV682r0Ys4ldkKtuNFbFDXfgE/Vs3aoNP/ceb8MzGFh//zOMQvFJl/Al470HYrrUNSAebP/NTMlLXLwEq1//nsCghcS/qL/9yTv5DQ/1f9nWoAA6xzS6224YDAjGIfeesZjeL/IT1IK1GOWNAt+YWYvKFp+apH9iqFfn5Zh3xF+wZr/UnlVHPMZJIC///zOMQ7FPrO4l56BNrjsnXE6/+1ro3ro/6o/T7f0en5v8FlfyfVADaeu1sktF0nu5AV870puN/o8WP/rGkLgBNQSJv/GK0J/BOSKIUyRf//boeaAFu5jjYtAD6KrCUWtn3Wdv63/8UHCKBpX//zOMRGFOlaxb7CTF4s//O9Xlv9T+V//lX8gh/8IsmQ5qQk6HUehpMLgFKx33qQkYwXLeRK0yxIZQAsIOBygYSmjwjeCHT+MrF2xVwM//jl6B2/w7OIELKXJ/nAjznU0aa+umtiZ9bwhXkOlf/zOMRRFJlWsCrCRmo5tQKoVWHgLFEWUpxMUVe+r+Om4L4uLEr/PBwHNvPytNmvAGEZ5xl91OOH75BAAg/pVDlK/01QxuyKv9FbqQxj7f/pqO2q9Mr+vllSuS9T+eRUFekmu2uslCYJVYc3a//zOMRdE/nyqFTRipCihVbWlo5u6e9btt3VODfZ1jwIDqhTv9cYFptJQWNYAYfmzS9BgLf/dN8DVXUZFz/+MOu/yrKX+ATsIptT1kqv7tQ+WyX2a266Ch8HGxl4yVhBxkQc0oOg5b0JImSABv/zOMRsFWGa0b9MQAKKcuJQyR7RYWBoCSJOICcCsVAJtDahIy8meTKpYWbg1GBZ4ZYAKAhVrNzdlgLjE7BAAHADb+rQoIYbeH6ERFRGWDbP7sm/HsLpjSGEXT4sv/7fjLidxcAuQtEyOMmBZv/zOMR1JlsmiAGbmAB//d/+QQgg9HjdMhh4uls0b////8vmBsaU0C+eUidPoFz///GVACBh+iqEAijrIDpXRjgwDLX2RfZZXzeGip5av6xnSQJvJ6JEK2AQImgCK0EwnWQwIzQebch6qhyLRP/zOMQ6FwFOsUXZQACwsxQjKsKqkrXNQz/UcE0t5UFrVbg9yPiN3R+e/9nqf6uQANAIxlQQ2xAhDICYp7hcFGABu5kZBA6QoUGSscbReztmowmEAgtD4mRB80J98NROlVnT/V4TrNa2zCRTjP/zOMQ9HBISlZzbypysuPi0ussKh1CfZ+M6SBNn30rTOKlIE6meID/6jvhEdFHp//qEF/jXcjK/qfqK+R+d1eTVANNGcgnMYJNxmAtG/JQbLCYFBaKBoIerxEg0FRSJKVGRc4hC40AGQTa/6//zOMQrHJH2fF1cOAC5kAAoHPfe5KBoOgtCc40RVJDgudChcfUkp5pG7nLYbF7ufZgFAWomZ6DZ+w2L/1N+bHAfF+r/77GDZ+GvPKDv4Ndh7lj3iJVRBdgCgdwGkAH0FYWAWIgpG3DRcXGuKP/zOMQXGWIe1AGPQACzwFRwdfu+WokIFVgR8Xt3uA6JQr5+5tPRYJVS6/zE0SklSYUlvv/Sn973aRgs0M37f/vf2non5ynRKEyoq/Vl4P5xB4ieLCVYK7eyc/61AeURj00jnEgs4VotyFLXp//zOMQQGOMe3b/PUAKyJUyFRrax85/n9PhH5oyO/7GqTezGhQo5o9NHjj0oRAREz/zRVBgmONxoTPm+hc4kHwiQxJTTc3//NC5FR//9bcXm///1GJn/t/dygjmt8WjxqSUAiJuLPz2V0NwZKf/zOMQLF/L+0l9YUAJa3W5S26fWN2dlkZzx3qvhY/Xd/pTEnReW+xquRILzP4klmIi6FzihEBoD1+nmgUWfiUXWx2ciuQiJciBtJ2O//p5GFK3//qbcQA3///uE1v//+PulCs4hyNDT00DUA//zOMQKF7smqAGbaACEAU9Vtx2sJblm8t7vvxFi1KsyNB3D3GARUu/ALQzNG/toF8RsyTX/vsZmBKD3MP/bskimXF///0KIw6V1r////HYeXdRPSSev////84tFWtR/WpZYBRjjenmtqjEA3P/zOMQKFWLW8l/IOAJcbQ82BgPNe68djpv+3Cwjm6AEmm0Q/tUKjQJnGWRRWAMER3TcFBn52ikiJuxoExa36G+xzjoOCT//5w8Aeb/v+o6DP//3//+pH/mKAIEjHNwAAwQwNQhGNVeTv7d5Gv/zOMQTFUMerZ9aUABFWaznP/Xf3vXMf1/kQET8i+/1GIoEJLXKnGC3/hWL/VkOOrQ0wiC5P/o/+IYz//yMLhfTR/4wGP//5N//9W//+UY9niDEoaPEYMw0CjvtMAQLCoLL/KAsNVhEABVI1P/zOMQdHBq2gAGcaABlkMMHnB4CdDUCfCxC5DGGWkHhA9JcsL6aSLn58MJRayDs60k00HYQ3VLzuv7Xjmf1mvuvvWML9qi8//8zLKs4QvMW9Rt92/6y4n5NbzI/MdXf/XUMBa4YciPpg3l2rP/zOMQLF6rCzAGZOADG7bcFzuVL7b7VXs0WsJI8RB8KRoeeexQdCQkQQERJz8ieecNCh46g3G5/hxMshhMImUkplG88cI5iUMZP/qi1NTOUp1/8zo6X1P9/2///7F+/v0IrVrtswFkrhFlOw//zOMQLFSqm1F/YOABOc+rW7J8pDlzLmPK2XdWseb3QfNxkiadmtadNNbzjVFrI6F5xxyDYkcc/Q44N6HOj6m+zc4mLTTdf/61DT//+iUEot///mF//TQSEkURgQgKlQabAUgyQiAWXlqQ9BP/zOMQVFSKmuF9aUAJG69l4b2VaW81l/P109HooiTfoc/X/UlmtTkZb51VQK4KFS5p3+aa3UYlv//7iOPG/t9ttREt///lCb//LXqFlA0yLbYOqyErhxLpmR5qXwZOVgU6ZxC2aO3H6d9XfZf/zOMQfHHMGsMuaaAApSMbMHPJhoAlhLyb3ZBBA+mOM0+2tzRaaZl+boMg0JIO81JA1b/+54uGlBB/+hQ/Ba0ETta///oUP0KimMhFFBNkv//+3/pqODIOzwoGQ////oQCYdpXngOQEERc4hP/zOMQMFRtC0H/TOAAxkTIsrLaZqznaChrlp0aqNSxx1ih3300J/zg9mHnm0EYtnHP2cePouv9QqDo5+c0z//89v4rI/7ci//6v+Kjhc3//9/1f9C6qG9RJKFAMGAskEYxOgt4nJhcTE8ixkv/zOMQWFItCwF9TUAJ3dhSPWipVB67rEWSVrOmzsbddDQEVOv1Jw+/+d9P8Rw+b1a///5hv8KEl/52Io7/8qd+I0e//////i8vVEs/98oMTwjLRM1GTBxUbUQCoogbDw8NtaaM6cBRF060Xg//zOMQiHYMulMubaACBWg5Ac0QEqMzYk1G6ZcROLWo2Rc+qztqU7G5u0OxtWe2rbU1Btr/6moGlBAYVkUfl5/6/7Wk0/uv//qQNLMpA0TtaoeyX11N6P/p3Wmb039mnf+tAICBSKIwCEwmAQP/zOMQLGCJ2/l+MOAAgEAYQwdOxMMIxHsqk6Hd+zXSODQhOJGow4QYcdRtO40IFxwxkW+m+Yp6pRKaZAfJqNyZDe3X69j9v//1PY9xWC8SzRu439am6//xuBwIBDjgwj//h9QA1X9ZG+UXgJ//zOMQJFVjm5b3PMADDjISjd982RJ4tdVvGxXFrXi/UAjn/RCsdryZ+QeeiXjv60jiBm88HBw4CqQDQFIqehxs2umoV5Imp7ntLqYx74/6XNLZb+mLiSrS5ygkNbf99c6IdIWKUKa8o9RkSiP/zOMQSFQGO1lzCRjiJcMoetqcE0ML8b9CIH2ZwqFWqRs/BqKHM6zRBBn1FrVDON979WFSY1p/qVKiWd8ii/dzzVnXspUeY8j9v9Fe33BQFK22/Xba60YGj49m+LW343tT/CvYUiATKy4zNb//zOMQdFLF++l5gxSrK39nhJUL/nb0iiGCQv8twM1dTv0ZHas+qsTftzaAAZsD4nrnakRAnid/MFhANZRg/pU7/p6YCUNOONNmKwFs8AWQ21D7xaiVSNOkxpLTW8/EJ0wfnfYJXMc8t7UQJA//zOMQpFPpKybzC2n7u5/THjyKtJBalLUH0gnHWpSrax49VT/5R+TMyf//9/6n/2539b+N//38hASVcl822lmGgdrKN5URGQkOaQpt7leQXFI1/mxTT5CjOygultHZkOcfCyDwt/yo9Z+bhNP/zOMQ0FRoS4l9PUAJq3p5QTrcif+Lhe+0fGSrX//9P5E/kan/W7WM/87rfwuoyZUDmBZMBqU4edzPraObk4wASgEAgIOzAQdMPiZRdG1zEJr+F43cD0PMK4lRgCUDgQEnNB0NlnCkm4ko9Df/zOMQ+G9pOiAGcaABQdaWl6aBQM3NT87qf0kTc3QQr//TtsgbVt//76akDy2q7v//05o2H9xXv/5iNNpehdQBYZkIYIIIIEAReBmCE9AUIOEgl2ssTocRGlgMzTzrReMgC6iAFtzsMg0LFxP/zOMQtIHKGwZWZQACh67CULXQ04bKj6xgksTblGMOIFqwny0pzB5D8iIxjx7wOG14+Kmvq7sy+Ryab/Nnfp83D2ZOXdwn8p6f3zyn33x7rnhiFlOWOPOQhMNpbfcX/6/+tGeljqlsbdFlwYv/zOMQKFQHa6b/MOAJpYT1vQx1jey1lzolkWk0p7MAHlHU0cJt1GCK1HCx3N9DucNyP+gQkkc1h9qmhUYNb5o6LAlZTTk9Cpv/LHvarrdXlfs8r9v3eEgYMkZIqb7+2BCeMxHsLAWGxS6zJqf/zOMQVFTo6xn9YOAC3alF2p8zZjOH/n+t7CotMmGBUazVMB6UOzomWg29F6jX3+UJed4pI/6lvp6DZ/+Nn6t7Pt+VI5bI/b5b/1u8gN1XSVBGZZ5zWaRK1H9kKm5CSKHvbr3zEDxiyIjY90f/zOMQfGvsqrAGaaAAOAujSitpgYIQp1mi/oGg9zd5kPUpL/QQlw0Yvs6YvI/33QQ1GMW6X/6aabaBrRLP//oIem/mxZWerI////QQbp9boShOJ5urVMDX/0RTSVVZYpJKikZQO6d2E2qaC0//zOMQSFSHuwbvZUADWQwfWpu5axtSH8P3/MBeBUHyHuWav+4wD85+YcC6ED/U4K4KTTf0NFY/lTRoIY5/kQ39Lx83//x67kus9/iv+v/kFClFCRLJMoMPnWHWew6MSGGUvoee7HXf1p6YprP/zOMQcFJnysNtZUAI539YGhevNNNM/+UGw/d0OEEIkqJw8811AyFlvarPEMqopAIIv/k3+Krf//JvX5L/U//b/lvIKMavAgjM5ewcYgKhVLHH4jrWlxRmGu8uvHkVNOPOJxNJxYIyUhQjZIP/zOMQoHovOoAGbUABUFc4eaP+MQawVkg/XVv4hxgNBCD/0/8gGIhwLxULEvO//ziQWCpOOkhOLa////KCwNB+TkxYnFsiJBpO+31//8jcux56EhIfQ08n//////8oSVQAWmimqqihmkAZzWP/zOMQMGGE+4ZWPMACChHAzDjnQsf1WwwHBRtLbGoFmA7//s6AWlpY7wWhwkkKLMx9bc+fmVJsJi+z/ob/+SBSRyaCK+jFUAYSOL+7LBMyFSA9rtO7K0AYoZAJEeyp2rs7Y9QlCEkUSgY0ELP/zOMQJFTr+uP/ZUAAXsIioeZ1lauTiym6xXHDnccdY73/f2xuaUD003/U5e3jI/yQ5HQm+VZUOGQTSU3U7/3nPErf/+ni4VW53/qxnFb//f6ERv//+pE/SAJoNR69AkOZO5SY0CPxH8t3Y8//zOMQTFQL+vZ1ZOALNJ6Wt9fDe8vs6/eSP48/5/qW38VC62S0FRL5vlAHP2HSK1RVTOQSlNDwRPGqTuj/HW4qEr1/9W8db///O///6kTNG3OMOshs0kULieU0PuotEeG5++8D233QqIJLnxv/zOMQeGqJiwAGaaAAAnjDVvPlw0UHg3SIPzA0JdPL4nhdX+bpplxkyQZY4DA//NGZ0EE1HkjAgnm/6brL5u1lTFRIKUpTf/lxDp/QJzWqnlf6w9enlLlPUugahAAFwJ3FBpVJezJ242V/u6//zOMQSFVnuwBPaQAD9HpbLLUqobU3eyuX/3Rg8EZ1ZTyvMD9Ya2EhMFD9mhuYa/Wiq+Gv/br+GON/hV5hma+dg/X///+a+Bvkeo7/o/7v9tQavt0kaYIsAT4n0iw+isVTM0PInjmtFkzXro//zOMQbFOI62P9SOAI4Hzu5scWk1t7BYZGVHqDZhUC52ViSVGwIprFRdHmE9Y+EIx/Ui38JT53/+4Ln9NH/lBd/q/5L/uU4sskMDpa7MbA044mAAAi/7LQ4TVkdoq82EGTkuawXPCAXjAjAHP/zOMQmHZselAGcOAABAYHQwDRuQOPUMBsHQ3PURnneI5cAsuYrVLfwLiIWFg+T6t/yw3JiWcQJrQbf/44QGjHtkyrff//0IdzMyZf479P//u4+TJoxAxiCv///w+ouYniCXrlLsKXM7VvoEP/zOMQOF9HmzAGYQACdHE4m+swNMwLUD6hcUkVFVIDkWDzC4gCrCIJKbZIi1Pq7g2YDiadM+pLXNrJ+Zub/m5r+rmvuXn/00b//qv/GOwQlnVOlXbeTtWfoXKVKXfqqdqq23A/wVcxWKRp8+//zOMQNFBme0FfYKAKT1Pw3WQ1cbP542uc1fsdtUoiXEgYBWZ7P0Gi1ttg6Iq/zGv/mM70bN/38pRViSfWHkqfVPU0PnKvR2kuV15biBakCtQvpr6CwAOmVB+0wZxloYcpoNWkYgGX1IkIQ4f/zOMQbFUFanDzSFHwzLIemsgyqusLRixoraSekHtH8m9P00QAazTzxEmkJgPBaZOa3Ut8j9ZjDSf+IvdrdTp/rAX/Wd7eTMKKMwhOgQvEQUDD5e/b+KDNxUzpH/dCTRCMsssSiPj40g7mTev/zOMQlFHFWrADRhtDAkS6bcQrXBzU5Th2fbEEMSn7nxH6Z5y9NMsIZ5TLvDH+UOf+c/Icv5R3ifkUY9NOTS1yQPC5lKrnqGXiLqubJBmfwTVRS1UyrhaWM1/082Uq917yQyJWfJaUaRX1ttP/zOMQyFVrO5b56Tp4krZlp1S/6OU+eW/oLdUNZ4Rlv//mt/X/+f//R/1c3/KfKcmoE2u72424KAZu2Zu9h96svqXt3pVyd/W8rOW8ct5aHhpru5ItjWPKIYx0qSslkHxpEHx5hQlJSBnCuCf/zOMQ7FTHyzZ9YUAIhhn+b8hb+n5E8s///yJ+v00fqfwN/7db+ThPtiCCRriXuNrSNMCM5vCA7KnTYPFS5DLKlrtWXzhQNEjhwwAKMKuJ2mpSZsZG5uJmMOMGANBj3NUeCEBfBhxMz//480//zOMRFJLvOrMuaaABMoJof/4c8e5LlwJoG4Pf//8Ycly4JYMAS5umOf///8vm7oMOACaAZgAKwQsLmAaP////wKIMgYcS8eYjA5GHuMOPMchQmf//////j3KcnYR4TQWoBjNRCUMPzbKzoQv/zOMQRF1n+5AGPKADeH8KEJMEomomjSlZmaezqIugshF3R6DVKiGJXZSqhqFIQPDdWV0ar1pzKa7s/1u2/ShWERIAgsOCX9q8qEhQqlQlczR113mly3//9KgpJbbbbbJHAmMmT7JCOs4aL4v/zOMQSFSjfDl/JGAK61NCgQZ1xKy67dRm6Aln1VyUrYy1VC510koVGCVw9qw0rJHTpS49qfpJm7XsGFki87ANBFjyLTJXUzp6aZZ1B4NR1AHj6crb0k6XAV2MDmkxjcjJnjlFR7pmAaWbQ4v/zOMQcFMEOwbrDBjAK4AKQCDBtu1iWnkqqV8jh/kYZGpDAm49igNK7Fho8GtVUGkr9hKDS1A0exEidkvsEv5GVlchrACiqWWcBBIPLM9g3HoLQEwQnBDSIxBhCsEtBKh6y/z1/mbrQPrmcnf/zOMQoFRHutZTLBFhXzk5iPKegsy2VEABL9+Hdv92V+piP10X5Kuzt/66Qhncn2LIfnLpBv/TqBBUAFWRyS2S2cWLjFJEsY7+5Q99Oh1oyUNRlm3kKJvvYHp1Xh/mBj7aGOb0ux39V3QUi1v/zOMQyE5Hu6l56RD6g/9HfltB//0zQE9yPQGgZbX5FFdnU+rRwZZGD1QApZJv//7thydVHe0b8XwV6W1j1ODkwHkalqYGTSD5Z7hkhxRt7UHQiooRtYU0Qa5I1UXO476D816kS/9SR3u0QF//zOMRCFVrO6l56Dpqn/OVuS/0/79vt/R7+lf8o//N9agktZbtftr9xzl4sLnNt97SRlUvKkEIENdNO4KbTAQZ0OiVa4IIbvw4iIhfCdzQnPc0T//65/xAgY1BgZLv/5R3+jww8/SUBAMCcH//zOMRLFLlW9l55hpLqBPy5/AZ/IQwAq7bbZQyIQQHhMmcZrr00BYRDpy1rYm6kmN0WXZ5DLAUjmHp69hEMMZykqcKv5H0Z/SKt+gr6qY/b/13IGivpp/mUpET/9235RFnct8SaSYGsHgnQrv/zOMRXFPqmxR7CSiw0owOBO5SmFA4ND0wsorALKaaqhO09kaXtme1rOoqmsFQJn4e4+pgw+bUzt50lIN9NWitSqFb+CPtExEr+rI9Xpp09T9ZmvPbdutkOBoMVFKSTk1cscCnV48CNdU5vPP/zOMRiFFl6nDTSRHQZJ54MHTXDrbcetNbvJhpqU5x6a9dXsUdytc0IIQ01Hhz3QlFWn7av1N/ya//+L/8o8Hf8YercSVgq6d/EXEv/p69QGcogRCo1GMxisyKx2SxgA/cl2GIRgnKfOIhZiv/zOMRvFRmWub9PQAKkXkLTR5HBdWB2YFgyWkuJcsJi27Y16IAHEsuwv+/lEA3HMdihaHp8wUXUHb64gltacHDPXl3V9u+nOCRYzF5uenjWf/tTV/V/v50lV5skZQ/2O7tHpm01pPbN5maTQ//zOMR5JqLG3l+PYAKIlPsWzXL9Mopl2c9+Zmf28/8zMzMzWm3jxLwSCbmi1tyKTslcwljnMQMGpQiOO0mnKay+l+zvXTkPdv7v7sI7hKuINDBbCJaAZ5WUorRUcrGsgeMJB43W/fVmdRhjFP/zOMQ9FVnyuB/ZKAClEX/qT9od//8rCpXa3cVo/v1kfLffzvIVAKMKTl7kklF1u8pFTvbbialVniyH5y+AZLMvTGv/53DC7gcSOVpImo8ebzbx4kTWcXdCgbYkakeIsKA2Ot/zfo/9Tfq0ef/zOMRGFUHyzl9YOAL//+Nn6/TLf36/kfu1O5AgFBwyKRCMCCQSAQCAQYJOGoaqGJM/cEqT8E52F2rVUZbmapHSiuC0CUEos+hc0M1F4SweBe/TfBWAnA5gtA8P/wug2DnAohKhz/7WbYFIFv/zOMRQJwPO5l+PaAJg2wRgLeE7E9//33BbymC1jqJgCRjQFUEX///+FQDmD8HMRC8D1DnicCXhzxn/////C9pCZl4cgyyQHgSQ5DQcBRHOMj//////x3jnB3JilibRKICpQ50oSZ23eAZc2P/zOMQTF7lS0AGZQADhcWpJbT7FygbaqMKKPMeVUShrmhwiRIo1NLnXxfhwcjXQhN39r+hzta/eN8o8udJA6cw11YwqFCJEWluVr5YqSWMsYznf09Lf9P/QCSYpUC/Q4gM5iEa0p2DgBpzhMv/zOMQTGZsusD3aUAIYzBZcVs7+7sT1y5lTf9Le5lVEc0tCgHprZxzpRVN6nHMpoEJpvR//toJQ/BYFomc007pnHMdNMOOFINJEd/+36hOJjv83p/Uc//R/6kJ3///kZLUAZpO1rOWsCCg1Zv/zOMQLF0rOwb9ZKAIuypm0ebpbdW/fmotzLmHd2cLWNfVTRCJOgqJB8NVanHsIHQxLETGMJjAM/o///EhYAjJVk1Q1/6gKK//5n+oAjv/5W8yKApPzeY39wFHIJf8NKjnwxpRzwSkyYiAsnv/zOMQMGDMmuAGbaADcCKYiQaoe2OhtvbaqZmiMlTEnpuO00M1wkKSCwWRe9b0VEiUrsLDfT1VLLa2oEf3QapWS6OqdL3/3qN+vzT//6bedV51/Onv//61VdSXufmvzredeOGoNWfugBAg4Af/zOMQKFSI+xb/TUAB2JOK0H0Pkul8gIj5E2d9aKBWt1ICqFI+k41z1T6CsLIsmmZhhMSv/IBOO85qHKZqPR6E3/t1ecRB+S3//qQiod//6Cz/yP+t/+ToOcMagwv+ZvUpkkDGcLVuPKa0s9f/zOMQUFSo+rN1aOAK/3lX1Wz1d//rXGAaZdTS5o8qq/wsTCcdNmjxYqJk/hYNdpUi2g6a1hUDwG3+jv+oLTf//YUt/R/5QZ/5H/v/w1RGqyIAqF8zuDMvIe25ZOAYrAoj/37hEDK4WYGCkov/zOMQeG7sGqAGbaAAsLQSKk3OGqKDEiFeBQw4XpZnrjsNA56Z/3/hyBtJczL5v/79kyQGgeH//d+ZuXFDCENNRc////MDREe73QUgxQ/////ToKNEzgaHhIX///yAfB186QiqMXjbHDrhx6//zOMQOFTsqxAvZOAC00vbLA/caeNX7OVyzjZ3lwwShsYrO4LTCc0dMvOPc01LzkPaJRz9W0VTvOO8Wms+r9H+b0cj//R/1Gh3///Qn///6f///K2R1FGBiiZ4oBjIXCJaJ7QC7UNN7KH1e+v/zOMQYFDMuuB9aOABb8zZ5y/jzesaXE5JytUCTLTf5ujrRai3///0Ipm9qljv/E5b//T9BeZ///1G3/9vbiYu//t+nIF0hN2W27S27YfDYfDAMAXYzUSm9pw8kW6C7E4XcL4rlS6js87Ls4v/zOMQmHfKy4l+YaAKajIcA7yRHiO06QC8DjCdHyYRUR4orKSa15KJqeSqSdzIlyNeiO09/3m4ex0dtQ4T3/XWseJd36iSS//usODWi8fAsdR/9NL//stSiEq/Mv/+lOZdDcTXBSyApWB+6Fv/zOMQNFwL+xAGZaADO+8cdWNz8hhubaKFUJRgW0lTQC2XkDdSCZOPuzLL9+xlZA202ppvxnM1qzEpVf6fQ1/03/k5/5K//QQf/k49/XnD3/7f+2Yt//Mn////rAMgLcg4BnBIUhiveXurHn//zOMQQFWNCtFXaUAD3ZjMG2rF/dWgZypK1+8f/TjZG1j337GjEk/lQyJiYbecRf/+rN/QZCf/9f/+Z/IhaE03+b3/yX5f9YgTf5rf//vmPxLHVAM4OLKBFU5xcvIXSUtZThTULvU2d/X447f/zOMQZFVtCrF9aUACjNXx1+/zwoqUSRNdSiH8qS/zQXSxGLB87Im//9jn/kQIX0+b///9RiNf9+b/Qv6nfrFZ/5rf//vneIEbKGWVJLJQnypTKWjTF2b/XuoXE/9+2l67tkoVjz9W5Jk4cg//zOMQiHYvOzMuYaAAz/8WomY9R7DAf/kwxKZeEwR//yAUy4TCiOcgf//qQjvKZfOGh///77blwzJUtGEEEE5CRiYjcHMGb////8eo5zMmHSVHOcNjElzM4eR//////9y5VVSSUbnjTLEDCkf/zOMQKFQjy8l/YGAAV/DYAacymKv7GYZlslwpqamyyx5z62XfxBiaRGbilXjMdJwQ7ATrULMGEOwyGSDEVqFgaIh0Rdtkq5VSf/kRRlMieGFvR//2FBqoAL6GZW9snsBrDUE3YGa1Mtqr28f/zOMQUFJDu5nx5how3CUR5sFdKnaaNBqv1sAopfk+wVYTJ1cG4UqDpI8s7UtodGYMuEMXfaIusJbnnVgImOupoU2RoEv/2UUjZaioFGRxuSSO6BlAZCLnRzlWum7tyOVzuxFxtRb8CkELY7f/zOMQgE6FO4lx5horMFf7ibCBiblc4084C42Zr3XNj8lwoaEQGWVBZ1/wVvJf9T3xFEQNKb6JXq0/+ugEt4Znb/f2XiAkVhImT/01PzKlytyrHlrKUoT4lLrC01K4KD0STJBWfH6ouLs+yFv/zOMQwFImu3n7CCsgHYSFHPVnFH//xpiv6PEQYrNVPibP08oT859P8/ybv9EhKVQWvZpNbt7bhCC4n4exlVR1ySFgh6PNAa/Y6+FUPaVn82v3X1QoEv2jFCaepbqnqanE5wmJfwqNGvsaaOv/zOMQ8E+my8l5iDl7RFJBrBVOzg6/lfrZv5TrR/qpdegDoQhhp2aFYH/yxgwwFkxVyHUWFHUfTFxaa1ewr8iEWvZZ3voKwqGTUFg1JA/HB4R1c8maaexwTfygTJG1OOkf/+rJ/lRJ/I/28Y//zOMRLFUmClFNbOAD5H87+nrJf5avJ1TBccx0JMyZBo/ACoCh9A2AUm3LDjtEvDGjwcqwczjY0wAoPicoYe46XJlBweOTfohkFwhFxosf08fKo2Gh389/dhkSEpOQDb/5n5KeK5rx///+/8//zOMRUG8sqqAGbUAAIzh6XJXoVd///9/v3H7HoKiMcSHHIWI///8sqJDcckttkjkAxgVJcOKMDbOJlBuscgnprq7kA+FI1Weoro6yIFRLy5ptDjgVOgizB7+Ck1v6IJpsw6TpziXoX+aXIzv/zOMRDFPGa9l/NUAJhvpJHcQPnvv+/oUd9TvLOrgHC0o7CWsAhgNtxnRX0iMJKkSK0hbGNs4XX6S0KmE9RScyNjldaINk6taTt50jVmEyLVG6KQsBgzbb8qLrqSZRC0b8j9nz2rd63et3LK//zOMROFOFSzb1SaAL3et1T4QoAYvqe/q+++oA4upggfFIhMmBQ5uzzDgNTZVRfVbIUAYsA1wbL46L0NDACMDyMCMkmGo9DhsIAL4gA7BzDGG0ZQ6DCiAheg6GSbl8e5AsPo8imShobkIosLv/zOMRZJrKukZWcaAAfag6qnagm8klGCx/0TUydFE/fc3NFklMWN+pFlLRuzt+smsTkzbmaKSkl1I9KvbqQZfNWl16UutWeYRXy29G/SBoEUNxN51Po6TGhsMZcn4vRhSFreS97Y/CbwsQgE//zOMQdG+MOvAGZOACcXCY0sCwi54XOMcIjkLsex+wgrcH7UNJj43Q4g5UZykqM3zzzE5oY+PEdrjhnk8Vr5mOJ440xt/HmnNl/KtRql/U9rVf8+Q3x1vV67Y5yf//+qgCIk2VOACEM9jlh1f/zOMQMGFLOth3ZaACh2LfetlQlu6/r81Y9llqCefvW9azTE5RXoHzFV2QQ2MR2lx2t1CWkiak1Gg0uBZGyX/SmyRJEsMZv6jX66hxkqitv/8lf6Tt/MTD//82/3/qMv+T6qgEIKM+0EQAYhP/zOMQJF3nyoh9bUADrB8hDEKmfOrT0LLUyp+CGhxq3vdmM39c1lqt5EN0RJhxISuccQo3GI1ZfnCKLzvjIbf7VJTlhWE8KMOO3xcOv6seFKfGLf/0JvW7iX/nujz3+Vfw5AJU8A8CQBHJDaP/zOMQKF6He1AGSQABSWKS0JOlL8P4QJg+EH/MTMgOREEH/5ensGokJHFf/u+76jIlhb//d973UYc51t///79PFW1wUeUdJ76nVOIFhMsGhMPPfyGxWkTDw6Cw9gt/5D/j1BCtkb2s21tDRuf/zOMQKF5Mu/l/MOALYbiSY1rV6w9DrF655h2vTmWnHdfcRvjQ7Qahk1ruJSmmIIwApE3NQ7//UdJA+Oehv/cohI9hSACGlXdvtmmmtzgCk8/qn7fDLf/+3Q4Wt//080gSVkFFRWgzs73T9gf/zOMQKFJLStF1ZOAJRwTKbPJmT4wNCMv/la9z8/w/Di0ehxwQnNyejI3qR0OHgDn9v/vNNcKnGFqlG/9PQFA9ev/Op6gNN/7dN85xAI79P//qR/+WVN/BoWSZqlyAABEk9QxVwo6+y6Wdp1v/zOMQWGqKSkAGcUADHaOUxZrkVOFhR8cUAvHwXg9IhGEIIlhkLYhB+xxh74snKzDIaCYTkken+c/Fi55nj1vp2Pc5jyfoPjv5voxi6W0H36kXN/q5hIt09P5D/ZwG/fQAVEgH//gNqplJ7iv/zOMQKF+FW0MuZQACnRtCOO+DJnAac0yxRQ5SZTs1lGiOaZBQ8Bc7kOFJQQZ1PLFWl5Dg45nFqWjKd+ruD1qMSD93uBtpyuI3qyl4sw+i1GolUclnNU6t1Tq2fJFdetz9mhQgNqslKAEZgXv/zOMQJFTrSwP/YOABW0meztqlSS0qpaaJTNLlqzuh5+OP756hMnOYwi/TyowRbUcaNzZvnBYv/0X0NA0i1PkvqccJTV+v9R0EXN+pr9+PCX//9U/1/yn/QABiicnn0ikBAQFSi4iTM0EnWT//zOMQTFRMe2l9TOAI8vG7XWTJqh9hOWQ4xzGGyW/lQlKFUmBC4+MHzvguF3b4qFxuaKhcDkuyp6nf41b//0Jf6P/nf//Vv9P9P//x5uqoTWtNJgHOcaTw+b2A5nePOkQ0YopjtgkODRdVRzv/zOMQdHEsKvMuYaABsaKOFBaZ2Oc3THIFsE/JobvzRlIIGhofLE/zczN1puiM58zNlf0GoIMndx3l9v/emZm/oZYTHXV//ZNN1IemVNLiWe1Gn//Tf/+s2qvL7qjv//8tVCRkkctlcltHQE//zOMQKFSFS/l/POAIiYMKumOWreTVO13Fi6mg6+vbjci2iBCAENVa5XHHAqudnViOQEo7MHU/9c0fEU4VHv5oOgkE/w6SyLfCbt6TuCp3rpWGv8WBoqNUU2Zv/ckDwEZX/QHXoJsaeGF9nVf/zOMQUFLMazZbCBI7cMSP2B0z6/VjzoWAwEH+lAxQT/KsKAs2bM3/VppjMdtPR+tWULkf//Sj+iPzeb6t6t6f8lWL0t7fL6QbV1k0U5ty2SSSADAmMu0vV6opa5nSbmmpXbUREEJ72fdwFpv/zOMQgFIFW1b7BhJ5r4CKIK72TeyiBMKJAAhGWmhFg5McYhH8BGXZ//VyDAM/h/pFEgd/rCxzPgh/6NP+D6QD3G7bbbbQRgGJUV5nxXwPsNQ8DmZ4KsN1h6trfaDP/K1pbJAPe43GrtDy4a//zOMQtFSLW8b5Ii4p9y0aJY59f+EOLE/wor/DKoAP//YNL7KJIX+n/6F8ab/X+Q4//smq1CT11132u+2DYsuRWW4J4nZiQ+cz2hpGF6WtP+dCTGx1Ucu/6Kskrfg6HjwRbY0oMf/0NKFx3/f/zOMQ3FErS+l5hxR5b/Voq//WoZX0iLLf5f/6D+DG/0/ghQ//ryaoElxxvXW6N4M9E6rDMfbBq/ZqRXDOpN51srEfs71vl6t0iHyqfc0VfSaY0SSD+VESSiMF+ioiiSCl1//kRMYTfyos/R//zOMREFUm2yl9YUAKWdiMcR/xFyxL/+S/xE//yNFUCiIogkoggggkVHB4KFSF0y9dndumTcd3vww/DX2W8CMQAhBmKpD4XA4F+BAOl2T4rk4X4jA0C0LzGN/LlRbNOFg4gOICEi/jYkH4lgf/zOMRNJrvO2ZWYUABMbu040ej0z/kDGj9ydCQnSYaQnIQ//yg8KEoX4VQBY+ATGA0AoIma4qiyQsRJ//xVEOVIhYGBY8qUJChY88mWxyHHnTrnf//9CT//9SgAB2NSWxzmCMm4XIxdQtvrPf/zOMQRFRFC6l3PGADzK6RmgP4sC0LON7tYmY4aAw3W2zVYx+pqbRoFGtrNWHBiS8vsMEOQJaRrngyGyrRV/AA0SGkFLRjKl/3ru0/+7Zir6gCXNpJZI2AEAyNAe1XtDNgiUIQdBJKhxSE6xP/zOMQbE1CS1lzBhDSdtmM7cwM9KnBxYSsKlk0hV8SiguMpDjLQEIgK5BPndwLE+qxKZXROrLFXOZq/a3thKqoA4Wt5wCDx/pZrhIk3Vs8S1qEPbRgMV69W3sRIiJAgHAAQjYgQicpvGqCEpP/zOMQsFIjmrZLTBixxLghQMNQcrABI4ZjwSNm1SCNaAQtM5iLMrU7ztJqq6v2djf57ytUALWtSWKPrJQCkjKZKhhVeuHpphWnbTVlrflGQACxNO7KrlAOx92gQtf6zrmB4eanZ89Fp0ojV8v/zOMQ4FUHywlzCxJzz5ZX//OhwfR+g30RQ1Fb1/2HXUBf/vrZ/gt/qlglNtLtttvfxAQAiuriQ58O9Ek3Ska6cTiiJ/yeQNp8YeK99bcLJF//XoSqfqoSiL//bfcr6P0X6XGl//yzhleWUr//zOMRCFKrS+l5iCp5ZeYf//9W/33+IvW7yyzS8mgAm3JrXa9QzIx4QeBbWjwHT3Lak+/uddKSeMx1gqFK2tirIY7Gt0OmO6LlWUl9QJRN/+3Ksj/0f9qPNbzn/o/8459DvO//+pv9SVv5rq//zOMROFRMaxb7KVDZNb/1kL+TqDTbkkkkkCEA7A748jnmJmu6P963w4NukLKqxQcQa1ZYfmfai4yvlJaubSUkHAofV86TEoqpRXopQQhBC/h3+fCDGAG+v0ZABkZrHQp/kVBDfXtOVgRUoov/zOMRYF7o61R56BJ5qf1cuLCcvBQvkv8ENgMHQAF+YFfCbhiA2hRpZQEiclSQwZaw3ecdP5AqAt/478YJW9UoFEAQ77OA//5zlKX/t+5QqOv0/eUK6KhoM0pJP+K1u89YVCej7QmMDyg0oVf/zOMRYFRnusPTKBHgqVAD4P3EAKOcKizsymHXnhl4343//UxnPmaeXXe1CpEg7oKgfATczcSqDY0K/m48c48+kav/ypiHDp5E5n0fqR1GzhX+rpIyuz6cj52dp/5Di1WHf3C22222IxAIwwP/zOMRiFVl+mH1ZOAAHy05wH9GkS45aR1HrVMFgQgwBDp8NmjsSLjAoAXCoighwXMkOBuMLgxS5eKCZESdWTSwFQiOQDeM0Wz2pYssnwCWB2gNNlsp7HdUAaA3AF9ADmGqx39SX/KIy5E3IAP/zOMRrJxMOrb+ZiAK4Abv7q//iCY7yILK4uQZgiAsv///8n5MDKDgLZDCIC4yfNyf+lS////QQQL6aZOOlFTD1jMAjXyTTFzScUARQOQRjAARhyYyoarxkL5siWm8oI4pD44Bod5aCWTRAE//zOMQtHYHqrAGaWACD8GgeiemannFR4PI70iUR0VzSDzl57oEpQkn6UNzsrtea229JxOVZc/SB3/+/tuuhP7Pp0fz+3/UotygeKdbU+jR70TnRp//pECTbslljlDAEtAPibHG9STjhwzC3SP/zOMQWFSHyzb/POALMUPTVuS8GffscGjseGzkjujHVOUY/ZRao6KjuaNRc//uaxopLCgl/kvrNGuIBcb/+pB+Zd0/u3dHKh7/yuQURNqKyWS6QIgJhgtStBW2Qu08s29dNHfuUcvjUuc6Qy//zOMQgF9LWsb9aOALtzktw5pBGEVji6xq/E4iF1VjQl/oNnHQGt5Ql9v+Oi0Rn/r/znjZ//6On0EoqR/q3O+dQdTVDUo/nf46R/+RVLrJAEMV6CjABCJ9awrE1+m11Sywq2txhoOsdEW2/tf/zOMQfG9JCzAGYWAAJZoOh1sMu78ex4IIlki+/v/pAd5odNjuU3PH1X0akpEpUTR/V///+0De1j54642/hS//v//6RQg3ZR5Y6kqrVyn8oHzIMgkJCIB5f/+pv+lUBuNKVuySQFQDoA1EWdP/zOMQOGMMy3b/PUAKy6tveD/FpZZv4LLrVN3x8sa3Q0GB6bnHtlRVJNcoyII5CC0TPmmv//Y00LQXRNo//pahwL4UpEd/6zfnEQTyVv5rf95QL03r//6koUxMb//6aioNnCJA8yAZJBEDAbf/zOMQKF9MqmF1bUABE4GJWrrVnqN/nVi4IF0Raburkk+/rOatY60Liciue6AHidf+QjVvN0OGICLez//tRRDCCIj2Fw26qajm+bhJJf/86vuHhf/r/7i4Tn6///Qbf//+PlSBabbbLYBaIBf/zOMQJF5MO9l+YOAICgUCgAafXVpvutx86sDxr5flSS/accwpU0oUIOwlvNNMV4SD7n/+gkDg0ad/9XEcS3//yZkaMeb//+ehwPBY89f///xuTa0yiuv////5QgempMs1SVRAypqbBzNz/df/zOMQJFbL2vAGZUABX1RpJRxXSUzBJHzuXMnUXvFxsjDrqwKKxFumcFdUyQvsI3WLx2mVHdZo78b/Ui/HPjP/IP8j+a9dC/lH+X8p+X+Q/ZvKPJvkT+jy3bkUA4CKq5AgAoifngKaYdFuU0v/zOMQRFPLOtZ/ZOADr6VMtzisu5+Wq37/97/E8Hx3OPX/zhaJJvbKpf1IBo7/VHnUKC8SW/t9Y6DgXPb0/x4Rzf9/1FIm//+hv//x09/h1IJAuGE0BQc6a0SCFq4dhvKu+LDovHYRlYuWNWv/zOMQcFKo+oZtaOAL+Wc8sdeOg5bqYPqi0Y4400VCKPGzTjmQbP+gjCV0vnKbqqCsRSP//oNn//+c///qNf+R///DaARyMG+QcDVyyKKH0cF8z0Uo7CZ0rV+/KabnmKReIhLJqZAmFwd7FEv/zOMQoHft6wAGaaACw6jog2xJrKBMMVGTLTQ+SZPPmDGiZ1lKfsnpm6yKk62RYuGySP0+eus4pTLWikkm3+/6nY4yT2rP8x7aj3+37a1KUeRrtSr+b/q///z3/KzpGT9AToYOFhFLE0bEUPv/zOMQPFMrO1D3ROAJ42NxuEklUaopXbW15s01jRIGppqtzm0Oc7zjh0VP0O//8oXMe5xzNneimsaii0Jjf+vX+BI47///KDc3//6cdFwc/9ioAi1DxuAEjecAMJLixaIAlGVlUlfiLUrCoXP/zOMQaFSLOrH9bOADOPP7rPHHHv/itTb0AKfsulSx3m46aOg5b///jwuFyPR6Spn1adQLC71/6fsEJZ///9BK///Xmi7/5KjUQZCocOSlQxeDzeRwMVCCBngL9OQiWYOAkVrUllIkOAc2Niv/zOMQkHkvOoAGcmAAJoAcZg3iD6G7l2bKZhkDo54yP/ceyCG5sMx+/wugHSGa/q/9y4mRQnC+Pn//8SmbGzP3////ZM2EJB2MnZ0C5/////QSKZEy0kyalopW//////9ROVQDA5c8rL7QSIP/zOMQJFQtC2b/POACQiAoB88tCy/taaWtc9gWsf4t/Z22QWkaHOpppsr6HY8C80wHpvip//+lG/NCETHf1yv///oeEQt/3/+h/lDfzTQyd+rN///1biYsqCeDssrdmlAJQJcjkuXXNS8iZU//zOMQTFSNC4b9NUAIjIK0yc/ZsoH5591hdTtX5wvLfzwkE5AFM/iU///Srfyomt/KPLF////QnFH+zf1zhDeLh1/rC+/qzf//Rsh8RQ9o5OlDN4UNfDAw0CzS6pMDA7AKAGA1MYLg9iKwdZf/zOMQdHHN+iAGcaABVhuIBexFlAAXkCo+N5cLx8T1k2JFMeijdNJExutlO7I8eQiT5k0aSA/t/SPVdaNX8SVrmT8ez2X//4zjbt25NNf//9KsYFGa/VtUXn////SK///52T2gVivExEf7yC//zOMQKF4q25AGPQAABVoqnVq3Guf0LMS9UlaKqjSmmJvezSiVbaP/392lG+5vf3v2i1EIv6e6iv//46iXhJ++fj+/e0tK+NyqB4spiyv7+P+kpK0r/r9yYsLvaSe/d//XVAR231/1tkbA5CP/zOMQKE+Dy9l/MKADGgVPPK7tqvjJq3r71tdntvsgCOStBMV/fDylREZHLOMDzmypgDB1lRYSgyhbjxl50O8s/mDQs+rFLE0P+2NZkU/4p2zSlBZtt9tsj8gTAFD8PztvW1a9kt3Wpt5i6yP/zOMQZFGEK9lxjzOIacy0ZGkWpXz7FOKq4bfF80il/P/3C1eOyLOcExEqmWaieEUBB1aP4w9tzt0qsV3iVAGedDX///tUFux2+3a62gEIAJWbTKzsMYfDOvZ+L1/6o2b0VoL09uFw9NiW/zf/zOMQmFGlW9l5gjSZ+ghHtZiEbdV1ehEZOvGZnf1kPBhSKoIGHx6k4FXN/Ng/579sEPXtUK/Uw6gXnNY4o/8fhAx6NLntU9nDchrf/OHE1vXUa1aiQmhVdy6i0EVfRq1xXIQE/0oBpAKu0WP/zOMQzE8qu3bx4yyIz//2Giv7CQFb+XGP//p/QRf/f/9/T/iXi3/21VQk7kZni76/bBAYh5J7D0H8uzAh73F6xEM/YsyDkakDORExUKAlQ6ePSFpELg2/x6pQbfPLf+/xqQ/5Qn/0zv/+v8f/zOMRCFJqq+n9LUALpKO83qZ/9W9H/yF2t3/3yCgAAa44ZY2LHJaxpIAADk9YwQaM0VTWA022ZDghB5oiUDml64cRIS1aS7cNPaJePg5QfjIOUSpsOATkS83JYihXE00DMOUcJoqYPdT/xZP/zOMROHXKKol+baABw+VllSTotbX8zV9FGtum7j2zpW3R//+p4/EKs9SSLvU//Q/9LOSuqAMT1Ultus2mr1ms1ltZZ09kksFWLaztGSsCEDNM+aU0ZiXhVR6BysCiyZ4qIxFWKCYT3HCoyZv/zOMQ3IrrnBl+PWAKaaztUdZ/HeT7IIfi0eC6UH6n7/+8ooqg2d/POgw3N7lM/ScLJMs5e7dX37312xjL+1EHuPIx537nbbv7/2exjIYy2Mfs6erzE/rT6H3z4f/4r/zEADkabrVySYDNAT//zOMQLFGlO1l/QUAAaRPJj5LTIHpiMEql1azE8/WnOESCuSqyDELJKpppoCqspCSr8zc1iboRCy3/KlvKurPUZd3lflHyxGV+S+JvPktuT+RqfSgLWvccVWJugtJWlnNeAaK92Caak+tLN/f/zOMQYFRmWwZ1ZOAIEoo+fa7nnw9RqzHqcC4+tABiXR/MFLqLajuzCAEjv+VFvjpE3jpI9qDX4671P9OVIy31/JfJZL/PbYlPVNOVF6GSyaZRr6MwRy4tIGcFQBGk2Vyp041Io0bnHTKZfDf/zOMQiHdMmpAGbiAD8io/IUVE+V6YI4OcfMvrl9TKLArR1/uq6DGI00BnDqP9SDIXqnUiQSS//W6esxSlo26//06dqm8gBvJQ1lgx1m///UyH/0zhVMUUHkUO0swNv//8E1TYtJJZZbWnBKf/zOMQJFSI+8l/YUAJLGMCM7uyz6dwWh43Gn2rW/poZi2e//+9CUATJWSYYP2f70EYfm/qJCFRzpEF//nmuF8C8NW/Qd/OhfMxP//oX/0/5f/kfbxT/kba1EIj0JDESjkDTDB0dI5EKlpniPv/zOMQTFPrOrVtaOABLZbI5vP+50kn3zPW+XCoBU15w8PL/xUHk/2Co8cO1pCIs//zRqSFZUDw7+o2/xFav//Lf9v6p/+3oS/0/yj/8PgPNoQGYUgOOTRvMIT1FAwVdNtXJdt3ptic631QFYv/zOMQeGjKulAGbUACwwDcZi2FEPRIClIRMJxFnCLOIxmLRrGhWLza6qfcwidC2nk6GGfIS3/MUnJ+2UT/+jGdXPOarVLf/b0Ztld/Itd38rK69dDX41KoOlCykKAtOsMZm1tYZbcRaO/fbsf/zOMQUGhGy1AGYQAAZPioNxHDoeK/Ch2eIY/B0dXQ48wRyDBVZWPn2MccW+JGjXuvyx5g8UMTXG7f6X9OovbwYzcYqoS1PnATB8CAQAKLNdDlfSJyYZDARC4Ee3/p5T/pqEMhaWRBD8oXOVP/zOMQKFSMuwF/ZOABASK1ZDFeZUcy11trXcfxx/9d//2ppvqEBFt30Q5Pt1NFv2/9Pio8iSOjv/1qYccJYSnJnf97dIEjn7dF/faOiR9v/+o6S9P//lWpBW2jF3BKaYF4+s0txo1ewwvcgqP/zOMQUFPrOtP1ZOAJWv/WGGuYVOa/zySKPnnmA7FzPUizJUW+h+iigPTzf//HiQPi9Crff/whFvr/zZ3RQElv+d/+Nf//VvNLu/kczN44Y+dESHADeUjZFcNw2ugDA4Rh8CeiSudTrNDh4M//zOMQfHKMqtAGaaAAJIJeprl8vpJgtomx0lfuxLm7jKHANgyx8/rdPSJpeLzn//QQamgtiXRb/6kLd6ienQTX/+m/pu/MTZFaDHSkpGl//9+pv0GJepNajNnZp09///rUKuXLb1DmBkQhUz//zOMQLFSHu6P3PWAI/xVzi6vBx9Yi2g6tWm8uH9sxW6fif++LSfTpY3rdXt8eCO6+Jciy0TltdSS4KCCvTr9U5/8VIFCddHv+6//5Uf29Z7/J/63/5JUaqMrpyzKYkBLlCB4aAy9KmDvLQiP/zOMQVFQqGqBlbOADSv9MxXKjjVmeyx/eGXDwfD1naYzWv5QNfHclm+gRDP/kc2hIFyat5H57MAWLIqL+O/8d//+pH//5Vvfyr/8gqANk1ll1u212w+22oAAUEliAfEUhTp0NZUj15bzH2l//zOMQfHNp65l+YWAJaZ+Hh+IMzXNXyUlgBpLNmkEcPIGg/GLiasgeUIY+uvmugvaqWIxd/xecVPn6f/BNb/w7//9+iIFe2RHw7/5u/ZN2VL7r1G/xH/xf/J+X/3bPzuU1VAmHvkgAgYEEZGf/zOMQKFnlW0MuYMABYIOu+H2mOitJsaY2PwNK9WRmHmqoczE6xMRwJaOJtGpt9wF23wV3vskhtgfdXcI0Xn+Xv/7YIT9YNZA/wY5R1bznC0+t0RT2q76l/UrW7HA4EEmPLdQvAbm4y7nKkMv/zOMQPFJl6zR/YKACpu470NOfGb375ura5h//+Yaxn0CIr/qNDpftkDxj5C3//6GibVW1REGoGQAgaPf2hJzxI+Ior1B2e3ctJVhH/Bp6tlQgC/vd4GfOg/kNBQMZGA65l9RWcZJgpS69rvP/zOMQbFUl+qP1aWADn4/rdjueWKanF1uKuY5fN+rZ6nsZegZnTowTo2UXMmuv//mv6KnxUaNflJaoCv1uq8t1B33/JfzvJKjaIgGgBsEOZKJm8PgAAmvpmp12y3gCE04ratXV/KsNiUUF3Hv/zOMQkHlr2oAGbaABpiKCdFKibkmpJYyArSMEzJRC2YoG5fNzQvj8aGVVWaHTcuIMbCYlInMrq6ablwuIJtRNm/+n76y4lLp9L//pvQZ/poPUjWf1GH//3//cp0R2Jv//9VRCM/INiXMELHf/zOMQJFWGupAvaOAAyHBC56ZLgsVSoYMo+uqNxJ/sL7xxXK1hjqmrFjxqw1U0WhCRZHNVTVR2/oO2CY590N//3HRaZ/ob/Qeyrvy3CQc62fK4t57iV3+2ypQTkWbLq47wDDw23DGYOBLiahf/zOMQSFULOtb9aOAAMfmYdrfJ6Xesspn6mOHe48HSyj5iog8/HiY6VJM+/48xUWfRv/1NjoZt/Qv/rm//83+bb+pH/9/Vv83+o67/DUOVvBEttlrjcstdCodAoIBVNRE2H8Il0sA1FAWPFAP/zOMQcHDFu3l+YWAJZ0inrFJKXHBPH8dSYBB4jmiqxxsbDjB1kAPhCl9O82XZFh7HYHgdoJ81X9dR461DhMVL/5r//8+ylnqZZ+4NghFP/0kAHSfO7v/UCBMLAAmO///5Np3vEopIESld52P/zOMQKFwJ25AGYKABn0VikzE60VlM7wWOHGZmVjhpRG1VLjDnUQKIkVeyOYspketfYxnZRQP9qfzT5Dqr6tWq0b9VRHGjQEA4sUQHfmdWN//FgmMTFku6P91Cv+r/pD/ultsk/wZEwWP/zpf/zOMQNFUFDBb3JGALJcM9K+zYfTx4epZZeSqpBgYmwdjqrAFVIVPXRegjNYdEWD2Z8qqFchDQ0SnwoldbK1j3hqotaN1bvtXbuSjhBi0qfMtNBUs0J7b7f7ba2QAZEMIhtqwuWLJapGOcgSf/zOMQXFUC3Cl4yTEI62N9LO7pWBEqs+G5y1DCIlc9dpAq021icGlhMBJWoGolAz9h0NCVYNSrqfBUYOeVSFRjiJV22S/Ep3LB36w0LSDAMXTgq8y1Hf0s5EQsHB8Q1wCD3yRdhYcGHzu4nDv/zOMQhFHEKrNTbBjAGALlghBzy76AYsnm5lhKdTOUOwPDhryeXb1n00seD+ih8myoI+J/z9Z/+XAm/5R5RCTutt2u223HCgFNAtCJ6BN0UMDmIBguZ8vVYuy1PL6BAN904sT9SVFggreV29f/zOMQuFGHy/l5JRQL16EFM7at1N+qARUd/X+xgK+PEu1oG7xaerZ15VQe/wMHSuQUAtlq3yWKUIZg5mT5FhRUO1GkUJlS3bsA5zFW/doHpncbPOZY4iw4VEEZDDitUeWilUc3rUVKNFWmZQv/zOMQ7FRo+tb9aKAAhn/VvVlbVuv91Drb//5f+/9RX/kvZ1u/yagNGUQk4gQDmSWOQB4/vuzEAPPwLsx2SQaQQMCRo3oHA4okwnDBVKhYBshTrbkDmBbA3RAh2hbB7DjCpCaFMTwuDLEuFif/zOMRFIwJmhNWcaAAcYYXAvZDoPSKkFuozYhoLSW509q2jnTTC9lM062X/kuboFNTUalJVf/ZNE3Yly+bopJaTf//l83TL9JkzQy07t/9KUKOXmACX/teAKQPhn3go+eAKQLTE+3PTHjKt9P/zOMQYGdFStMuZSADQ/K4m/VkBSJw9Ga1RQMrvXPKN2wjqEilwjrfqpHvciNFE/1mHqH+kIutv9dJj/31zJyXrWGa2TtE9mcSLQwq9FKhE/bL15c+9HW3gXX/6Kgid9AU2ADo9iHGwy4jTpf/zOMQPFToOpDXZOAAO1OxGHIayuY8xm7PMM+U30YPh0dpPBaJLedRSQ8/2zxqw1bU0x//fQ01zH1N6F/6Lj30/fNr8dI6FH/eVyPuQe3/52FIrBePWpRgYoF1kl2L0cao6TOirWoEuWK9yxP/zOMQZFGl+mF9ZKADN7K/PWMdykDmFyJIEg8UflUpDxnqgtdHQPfM/p8ytRRIPPqXoLazodLO/LcsHf/TkfI3Z7+0Q6noCihBAgoookkAs1PG/qb4pFyJNYy93oAJm4ckEpcGGnzX02S1S7f/zOMQmHnnWrZWZeADqshJUsrN7YUESHEJfEZWP//sDxWOFHE8VdAl///dxH7fCmkPhOrhVM3///hx6K+P/jx3Tk+r/////fMfdP/v5iQrgqz80GC74Qexb5/+J3O+eXDMI7UkajCcqWQ2qS//zOMQLFUGytN/aKACi4zEUyWPT9elapLJiiqwmli8tpdzNbK7tg8Uo4UMYRKJPiIrMVsxpnUoyJC5jGo7//0QSBn/1HfoZys4r/fwadxb9+7lOoQ/6qgBgA/bfI/wWBQZCenAOQADMdg1COP/zOMQVFVGuqb9ZKADcjm2x0USkFWQ6jNjC/X5jrOKroKjwGFGU5zs4mLoLVpyh2YAvq///GAw3/gX/LiLvyvKo879GjqD3ETv8OzVTlRX8DQEu5sim1cAQFreqyfdtCu3jX1Crb6k0CMJ+U//zOMQeG7MetAGZaAB1upBOwjYjZTBX//C9lMTMc5//8Ycc5umSZT//xyIm45DSOT//8ehogXDQpmBoS////7sPce5umXzc0Wmaf////oMXC4aJqQJc3l8vj///8H0EgXwTEEazbEaUoA2ymv/zOMQOGGH60AGYOADUl8EM3mGPe52IApYHyOqtNHgFE7OMtFaCoH0eG2v80cHjTTJzeVZcdGrGjpHyn5/UdOOUbElO8q36J5x0oPGjAVBCX66uoSsBYOiI8WO936+j/oVFaUoVDzUxOxIezf/zOMQLFUsqsB3ZUADaZxjKNxmskspKXZdxx1vm/x/XzXdZo9AGmf5t/m6KQhY+r//2USUGZprKW/52cehEF8FKRHPX/v+cK5K3+//0Fk3///lC////kSoEIpGavzRsEzJUNVEtK1EvWN30b//zOMQUFUrOyb9POALvv/+kH1r5yHH6Dzc6f5xbnEkZDxQFRz2Jf/8dIhKLzXHTXqY93r+EItR//qRmWseFBeYe07nm//KEv///HiX/yVUARCSRtsySSCMSCIRACDcfB4DreRo7w816akNQHP/zOMQdHGrS6l+PaAKD5QSCJgNx1AlTc6m1yQMVEwxq3fRJALoUUCSTGUQUe+fM1DgLqlnYqH/9S0ECTSV0yl/9NBEYdJK1qhhE7//5JpJLVTQSXWdf7f//0jR+kaPnF6dSFGpquyQmCgGGEf/zOMQKFUI+2Z/PUALsplfMzQjprqN9XxbevnWdfKid8gdP+MRQLJKaskNNFQjR+hwVj/9r2NISwxAVE59un9B8BeLLL9f8hCgJjuayr/kQXv/T/rd/ketIUMKgHEzotF4OLXeKPwdBKG0urf/zOMQUFKI+qNtaOAKMmrb3rG939YYY8KiIcxrnnFWqn5UJQeE2OMJshc7+ETv5zz1c1KGAuCwz/v+ygEn1//4it//5QXf9P+t3+bo3w1jByJs9JwhWhpOXey6GSyEVy1gEAE4bnDBFQ8BwLP/zOMQgHIMeoAGbaABgysvJMS5dOrBXCCXykpJbTvieDkC9j3P9X+XDpuMISnqf/jgEYGQbmBoX+l//pGg5yXcvpvV///9ZuXEG2Jc3dP/+v//000S+bmjPyUQ///4fMURNQZpS8MiCFQSo0//zOMQNFpmq0AGZMACq+tFIM5qTUMO0mokzQaUUCQa0iT6kRFWE6ZrpHVjsiRZ40HRWi+I152Abe+Mxk/c31ubn7L//+o63z58O9VfJPa9lHbR2aH5NWnnO/XU2WVCBpQFSIxXQeRSmhc2CYv/zOMQRFVJKwB/ZOAD34e1Zhm1Vq56yy/+1cTiRdmOEI1HTjjpx3Oc479xiPOc6uc6f+VCxI5Wf/21qNBc/Hv/9CgPTWpjiP/vx93d8q//2etUGW3Vm4oAqOF6x7CMyBQKUUspk9DAtLyao///zOMQaFMpKwP9ZOAIYe5vHm+825is6jh+jKOuZP3X8UhKhwPnbt/9Rq3mtY1jceOmnHmCMS///x4l//+bUj536n/+d57SqAGbyGI1W12e22u2Gw2AysIQp0C7USNZ2thhrDU8aVPGggGD43P/zOMQlHgvO5l+POABHMhp2PPuOnjwljjsd0YTEBUQEcfMdXIK74lggNh4hC5bb+Yznuiiqyq+rv+GSU9KPBuh3+7/vOCMldO64VL7aGf//weHnfr8H5k7////nmf//ylUGhm5O+GqlzBYzkP/zOMQLFVNCyF/YOADrNzpZNVsTF633/yrODFu///vaM7dBvZfm536mjBw2G7aIcLf//dn/NCoiHfz2q3/+n8qC0XP/X/XKFW6p+OmiQd+qf//2x3wfjdUh37caDyAGxGpOakblNRehuyqatf/zOMQUFTNCvFdZUAKWW8cZiT7/WvxxR61MktqO6GOeVO/oIZI++pb//oTHP/GIKW/tkLf/5v8gEgLX9H/+UFp+rfqYFoyd6///0/xiXRaaloQl0xUkESy/Vxh8DI3j/q4spLqWodlBdalrSf/zOMQeG+sewAGYgABk+pAg//jLjjKhQJz/8yJw0IuT6f/+aGZPoEwRAif//6jRIuHjRbm////6jRMmyfFACFBSgj8vE4LL/////GbImRAzNxzCKGii4aE+mD///+D6AC////////8wIygGpf/zOMQNGHIO+ZWMKAChGGA9uJ16WE7IrMv9DwscqOg0NFQ+ZhpjlGq4shDCzRZG2xOw0RKVmV3fre6B50sbLoetVqoi8zyG9aPT6ipnKYAg8UoiFbelTF5a8iGJUw1Hq/xeLb3+2++1tkDmhP/zOMQKFOFrHl/GGAKL6MskSOTEtwRMFSdKqfJNFL4USHoVjL8zIBp5XwrTLbFaqFBBVaZ3JmpNtzzIKHRA357j6iyFyQkRK0HYllFjCy+FPt3WzTrp2g2bJXLLJPsxICXi1zPV+gVqIzA0Ff/zOMQVFJEK6lzCRj4MupHkGmqbY6d92eEynh9zWglWDQRxjzgY/V0OAW49eBoNHuDTCwFLPZ1ljw8Snf0waBp+HVan+r/9u7JEKm9QQDDmpzjDzWLg6DVelYZerqOCroU4WPQbBNBPDSe7fP/zOMQhFRl+rCrSRHyfM3qOlnn/mSjyBD//GVFxAyjTOqBwXl3pAFVr/9BGXFSF3WisI6QR9hU107eIDPKfT/KVBTslt2+lulGB1oeyM6g8ymYrmrFC10Ci3aW0+peaMQ4J5obUy+1fpg9L3f/zOMQrFLpK9l5bBWJ9ViKAKcMvr9XWhWe5fH+iB2Vyon+hfg8L//+Zv5m/y8B/X4C/938gAejUlzklcDtg1E0IGw3K7b7ayoYpOWKaTc04rz7t38949Y19RCsSjw+SOhmpEOzG6iODxNdmo//zOMQ3FPpKzb9YUAKE0ca3+d92/lC/2eUf//7P/Vv6PxWe/1u4B///JzRrEz8wM/ejmhI3A7M8RQuHjgCIgZ8UjyIfxfloUCJnFvCkTUi0xYIYWp0kjQ+gXi8twJgJQTxPXTfQqxM0C4SA8P/zOMRCHrMGoAGbaAD/8YAd5TNSX//50plw3Uy///zeyaZqkxL////nDQuEgaLL6kEDRL////80cuIl8xL4XDAcC3//+A034G6mJmwgwIBEAq5lK6nktRiTyOTv7fjQQxs71RNpwPrGkwKmKv/zOMQmGvmOwAGZSABc8q2uf8l3NdVP7kvoepbX34JqbU8U30/4m7+F+8/dm3n6n9u6hGs3IC7HYwwUHrWMQWquMLokFJc2+4WepKLVM7V/9f/WOyHSQOg/En4NtQliCaKkV2OK3Z73heZ4Mv/zOMQZGloOrAGaWAB/xJmw7WtNoUMUCaVk480pOuN2rMsosy4So780m0lxyrofNOf8P7VW89NzX1815y51/mzbZ1/be+fj6mq6/XesNKorrrk1kJ2+8VcqixbbcrUAOWW2yWy20Si0Wi0MAP/zOMQOGHH25l+POALjUIxGknSuR7GXpfFaXR0rdp6M/FRwVhgSzBw0rJjg4Pl3DQkkgJtUqwpLo0g9lCxIgrHPfX82ytvZW/47NVNCxzpX/+kqOsg2Wrqo/kFNsnlf/6kQ3tgNCjAobceia//zOMQLF2siwAGZOACNdWYxt24csPbVg7BzDA3Hh5SrphKaNDwbIPMEsnVBIL3YDmnnvxw6Ji6D1hMX8wxn2KEfZBn57+ZYivrOGyf/+Y9dH8p+/o37f111b0adplH8ogT4QZ1kGNwIc2pJeP/zOMQMFVI6vZ3ZUADjPHuijCpo/Vitner+oN5jh//+xAiIdEPNnv/4mkreagtktuhwyf+eUUets7BeBTHP9BOd5y8JJrW//nE7fqr/1H3+t3X6P9XkKgAIQ15qFCUoZaKBvYBETiRk1EYCLf/zOMQVFSI+qh1aOADr6xWALHP1hS/rv/+Xmg5Y5lMc05KqbSqCSX2nIeHHo/wJEn/VteVIAKJf1O/xUXr//qW/nI/9SP/Evs93+b6qBkJ0PG0s1JZdIM5m+pour/w9xIE74HAvwuKNdjycLv/zOMQfG8vOyAGYUACCjBcCt9ndnCjEgQQliA/ffFxGPCw6Sf/sw9Gxo9HxCPf/t+QEcaC2XHC4+//u+/5CRERGQGE48LF2If//t/+REasTuWcmNQ5TG//////8u1VpRgaCCY0JQKoEJJrRN//zOMQOFIr+tAHZUAAlWJNJUruw7eyl1bHWXf/nPF6Oc6hJLlFzPmFWze5EJrKbWiO/Q5n1NEx+p3//FclNXN/9PIST//6Xlf9v/yF/+xv/kqoV3m1ZXIqDgdQKkJ+HsixspBAjBbiSdKu6nf/zOMQaFUqi1Z9SUAJ+j84QTkL1s9aTd/UcoXckONKEQ78o85yAG+6qeeWt/JZqRAm2zn//yoKfOm/620GBf2zf7eQv/9/pydUzxZjFYKODrsx0CTig9CBVLzAAAU5VkjrLkL5Y/WFNWH4sj//zOMQjFzHqjAGcUABFkmYQxYiLh4AyIgWhVBqGZCoX5E7Oach65U91cSyzo83vP/UTlbr/+7CoXT85v/8oaIpc/I//rfgBBoU4ZV7xmXsgpFFN4chUeY5F9SuWy+UE0+PgYkoeA9QWAFdATf/zOMQlFcly0AGZMAAY0IBexNjCz90k2E993pp72n4su9z/vftPxbZ8nupkrD5eASgkWWef/yOR2af/fv0lNaoKckxBQMwtVsKQrMGSt0uvcumdtTesdSvHt3fLnf3goMJPUsydppUUFLNoVP/zOMQsFGI6xD3aKAASNKVuQNzGe2ZClLmAcFLROpF8ylAAWM//tzCZf6f1US/7v9P+ukW00qEFYI7HAInBCZe6TCqbgvSXGscfWE6ppd9De3hllrdkfGDGdGNs01n6xJdRrd5QFpvfQDg18f/zOMQ5FTI6rF1aOADS3jZ9HASR/qRf7IExlP/O8ef//1I/6v+R/1+yPC5U7OkWkDOgwq80VtK7SqEZKl3MVFWQ/ZS00iKSBnrlxM3gqRzhdDyvW5oZm51QcsrJL91TRCOw1J4/Dod/oIVINf/zOMRDG4smtAGaaADSGQgOc8Yf/Tdn61GheWkq3///5MKC1Mx0+apf///+3qnGUyC6ztZ7///GVS2XZHJZJbLhAOZqCFRUuRxxQOrXaKy4moty1Lb0YmPbQHLXZFN50SSRzsbPLC4WrfqUUv/zOMQzFVnzBl/MOAIm/5h5rdjjv9+iEzh0amzf/5o2PIne7WyIv188jqPfZodyCgmXI1JNbrbxCHvk1lAW3b9dwYzjB0+mbaPZq51/ixX1KEK6P0Eg6hvUpkNKkweAVgsV20dS3EOyC3+pnP/zOMQ8FRma7l9PKAKlmQXKNDvhK8FePd01+6vy0ro+3U0qxQP1IBTlutlm22222211rAAzEwAUJvAYVm9C1dsyw6IDRksIdVRgJFqSiUhhDEwIQojUUkKHDQEVYAsWEeCCPj84E547yyz7g//zOMRGIuKu1l+YWAIV3IjvHrPpIrIn5D+d1DPVu1DPtQmwW1O5dT+pM7PdEZpBF7Pndaa3/ftu/8gjOFfmGfqLx/////9f6PmrNvTXaJ7f9H61AgAQQqqooooAC6iJZgpB0pl4vbVlqg8Pv//zOMQZGymuwZWZSABsXpnciuUNwwDQYmaZNkpMqOTyI+gXVJXGmmxQTAgSdUbMLJ0Q71iTw+kMlIRyatf+ewfWQ8ZXsv7/z/P57sM79tK9wr3h+iUtm73ZriDvllVVbkIVdtOzRySUHacItf/zOMQLFRHy3b/POAIO58Y248jFPChbw3T+rq2bWxCvGraig4l5xznHDZwLHeqikJKjTMInCMLW/qaaQ+rf0X55E0aHU//0HyPGv4seLfqO6jPt+e/k6gUnFU1i+y23CQFQSn3XhDm1Y9NSm//zOMQVFSo62n9YOAI77lTyjWm6xXO1Sb/d1CVsSyAiracY5o+Iw6AN/HRqzjVqcW/+i9HN/0f460l//+UX85H/qRlXd9T+Jf/O+rDdQWZIW5gkWMz6zqtm7lJ/9wfx3/3F7HigLv893DyDFP/zOMQfG/Ly2AGYQACf/Mp7xFJgWb/93vRCS0g6v/93dBQxLVhCFwaz///8JSfpcOILoLx////0e9g0BoYni7R2tiUAKUwdL////+LuYlHvaJTvdG1PAmLGyL///6kAer4259DIK6C3Emjyav/zOMQOFTFC6Z3PGABGKLBi13VyhfPratcS9ydVxPI3BSqQDcFYx08MbNS6azJuS5+WEedSdIgFbhVZ1AjnqkOSZQUeEA9gfd8Xudiy/vFYrnHUpQEBUWIfa2ewkC+DqG2AqhZSFqblDiLhWf/zOMQYFTCO4nx6TADdV55PRd5CSqEwJHioGBkDAzOjzpIGlsaoGdYNDaZ4eIVLHYldSwKva96Rth6x42WU9hFJJ/9C9MrSZpiVBim22222tgEEoEqMmGkRplNlTyFk0AZhJPHimseVEzM/x//zOMQiFMES+l5Jhs56ZJmLYIVnaQzpE1C7TUGEygNBwBmo2dPGiqyz5A/BpIoBQxnqnhqQJERK57phivvsSmWWQaagcbkYYeeTIml3C4cEsUbm7TTqhCpUSJbb+aYFYbWdagCWc2tk5/c5EP/zOMQuFRHusFLSxHybW2HOeTz3NPoDI/s+oMN6jq3WsW1NnQLf//qE9nvUa/Id3p+JO1UAqyW+67XbccNcUH86C28PMMvHLkcz8r9ygUZjSKCkis8I+qkzD5BICAl90MrfR7GcuWoV/8U2Zf/zOMQ4E/LS9l5JhMpcN//5oNvTN66qnX7fwT29Jevg22bdXk0BLTWbb/e34WC9sFqptqMNxYmKGeyyVZ4/krLy/opdRIMhQ7XDaoqG1qokDVLmjA8/dqCIL83sG9Uf+rfZ4MZ2/9vM///y///zOMRHFOLS4l55RPL/0f+4Z/4UZ9Gey3k1AKpioTSNfULYFUuTGX/rKrP5p/JFWjFV03Gn2YhmHk5C0/3J28Pd7ni+UESn/DvbPsQ+7AOFs/balyN0ABH8hPuigbyn8EP/Uc/4YU5MoT+7KP/zOMRSFMmirFTRhJz1KgRlf/9p0QAtYlUirVMzN8OIY9SnTaeLbWUH/uGnIY67WuLIEoV06oGpLREKJC31bMURbZ2b+ltijCsurf/o6jv9v6eX///3Xr//7/qdxFlEWFhE1Qma7ZbbZrrg0P/zOMRdFNtC0ZZ6Cl471HxJxUXX7Rjme/XeXHFGPtanuHrKUBmE3ZSUoJMorl1qKre5miRvr8Spy/6P8JhkPb/9acor6at/c1Yk/fv6iqaGZ6r5LiaEkAocAFpsMqukejdEw9GooAMxkfgeZv/zOMRoFUKG3l9MKAKwYEhwJGbWJWAgjOAwiCz2wiKvlD5JDtHOFsHaUAUgScSsQ48QuJIhajQT0uAqQA3g5wbbUFU0XaI2JWEjEDB3nFt1doLeWoCZj8MA81W3/HoPQoBeCRHmUzJIkTFrf//zOMRyJvMGnl+YaAHzMpjePQ8SiCA6GT0fe3/8cZ8l3uyalm499qad39SP//N0EzhoXGwFlsEAqBU6IiBT/MCpM2eYGREUbjDiBgeCRsRWZIVcuyqUREeBJylHmNwt50GON2IcR8G/YfxLTP/zOMQ1IpmmqAGaeAAVWcaWSrk2Kwghbn5hNyHp092rCqTjVSKdSty3qZhSr5smjY353jWzuoEaL7sV8+TNvPj63bcTN/LBm7y08JdQ4mPiyjolmqnNWBs+KoPtdKKYinOiqiEnJLd/9tvxY//zOMQJFzqq9l/JOAIpgq/xIlnFX7xsSqxANqWxjEhicI4SBNNEZzkecNiSjoSmqQ1YuVGwEgjY4BwlHVNNJf1NmjQ562O/qW+YdHtP/9CpH+r/1M5v+3o/6KUfzXqP/yEAM1x23623YajMaP/zOMQLFmo+zl9YOAJQjZ6nIr9dF13sdwDDcQX04N3eD29w5nQbEqg9IiKSAKRld49Uib+PDZx0SWsdkken8atqw8/+b8eeOtT//jz/0f+pHDv4i5Ely7vLP9lSGwOMcYHoBEAd30GZyCaJfv/zOMQQGLG21AGPQABvmO+Yu8FgNA8FUFv8TiiWOJCJf/DgPDhQw2Bpsf/2iQmRts3/+KJmKeOgpIa///93p3c8uPC50S/pSIAYGOBF4yKFv8TgNZ8+GQwRlZ23/5z/qgAIpCFelYwTSIPEqf/zOMQMF2Kqvj/YOAAXoWmL9RqPy2LL5VxbzlOta/uW+//+SN1HQQJJX+eRb+KiLTjj55QfJP/oIwDzeoZL/92HaiSExxQ6v/85QNBcSOVja/8584IyP/9v3Lf/PdyqAAiTas8rcVC50fxtxf/zOMQNGGsCyl9ZUAIsfiO2/ys3W1hN6W83+8/5zmWWTDp9UAaRfZM1TRNzUOU0DQsuKomEpKFyTmAZBNvXWRhOc3UKxfv6os8oJQ7///jETW//91xQT9P+31Klv//+S+5NBt7Jh6ayhxjcDP/zOMQKF9sSnAGcOABwsZmEgoqKHlesPqgYMSa7OYQi4XGpo2JKGiDIJwlZWZygPDE/8xgnHCD//J4loQqb/8bk3G58/O//57mjdzz7W/O//4+efmKe6zPb9///zJmYYxDDCjfL9GRmSkRrWf/zOMQJFvLmvAGaOADqRqgKMqjKio8Cxq0fNeNjlLSjR8EmIuCCGwLo85AINxeWdzgIv5gzXKDNMoM9yp3V4s+UN9RIT0xL/yHzS/qnih/VvKN6lvkPq3rn/KP5VzN+SgwDjjnaAAGQQIcIIP/zOMQMFTo+uR/TUADqNi7UQ4TYSSBiiqtE49bdAQIjHUcWCY5j1JvzRDBfD4/QlV/8XDv7zndjlOOFYKL//og+BUNWf/+cMgXx636f5QL3/o/1u/w1ACU+K1aoqQLTUA64p6Na5Wh37PNfX//zOMQWFVI+sZ1aaAIPrc19633vmJdbmaaTKWjr0i6PZF0tKdLrfx3EL5k9qjJLUaCfh5N2vqMiWR7ax6nv//ckj///lRLf9H+t3+QVBGY1G02AxGQyGQzGotI1yetAQJPRaHWjEupbUYULff/zOMQfHOsC6l+PUAA0xgvBoPyIRZPswCAqEIaHITt9x+LBYndKF/xADQwYCIYqciX/jwRBpIYyUdXT/zCQgJDHMMLs60//8xXMZ0MMsfeu0///97qTn75r16k/Jod/0/9aClttAcgKxRpeS//zOMQKFBr+1B/YKABNOxhybp4Bl13K1ezx/LdXL8s/mVlYJOiG20ejl/V+iGY32Mk0pQGMbvUtCtsUpWUBRY3ov1K3xoGf///FX///ygxuv//itSadVTZgWwFs1JqmuKRkj0x97oJkNS3Kcf/zOMQYFRpKxF9ZOAL92v/f4X8d2eiATGKslH0vvVjkCouYeVjjkPHTNP6g9/dDlO2kTVNOExQv///ikOb///EZ//Y//39ynrJqOcvAIWH2nAQgnpc5mJGKiCVxmgG0MtMhvCJVDkPQuWybN//zOMQiHGsGmAGbiAAihOIABwRoRNZ1qSFYuQZg0E6e3xzCIEwRQ0R/+GJx3poL1Jf/LiKaBcNCB6X//Fzlc0Tegydv1//9N5TImTjO2r////9BB0GJyqOT///ghRiZnZnrhwJRS017aGHm1f/zOMQPFrL+yAGZaAD+Zxmz+cjHICBVrMg5xskGooJLRLFnDhrRQW6jropJrWttWTC1JmjMySsvHqtaO9f/2yY9Xy7r+Uv9byt+351//Ov/9Fv/5k//8x+tIY9rIQTCC0RAAgU01CVQR2C3Zv/zOMQTFVNCsFXaOACtmm7arSq+4S9bOr1TtrFC5rThGRF/48v9AEkSLeg8b/6H+hzfmhUMfNz2//+VLfmiSEz/zePf//9HFR3/////xMWVAIK9ZpKpBeaYwdBOV+Wc5xbdq7y12338pmd/HP/zOMQcFNNCuZ9YOAIx7v2OodB6MKmf+PEv6AuGRYI10mqErmt/nfVv46JP+b////x4l/3qIpZ/09H+w9Grf/////HjVXBSK1XK3Y7JWrE0hAGChhC6HI5NUSDp1mT6W4jK9MZxsJB5EuE1DP/zOMQnHvLnDl+POAIyNCokiSaJT73BMHBMSweShpppNr3ExVECMkNhJHULq9/cqXHCIlmXdDv7cyOCwbkShB9+h3/bbdkJFhuqD47+c///8IhqJI8OiKSLEShotLs3//5BASKY8n/+2scEAP/zOMQKFQEO/v/JKABQcDJCSugu0shBg2TKrMR6Vx/vBLoIhB0qpdWkDxno6DxodbL1QPQmDSzAlInYNB0sgklQUFAaCoj7GqDxt5FaO3+iz2f2UVLrmQBpH7bGWAZ8FJhZF+XjkKtLidzCz//zOMQVFPD+0bzKRjy0KH0n695FKMv5SBMyui93Ndl7IK9TaN2qJDgECkVa5IVK6goOJKAzv4i1uSWSeZPSsqoXMyJE7s1/sSRLNk0EB3W/3/a6gQSCliyHCazNCDIGEEYOgrWHHId7das2/v/zOMQgFEl+0l7BkDBAs+0qt86aYbM/ojlnvbPju6MhI0ia4oyk21So9uBlOoMv4C8L9ync2mfRLHqPH9X0KgBkfuaKE9QJxARklfrriOKm9t7oAU4patAccsFBc67vbGcr5DA87jjr4ogyNP/zOMQtFPIStZrSypxbplh0bQQCddqo7FBHGLW/akYJl8zf0BfnaM///R/4z9X/wB/7f7YB4uazJJ10SAFh9kkLWJtWerYysUVdHWZVHsl8taRnbUQCwTD55No+1HTkiBBn6/1Bl7TU7Rqagv/zOMQ4FLJK1b56xJ6gy1tf5vr/p+uv//6t/M3+3Fu2867M/+e7+EoJK4iZdDOjqtR4MZH0kY+jXC4cgmGFKvgaZiVj/iUUzxv44ZbDQeB+H7MHJjVxx1xkh7V2NhoFhUV//yTfiXK+ItB4yv/zOMREFOkOpP1aQAL+HYiO8NdR6Gv/W7/iX+p1AQ09w4O+948EMGETUeAKIDeVYoJHl6taUYh+JWbzkTsjFZMmBQeLi1xQUMYaC8wjFiE7T7CywmIlqO34nJDRXHLi4o5R0mceQ0oGMYSULf/zOMRPHZrGyZWYOAD9txpoabMMJc7Rvt/coY1qnLujNfv+//oYPkig0ADhVqGovnv/V/1KAZ4TKqdibODVSXLkvG/KqLk1IMnY7OV47EcY7nHsv//1lToCtsA3oHRXzh1sO91FOUO7/RQ8K//zOMQ3FWGCyl/YKABJRJ6mDwL/lHArRM/d6cWw9drd5L1n601/b672vSFaACqMkS7LW5GC+4WrQPWzF4AheOsM8aG1Zw5Ry6z/6/HPYRFSM0kKSL0EwyCYkoao+NRfKA6fx3xGf/QTlvI9VP/zOMRAFWGCvn9ZOACP+pZclv8rks6t2t3lfsrK0fO+t3k6OFNYzqSDXZWMtC4qU0wiHWzw2hrIzDwEMui+s60K0TAJgZmaEyTaBQCw8vBf8ixD0HGibIogAxBxx9ilUqltZBo5xKh4BKY5iv/zOMRJJqPOjAGcmACj09O5JlcZQL4B9Cf9vfsfKiA6gywTp5L/s35ACmRUixEGPlw1//3v24gONNRDzYvENE7lVSZnV///3/Jgpk6V0FmRBCXXSMzAZOv//////NE6Dg3PIhQk+FBAWMhlTP/zOMQNGJseuP3ZUADW4zebIiA7zFrXN8x0+kDWsv/eOhHASJkmBCTTf+Mg3IiZ9xgHADX51CIA4Qpv6uPxWJDWMGCCLGrfoT9Esoq///UkO/r/qdzv/6F/5xf/Fxv/v+Rk1RTihFHUoIaYVf/zOMQJF2I6wb1ZUAKQmLcdkjNM7MKg3Cjl9beONePWs//+bxKjRrqFEYMnIkX1OGQHh+60IhZEEACO9TnHwWU9ziEoeNRVdiEiG4UJv+TfTGT//+g/b+a/9Rr/3/7P9fk1PFiDTBg4D5MHBf/zOMQKFwmGlAGbaAAzDmKzlqCPQkMNMgVdsBxt/ZbLYHJ6ZeE6IZRLhgahsiSEFySTNUCiovoTw7C3RL2uvOtWWUdaP/dZl9Zr/0Mz/+UeRUMlnpU/+s4mf0Fcrq/1qgT6tEBL4GcBL5ZxMP/zOMQMFnGu3AGPKABJK1PWotNushwUYWKHeKBwUkMAIk4wHkId4spg8bXq5GnZFKUvyEY7zo9DGXbzuQmjHLKoiDWzL4IF6gqCsTA01+vKBjnOEgarWyj//joKAqikVDYDDFPbEwTgwJAFFv/zOMQRGWMCtN/ZUAC1btQEnzFbNa3jrPWu6//qGOY6sBofHG7/o+3cwTjjsfGOPREk306EQLpKyOoqm/6F0zRLGrHtb/1odGYIRMcyp/83Q0JhMd39dWndB8NW///oQt6qBTrjc099uYDAdP/zOMQKFRpO4l9PUAIK016wdbyzHoq1t3F+s+t5/jHsVbVgrjTuciLuRE2/lBOo8LklywnP/yIBp+oXpc6/4+m4LpLN3/9PEkcb//msdYfklfoENYe/8tUwdmXYYWusFOQqB41v1JPI18JyVv/zOMQUGLsOsAGbaADVykYfDc1QY6xJiYEu3SNjRgbY1EiML/5CNA3DYYD/+TzYdwyH//ymdNzU2Yn///lNM0HoeTL6kP///y+gfpzUl3Qo/////pGlJqzc0jxEGqCpj1EFnWZqKMklr7Omm//zOMQQFKnyxBPZKAB4zucvmbs7dzl/2prPK5iEQIKqUoso0fQ6RI1QkdSlssz8yCRYmCspS6ZjLNUoqLPq9S3/QNL/Vunjn6vE3+r/k/9VHXXIEAiidLyYMKUJm3bxSpukiQyjUuwi2W7ON//zOMQcFVI+uD9aOAA/u/3+Vo0Jb3Ks7zlbfEwaJnA+5wnDHm6gaGTPHW8l2KBYv/Uj87Aat//9A9vR5zfx0M/8j7Ot/+bVADt2121v13H4+H4uAABnN4QF4N7YmCEl5dHucQMIzTsSR9mUOf/zOMQlHoLm6l+PaAKYujnHoTBKRxj0FcuJjUPp4rKJNMi+UDhqB8GWy3Nmd19bJDSUaKKJIlFX6lsNQy+tjhLP/k2mHKS9VZi3/8cJupz04PFKqZH62qf//6X0Pna2+l8xAgm+2wEA3sEbEv/zOMQKF1oa0MuYOACEKxjWT9xJjDdHJrWJRYgSnGhjC0mOHFiZ55NhoOljyTB3PeUiKTIHmDjqTfxBcfIRfis26faQt5qfP/RCB6+su/zG9GP7lsg63FX/7z5C+dTXRUoQlJ1tuSSUF0mAyP/zOMQLFQmW6b/MOAIuXFub1WpZf5+tZe/vr21YEBc1jBeGAyTNLGktHckpH5hFj/ZR01f9XNIpzqv/uio5w6Crv1Hhp6ijKkgKdO/s7WXkvQdRxZWLVRD425vbJJQ4Ahj7QaUQzMLMeWkWKv/zOMQVE3lC3b9PQAK2v+H7ynpjNNGrURWZKtH+Vknbl4BsQI4cY6UAGLKKND1a/ZtakFuenuswVkf/DXW75b+/X/9+vyA4MOAVQbo9mAEZqGUPMRiQKBgMYAGdBhwNA8V7P5BYAaAYGZibl//zOMQmHgMmoAGbgAAQB+K1IAmTiRwvS2ampHh64rR6OmtJnFkEwOcTpML1a3ZBNx2Fci5OoGW/pvfoTdZPpt/9f5o5okt3///06fKZXUZqWiWzD/////qTrN/qNHWeANOSGJhNIgoGlUX59f/zOMQNFCmWwF/ZQAB9Hn7jjaRPKnvb5nqrnz86v4dth/dkNcr22xTKNCvS18Cx3DX8ySc2zN/1JH8wOO//2N/6Kn/8ke7fEUPfp1htnX9PRQC2nJunXHAX9Bg0C4R1m7NaLB73OPAzAntPav/zOMQbFSmi1b9PaAL7YWaM9ZLljkqTC10kXdGdIKDXMTpULIWKZuyDmJLOF1FJbv/o/Mn/qf6Z6a/8Pf5WV/v4/2/ZqdyCC+HvsgMtQcrKJkBoGZQMbTSpl4BhgkRNTdSsRYpYU/FmIQy/I//zOMQlHQJylMucOABwMJgFikRQqJRYTiWGREExo3FRMXA9FADTB9oPTzDJ5p5U8VPv/JmMYhlC6L7+QV3U8mdNO//zLWZ7W3pO//8wxT3UmJc8nntf/DBxBM+YH6sgPAXYLcFpqOnlE9c4cf/zOMQQGJJ25AGPKADOlonyOExc5qO5TuJmcOnFCWF50FBpSNapb7HPR2SqqynY+ICj6ylRFLs/O7XZ6SurM516pU7PD5g4DkIMqmUOioiwlbX/FEEw+lxx4Gi4SsHaqgWrNrbrbJGxpTPyq//zOMQMFVl/El/MMAKu6v575YVN1ilBa3hufWUD9PSljgFeub2/2uaaizoyVeLrP7fKo7arfr/GfOcucnO3p/M4qHX5LtTJOe1Jjsp06HsFalu/7aldtR5I7ra8MLEER/y4H6ad2GrlCdOozP/zOMQVFMGKzRrBhlBqGO3SeiQcHkJrLcypPhUy/YV1sKI86S1pHm16jSNS9T/jWMeaCg2etqSLgsedJcs+ssS3SqFu/Z21unerkgSFmVYB1YSeaxmjhzJfASoipfBnqsYsgOAEG2C9oFzzGP/zOMQhFNkSpADeUAjjBgorSMDwx3szbuOg7D9kdvosXvmuoosu4+LAMPrufbfhgoc4r2q0oTxPE5/frP9X/UoKEQkgkiZmgVgTHbxY3EaAaVvSxfjjF2ERk7E6nJId+eSMUqw0gHofbrfmAf/zOMQsFMmirNTSSnRFmitSB8CCXmsowW+lVcVbqgkb/fzHYw2717urwUFlaep76k+a2fXVAAqccu31tlGQd9hHEFTtGfmIqWiHvPLlGCwolpFylXLQz9/OUpMbCNDZIkD/4sOTWsDhP/B1m//zOMQ3FLI64l56BL5SsCMqtYgmGf9TP1Lo9//+dv6f5RNP97qvkv+5AU0st/////EgYw5ZNEH9aD0sKSrCcBFmiKaYh0UNnpE+yuYG4xQneC4AB30TQGLBDB+NPggTrDRznawscWfP/azagf/zOMRDFIkS9l5DBg68EC4RP/7BxPxruk4fnAGqD/yN5xEgaMASkzA0WnrN3IQ3alJhKoKgqgVU5zE6mqum3dFwpttXGo+8a9N5JWvWFkPR9rAAsvq2c7P//Rn8AH/0RGf5DqbDf/aaZNV/Ef/zOMRPFKmWrCrKRHy7DSttZa/H9AsgIVMReFWCSvJBM8zKcBRr1tArZTVntg/8iQpFVrfMGHzbFKE8pzlBP9dcV6J/o/QoZHN//y5zenb9ZuG9H/36YUAxW4O955lSmodaKPBBl6kUkEHG/P/zOMRbFDqiqBTRhHApBQ5si04diN6FyqU2bL9X7tXufK921LsfRx5mQFXu6kVsSNUVzYAkegeO6gMLW/1Ff/9B7eIuDRb+VdyX4a39PDQdvqf6+rUBXwIMJKLDSjzzwC88tMAi2Bn8ZuzzWv/zOMRpFPmWob9YKACBEUwMwhNS07/y+LKYE5RIGRccHYNw2Fw+fcRgLYJgJmLMOUPo1peJmorEvHmLAnj1YYf8JAOQ0SLiAcsujDifFhLfyXL5uXC40fB4l4qHqWF7/mBoX03QQZAcxcTOGP/zOMR0JxMmrZWYaAATTEuv//m6abJplxBkyTI7mZkiTTdN1q//763QV/dI2RMU1WdSjZlH1QrvylchBYw+lIPdEkt6Wooc2tmy3Odxut1nbNV5Odgqmk0KCMxQt9BEzDTVUPVQlZU1mX+Ba//zOMQ2FNlWtBXZQADm2Kb/+5XluFrKcInxJlYl/w0e7es5d+3ht3V9HSoEBpQUzksKgRB8xscmK0rKwaCpJUrJKaeyvGV00Rh7W6SM6z7h0nX753v5+znTh1EmRxzi5OtuKRKppZxdZ1kQgv/zOMRBFQkSrP1aYAIbN87kvdkVf8l/lZb9btf/+t/J1QAEC5XJJJWJRIHQwIAkEZhALCjZpAgIwUhZoArF71LX5h15lykQwkURLgOwd4E3Iwwg9xJh2gjQmQXgRbCMidDUS4BbiwC0jatM4//zOMRLJxMmvl+ZaAKo2N2wuQEgCECWg70e38LMoD3My8OScPrKNX8PBHEwLhiPMOPS//7F83UxQPlw0U1Tzjo//92PsblNBNnQKH////5sSg8KB9jcpsbsm5Z///oVawtYwBiBrwTdlUDl/f/zOMQNGCGG2AGYMAB84w/3y+er1ZeWkEOm19QIiFnj19OEEVCJQPaDhdRPQtijU9wn2xmfe3+m1irivna+3++v31eA+QOiUJi+W0nAcDiQTa+p1X1EjQDFCZoDo1a/8VURtf/yYGHmLpxAg//zOMQLF7I+zF/YUACqovq/ztTT5U9mf1uWflcy/Hmrv9m1NnOiznVjjlOGRORHkJKij4fEI9bQ42QCccccdWjmmjVTTlHoCo7od+jnVwHTWVf/WhEF23//kQbf9P+v/k1Ca7JEQDAiTjghAv/zOMQLF/o6tF9aaAIFV1cLDyhmL6wqhjMOawr/ql3q1rL+5GRLPrMUUk7P0snDyNzxdQRLqycb916hNhOuzI1PJwwSVI6ZB2EUj+p/o1BtDr//6ZUYsvU/6+TyZ/r/7f8qAEbtsstgsFotFv/zOMQKFtpnBl+MOAKLRYACajBK44vEVWfiIJ52aytqIVDUiWOIXjU5jKKXUCzlvzz1HyciBn+2ee5RrDP+x7j43dauVKf/eo+ez7VEj1//Pfzz1e4pfypD//73ZLJ1E1CoIeHF4Y5QOOduNf/zOMQNFULWtDvZUAA2+L8gYrT9ZY4dq6q85v/7+QvBRU041mVbd6CsIUWTUehxCVN6bjwLR331ZOxCFU3//Q44dJf//NGB39P6sNf//of//80m/5OAKaiEEz92yhwxZG52nWpV9AorUg+v3P/zOMQXFVMaoFlaUAD7Q5UOOWvr6yzJACrMppATHF6t9hKJxPkLIREsVvXQShO+j+/MKDUb/0d/4if//xVb//0P//+hN//9C///yFUQ4f22g6hQZCb+zs+NkakrXnikOQA+awkLptWmWSuQC//zOMQgHPsmnMubUAAiwQEoNgSBoQjYnNEKPzhoF0IRh+zCsdY9sShYJxUGnKF6/H5QWDyIadCb/kiGFRuSLzv/8+aLee8o/o///kZOTnuik56npO+n0//80956GSTmGEhHxUIBlTQCzjKcpf/zOMQLFfk20AGZQAAKUvu5kvmYpDl2mldHDkHHEqI4bcyREFROwXczOHbUTdkwykw8tUtLDUKdNcZdTeNYLrOGHStIkpmBdzZTW+t7VH/V3VnNFyF6u49t0Ur9+/MYccE5ZCxVhjxU9vGUSv/zOMQSFQLO0F/YOAC7hjjll2t+W/3jzxFEYvVlNaaznP8ZQ4kSmnHPNbnHAcX+uhxxfzgib/b5pw8Dsib//oPAeRb+3+Lf//q3//x3/hgBopJigUAmWmJjJ4J9sAVG0mCWb0OUt5jZ5lV5+v/zOMQdFMI+tF1aOALfP/yoksrusxrnMrIciEjVe1UB8/8Ihd81upHzQqCK/6ePOPgEsn/ob0B8f/Vv5Ql/yX+v/hw7tMeAnQuAEIcsSikkk0JWxUQjFUcjvKUPJL2Hu0AsDOmwNySHkBRZNf/zOMQpHyvOsAGaiAAcMXMhlai78nC4Xioo0LxTLSf5Ey4ZlRBYkbSkpX9aTLTTMVoorLdf/HPPut345FjD//5m6RcTRf50/H4rVof//+onD7X+9HIGhT+p///9k///5KoMn3a462FIIy7cnv/zOMQLFPtC4P/PUALC3LiLTdNYzXK9G/3bX6F6POzjjjjvjEk/UegcJjvoFEab/aad1NNf+RA0mtzqEZv//0O/OEr/lmzv/5Qd+pCaKhzfr////yEvGvnH7gNBnjAwx/kbnweaPU01W7Z73v/zOMQWFVNCtD9ZOADq+0rD////1OzDCN1X/Kkf5QEjDU9giI/+pH0KF/4gEt/XLP//8at/EYt/Q9831/0F34+YE5Cd8r/2t+r/xYUVOpVhpmhO0YwcJi1jPV53Prf85bZ0NESsfCgjUvXEYP/zOMQfG2MmtAGZaAB4Rkf+J+PMYcYc3R/+JmS7kmbof/5LpIEuOweA5Ev//mjOSBoSiKZv///+8lzA0I4VASgJAORgnH////5dJclDpuPAzN0DM3Yvm6H//+J1dp3FYVUxYw0qbhTCXeyo4//zOMQQF1J25AGYKAAyOezv9FhYVKxrzCrB0Ud7XjhJotQxOWhkeMOj1tSxpjWDwdLJyaERe1yrI+f9l/RHM7h4NAqlES/t/f/iohOho0Eg0P6deu4bUr//+lUEux2WX90kaYbRKEIc4UGXT//zOMQRFIC+7n/PMACZp41q5vF34+IUb2xcGXXrQ7aXG531iyXFBO46IT0VsGCUUCxGBSQpiGmp2W7UJfebHoPvNtq0abCX1/bLS6sYFQCq3rZGoEADzsDpbC3jKora+E7vvESd3KqMqWllP//zOMQeFLESxbrBhnTOP3Ut0hIJjuoDTuRt3zJTjYmDjwFLSURZ2Iipb8qNBXyuVDTREHSu6Vd/tqkqwVcdiVy+SQDmjpJq2nRNGPZhm1dYV7aWXU6x41VjU5mraZJB2addM9DdGbjsc+4iJv/zOMQqFMl+wb7CxpDE6PP1aBQwzXJughH5iopzx+ZHnnvMxAcGWYY/y794E9/+J+p3W//Jdao1hIWhE43S4denEDOhUXt2UI7RuyvHvVU8KAaa4/uc4qBncwrMig4rx/znUl+7/iyTzT45o//zOMQ1FUKKqFrSypzDH5qtTsZHmGsMf+YG+Use3/v+Jf41v///9Rby3t//kwbbrJsQGckcXFH6Du1FuUlMmDuwND2HG+VlWbs5SyEfy/10KuvQZbHa582VTtftbrAWe5vEII941OqaxNkqNf/zOMQ/FTKCrFzTDn45v5Ubf5v//5v+v/9P/5VnK+3/U7huAbSUbdb/DYIkcgQVXuZPthqEWkCBEgICcnRoxcX4SXnRC0D1VrnIMR765LPutERCDK93d3COBd7/IMLDwxMofKOg5EDlH+JPfv/zOMRJFQlS1bx6UDJ+D/KO4f2/hjrfyFWRG7oBlU9jAADhn2oZW+sM969TJYzS8NBM60RZ8xpVROWNM7UDbZTmjUk9STY8OtPpxQ/2qQ3by/QjzSOltDv8f9OhfJ0eQ9lFeyRqzPU7qqUAM//zOMRTFCIGsADKzqRJlWrecbcCs4U3BK9FVrkRxlZql/xqP3iaWwuNs/RNd2zKmclsPXz2Y6b8J5OLa9yj6kehfq3G7J9x0M9fbo/Rub0I+G699Mt5DztFe3q2dXrqABUcj1uluvC6Sr4pUf/zOMRhFQG2yv7DDlwRKyYFhWr8Pb5qtLrWN+VZZf2Nd124QAIFGIQYzFM4CQ7nbgRtAJ9BXCtwFv4UTXnoilnT34dlvIyrujqDvU+yJfb1PplqlQAP1NPP//vPCDllQhOrpbxuksPhp+y1Cf/zOMRsFNFGul9ZEAAUODDxEMSB+3BisFs6QtUCYMtyeU1rLoKQQkS8FzSPJoMiboG5PBQhLLnhADa6DHk5ENyRE3JyYzM4YShdTILdzJIxH4Nw2Mqo1DHV63T6KZOHCUlJVFKmHK/3v9xPzf/zOMR3JzMmuZWZaACWYOovDAIqeTT9Wos9TN9D8yLEbIqHuWI1oF83n1VaC/O//BT/qQUpKqjrjJgagLCFCjOx8j27IC6hsW0aNeWK8crb+c54VRGJn+iX7yIQRCLLehwX5L82GJn++TboK//zOMQ5FNI62j/PUAIGRN/Uz6msDo9N//5ouOf8p/kRD/r/7P9fhxUAByhbPJEhkhnqImojU604/VBSsOo8IanK058mZlCrveYdryk6MDfQ0WPIIrfYfiEItNM1QMUDcOYS+yk1GwAelE87Gf/zOMREHGrOtj1ZaAKasiYjlKJFBSTSPUkw2Q3g4Hb5NEp6VK4QA3//+w4W/pf5weX//1t/pf5k//DSOUnT1NWMWQZpmobVlcJn2cA5PzL8HLXXWtnUJiC1hV1Mmq6KgVATcSsLejV/CrqGDP/zOMQxIJvOtAGaaACIHM//HkJgdHgJ+JX//kiJmfC1ksJgPb//8cixyE8c5NHOYDL////HYPAmFElyiPc3HuXiUL3////5KF8gEmUyTPlw+XDxKHSXJ///////lMuVMMwdPMpM1gAukJgg0f/zOMQNF1IyyAGZOACzepbsSYq7ro3v1wFxMqppuSEdwhiq8RVeNQeuJJjROzWZ6oPILjehf5eijUdLJ8j+foccVNqavHv9fsk6hx83X8vt05YidEp08Pndm1OvWtUBFzaa65GkDuLgAehWqv/zOMQOGHLOzj/PUAJcWyyJJuy+0Jly9vT2x9/8ZAeOdTWQ5TDjtdChcfESCMTdm1ZXiQCo55OSo5z1JEHaIJBM+b/6yEJAhjnVf9NSEQBMdVv8/NEkSH//bkKf//If+Gk1/qsq61GE0BFaQP/zOMQLGAseuZ9aOAJxQCFAdazT6iNu1yvqtIr+FjndZ2+2ZzmoSMuPE1KvOrFQlAPYZB8NhepUib/EYXcat86ccscGz87/2PHAmMPqc+7zKdTW//8qJP//1N//+a03//jzKhP9s2kD6V+Dbf/zOMQJF3o2xMuYOABAzz1iXyt34efBE5Tjv2OOTBZBo1Ijo2OE6nK4tFTiWDRcNhH2WNxuRGhQdMHVGp/z3nFpQeSWT+p8ctW8uOp/3yf0ONI///HPy6VOrf/1WFNbnZHRC7ttUAgwaNqgLv/zOMQKFHo6zD/ZKAD64HQjtHB7dYZs0tnPH9Vf3zv6/RSUoanSZ+g82rFMYW1KKlMY4KxYj1bqhVEQBH6k6FbtQwBNy/69Atu3G+2oiIP/qf/kv9QGVWokpBhYOYrHCMocgmDFKZh26Vh0zf/zOMQXFSI+sP1bOAKcsqbdjcxb7TWscctMJNjjDmv87lBcqOOtSC03RdRSLeKnVvUUi2pQLDPfoX9uIrd//53//1I/8j/rd/kOqjgskOWDWaoUBjtFc1gMVc8jcHkBIWCimK1Zd6YyXCp9Bf/zOMQhHUPOnAGbiACfDxBc4VDI6gnZkgFeQBbq9/GYIIKMI8Iv+13zxoYChBPhv/78sGpwhhKn///63RIOkkya//9/+fJxIzSUo0W7N////+qtN2pnnQQWmd//////8+u/lrH/6VI0FZun/f/zOMQLFKHuwAvYOALYjJMuHdyfCty1hXyyq5dxxxAiIjzTTjjm0OOfHBOWmsxyGmi3pdBwkvT/6FgfEn/Uz3VB1X7f+pijV3bpDL/5oGvdwl/ioboWg5NKWa4KKn7UqVYoNkxaXyRnU1nWYf/zOMQXE8o6vR7CBHTThUEygbdeSCo2riTZlnWNIUCMJ6eK/KgZ//6Fab18T8rOEf/9/N/3/qJr9T14jUWlnw5Lfr2lidUEpyV1RxwNGPllMxvUbYLcaWypXt7G9+8f7Wy5+HdayBQ2PH1WEf/zOMQmFTEetR9ZWAJPur3uk7cwIhPXnc7cUh5W+L+Cou/NXTslEv9Q43E3na3cj+72xK5T4a//iaWWdQIJt/sDcIEvD2pAVMNxlQQwy9ioSYRBWdn4jdZxDoiBYLCHC4EgYC8NhOIJ4FgXIf/zOMQwHlq2rMuaUAB+Si2KRoOnyAeMNyQQQ1H5JF91PceGMKo/cfDjFXNQln/P6kjehLnup7+PKionrQV//t8po+Oe+j0Lft9/nySfLPxx9Fun/1/9avpwmlC8Jq5i+iYSEAGJNuxlyXOf3P/zOMQVFPqGsD3aUAJrX72NamazTU09vmt3S5BNZyE1lN+iMej9dRUOOfPKsEoQpv6G0GxyFCZE/5N/kj///X/Iv8oQt//8m9/v/ycBuRS//WaQKUAh8Whl7r09U7d12z+57fK0/zDVv99U1P/zOMQgFPI+zb9YUAKiujztedF4mkizlQqPQxFh2dSEmIRFAQub9HqZRqlS38qn9BaT////T/Qme38Te7qf/nepcf8/n8Gg1Gw2HokHo9FVQvjEonqy0TI2Dy/a+V3qR0sTi0Qp5OYzGOaPfv/zOMQrH4MHKl+MUALmGKeKwzUXj78nRjD3EgeEpGJgn/3M3MMFofkgzCYJYs/9XPQwk2I3ZFJTydv//7Mt86YPRWHpCxw+//48sfOY9XYxnUjJDUPIiEOCMGTX/mv+Iw4vPft9t9ZRg2gBUP/zOMQMFMjXAl/MMACgSsQhKMa1O7u/V2ctFNu/wY02nfc+Vj1/88JZNYaDQdNSrXjjQ8raGWyKg4RYaJDA9eTBp84YDeGS4s2wa79VhDub/t9SjioBmVWhl+1khYhirDSGDiiYMik7nGmhnv/zOMQXFPB+6n55jABtmSaCSTAqcGhgFQ2qRLBoAgMadBY8sBSQUAwUYIoNXqnlAspfEvSBZ5x4nKmXz8bWLsYeQeZ2f20VabJqACTlX8jpM/ik1JYIaloZmNNJiA0eLgSgiZ8clEgNdAVEA//zOMQiFPFCsbDSRkgRGBRHUHCs4t5cm2ZN64PNt26SHC7qJazPH0lga/KnStGvTYeEuoOwVv+5R5/rV6n+QgCVJJZJJJJA2ILyV0mpKqEN2WCxWVXuEhTAXlH+tYatpWH163eoKEJk3TuIFv/zOMQtFRkO3l7DBjqoejeOpJU8w6Dxl7KHBZ3FpFoQOMX3GUAm7h7rPf1kKkUWSgf/w/11ATl03232/3FQnSDHNDyuE+fNbOncvWU2znSQzN4zEUejw0+vh0du0G3EmyjWDATcKW99DlOAgP/zOMQ3FToS9l5iBM63l6ieqVKX3/0mmFe/Bug0DRKp9xBPslfZu7K8DSYC+SW3+7a4XBJhKJuu6kRw0vzl9nWWJo5YFjQswxyLJJu8mu9TbdkvMmq5egefIoeRwGBeMH/qNApr/N5evmfRv//zOMRBFMI+0b7BipbVtW6G4j5eorkfdI7p7qfb+igAIpxSRySQRcMmspKPLCRZ9fQYtEkTceOfABPKwAA536BwUK5FO+Ql0I1QHA6EU8nrJnGBwU/3+jCYfF5T+GBJg/zh/+QE+s+CA4MKCP/zOMRNFImm0b7Aylqf+rUcD9UXdN4y08KFjgJIrFYLDzPYFQHQNUJysirOl2cj1e1qYZz+nUtDGy7B5ZSke7A/tINER3T9KFIUeNFf8W1Cwb/OxL7fZ+7qNzsQjBK+R9wiQWeSHAJmUmCoKf/zOMRZFLl+rDTKSnDTqMFvKAlW70z4Mqb1+YlGu2ssqWAavNV8vyqhRAqP0IlazcmkI+Ih15xF44uimnOJI53b9UZHkP+qf4rP+ynf+dkffK1MsWdqf/sj0AIAnPEUYbDBmVrmSAGaAFxhwP/zOMRlFQGmlFVZUABiDxg4BIsg4WmBwODASzVXTHWGtQRwCumR5Fh2kmTJMlINVFw0kIT5FiiJ9MmGQL5qOg2RPMWKnJwnVIFJRkPktGvMSqo2ZZfPJ6S0lIvWtsrsmbsm5quTJhvfSf/t6P/zOMRwJAsubAOcgAKpR9ar6191X/bb9SOdQdSdXNtbXo3btvrSZvskbf//yVXCDDDP7f4AwhC/oVmH0xF4N9LPTALeiQoAFfl4WT3l/rtgAyFSJmeRXucFmaxMDgQ8sDG0nU2qKOoZxJE04P/zOMQ+JIpmsFWZeAA+C8LSOhrtuiuMlILO3GQzs7A9nb5WvDdmDXPd7eRtUc87zm/z40G/rn4f+8OPu+6989zWuJv3v//vfWb6xT/+3+N/E3///xv2m+6sPaCtiO5657QqDTdm302lEJD0gP/zOMQKF3qG1R/PUAIi7MTXqCtfbHXLj8qeLV7vMzlY0lU06UPLGkSto6GoaSOYcTFGIgZJfOLkIDohnzapKHHDc001HGbG+6DIjbncp//zsh/xl/QZCub//1ITPZ1u/yEb5InImJOYcCMSE//zOMQLF8KKnF9bUAJGGgNfxQnu8vBd0giajlzCLVKjo6uVrVi5FvKEyuPTjEJXFVXNmKyCUOlzSGlx8Eobzs1UFUbN061T7f6E3+MS3//zm/kV/yICs///kI19fkv8t5Mn4ZZMRfkkL4zUhf/zOMQLFeFe2AGPQAAcuAxtfXbWy/l7Bah3+74uLlC0f++Lvh0c4sd/+77vfDLZX//vadoSEgVBH5RwIOBUqEhKe+ozPlz6hYOiJhZv+4p5oIhpblin///BpQCEMw5eKO4fcQBlO8AzCTKDLv/zOMQSGZMesZ3ZUAAKKLql/GvRq3ye1ay5llW/eOPBAhOJnzaGms2/FUQwIRNKHHSE3+wuC0dkBx19jypE4lDcPH//8fABjH3/9DiID5v//QQQX///yhK3//Rxqd//4vOVAGwamtSoncAPpv/zOMQKF+MesZ1aUALlYCg673lmL0bbvnveVrlSOPJBFbD/5/jEFLc7r5rEUPRaBSZC6MJmNIk/QKwncfGIe1zhkecPVF4NQUnf/Vc0JJL//5UTP//nBff//KH///Ut//8hZTdDeM5hk4OgjP/zOMQJF4qujAGcUABePDNBfMjjUFCEeAygLfp7qjcVwnCqM4mhYY8LkTVBIQZcSzj3JkeLRhOXx7tOejH/Eod9Dr55nZRZ/fPtSfyj//7fa7eVb1///9kJvkLeUZf1TGY0KgAKkIKaqqoIAP/zOMQJF1KuyZWPOAABQSwGN8CxV6IJsNIyCNCsYaarBwpw0e5k0BA1SIvB93YHhqYLiz3C7bsw3S8TDNMTDPqN08qPfjG9S7fxJ/xt9CHoZ6t6fX6P6W89vPLFsprc7foqFGg2KJ4AJ5ADwv/zOMQKFDo6wZ3RUAKiKCGWJ44ZDdEvIiizIOyZuYu31E30PQ9vbjEWganlWnHDZv4eCl8qb10sREQrDo1b//mgGqb//mjELgmf9f6HAq/1f8l/3SAhphiUAGKHHQrjgNJN6WmXp6Ms6t6y/P/zOMQYFPI2pZ1aUAIzy5V5+8O6y8XBQkxxhpk9F/oMSwmnKbZyoXrfxBDbmO+drJZAVCSJv9W/oC8X//+MW//8qc/yP+t3+HESQJppo3RLYC5VOYGYSVdzfsHAAoFH3nwJbjrwJLj3L6Y0Ev/zOMQjHXsOvMuZaADjD+XDSwpjJL5X9OzJjUdHAXx6fstOhPF8+FuWb/zRb1UDEwTRHU0b/rTTTdC8xOGRUbpmjo//p96b9iqyaGfSav//pp+tPtdCcuzSY8kIf/d/0AvxCFCDZjREksC/T//zOMQMFVrSxBXZOADMFSFDaAsofmfk1bHDW6+P2LXjpRz9CdCSKaajocPETTZxxyUzjqnHCo/qadNNzupotFxx2mj7egnN//84P//+o9//+3//x5v9VQG572ADIWCIcRhI83gEMX1OsJXwLP/zOMQVFRI6rF1bOAAq+tlyq3e91V/PHLVbvqErKyHTXVtDjzYmGoa0RFYmn8CRfnL0sqKcaYBIXf7/1AEGf//Kh3t/+VCX/nf9n+WVH2/3toMoRAzSMQDLzIIqMbLAymDyygGEJctNgOArNP/zOMQfHKMGmMucUABq0HwltoRRk4KDyA8eiYB8eE1GYsYgtj9xXZR967kh5/jL946IhiAkP6H/vkiujRzv//iLcfnGOk85vT//9i48YeXZX3+f9f//2IycW0ccp///wQUx9a8QabiQpf6dsf/zOMQLFPImzAGYgABNGpbdp5yrDd+HRJDY3HGmwsR9B2N3LyNzV9BOpBF026GRiLKRl4tVNKZ6ptn6/er2y5q+d1/L2r/c9/6z3yX0v/O/lvr/6/+tBck2aecA4QLAnxDH0xPHFHlUtqia+//zOMQWFRtC3H/NaAL5kW+p6n+k8fjfrRZEkQM0+XTWkkokgiwbpRW3qT/qTb9Emjp/r///b/Ip7//7/5wlUX60ZIo/7f//X/RJpsoAgKSPaV90CtAgkcgVMgSZIosjmqktkHbd9RFIdW61Q//zOMQgFVNCyb9SUAIOXxkIb+LgGiYhfY4hGYFpMv0O/uPW/UqBVT+j////4qt/1r8hZ0+Mi951DUFZ/9v///7kBapIWgQWQUCkUigUCgUCgaFZdjB8c4sJ5YK0EyVx3MevEwfi2SExniYK4v/zOMQpH0rm8l+MUADYL5tTvgVzgvxcF4pq1/LmMhGLao9P8cH7nkAsDfVTTU/5AzCuLYsKePOnT/+xONCMnAXBDQEMVgaBDes0l0//8GwkHhCLZCIsuTkBIUJFOs6v/w/VAbaeubb4RfGkXP/zOMQKFSFC5b3PKACI5gj2jv2N7aeFWr23i1+/66Ch5WVB7iIs9SlqpQ9iIdVhZmIX2lRmR135YiaHrcA0jHgzKrJH+bQXcLl3PJJWUYl27Pqf0f+72oUACevfb3TyJSGFFigweIi02RN/1f/zOMQUFMl+3lzCRhCLBNOox/7AIEU/y3qyoYUNRlWf7EXIZoriNGVWnSzl5+fVNoFJ417/a06ZnqCsOisSDbkNcaY0OhPaz+yujxEqAKEtTcbMKCCA7csxiVSUhT1ENlwRYfdjvf17nf6nTv/zOMQfFNkSub7TBjjuvPBi3eGuXDXsP8lO+iGHFzvD2Iaky6pEwx655go6+CDqoTp/F/Q48RGAyKhNu2og7//yNQB++v1yGVGN+OtlLTrs9C+ck8JgxYN22d5gkLIbB1NLLEoDrWZ0zk2fPP/zOMQqE7mmtZTL1DCqbvSVEjNbRB+KFN2/7nqa/6DIQpq1SiD9v/5nqb/mdU/1O//WBCWtuTHQDsAi8OLQKAhm6TGZNL2B60Dz5LMKA6Zq62FKkRuv+1SKX2P+RyIhMWqqnMBktQ5FOcPQ1//zOMQ6FTGmsR7SVHip36Hamo/8oX/yz//yPh2nUdvEx4O5zqd/s64B1t2WZSfQRAGxKiQ7DXIAfe316MMYPna93mMtx1hjY1SXzhs5uUKGEjX/jpH9jgXE/4ii3/bp//Q7+g2f////Hn/qy//zOMREFPLSxb9YOAJkdv/jrfqYTMQ77kSP9fhuMIgHyJAXF3Bko4tbGgzQGpLvVyrVe63OFQmNOpOB8FwLAXAyCwZx+K4tmi4Yh/+QEhPH5QTWPG35COsRpMLiyMY+/1PMMMLvIWciJ/+VJ//zOMRPHjMisAGaUAAyhPkg+KliZHqb/+ZPSYx6vQoyFHPyDK///zD9GddGZJ6saYXyy/+j/l4TiI6IzK+9u24sIpIfZdXJXuB8CuMzM1JIbZbkwxHela6oesWuQ54yTx4xEZA8iWSZFbmRJP/zOMQ1FSlG7x/PaAAw5qgcTLeYvzLqP9Pzv/NvbRW7o9nusq9nu6t1G+z/RR61brH3tZAhmAftJYMwhi81BD/MRz7lqLc3emb3/TvFR7sjYRXNjgJL63EZ0q/Qvxr53KtxQXm/USlb9PN9uv/zOMQ/FQm6wb9YOABzyvpcs5EMs6HpWry++elqtNPs98gqADZkkjlcFolFotEogCNQoaMYXdFiQwtV51BYtmppO179IPEfAorQNBjGQXgoGhGUZQvJLG6xMCUNCms1ZSXyIF4CfhVyQJxuav/zOMRJJzMqzl+YaAJiz/iNjBoArYK+MtKpFjqX8jF9MFPARYb4yEjJkzFKpH/qTLg7ByH0Jyt7N//+OAYApmBo5IEomm9JJaLMkpaOkpf//MDQ8SZTNFpko2mbiYf//6InSckNVaaa4VZZav/zOMQLFuq2wAGZOABajuzdTtGPHPtXPAUqTDU0clAWm4DuJLc4Qn7CI+o2aVeJy8x4nLymKy/qPfjH5udnfbHfn498TNtQj57bU+V1aj+huZt+Wl71PqccRbsV/1UEAZWdtCCAg/rww6CUlf/zOMQOGNMerR3ZaACOvxcY0VQmvU2OOOWXY/Fd81/59Jgv3Vd0mS/UxWHCPU1ZTuokhImrVoqRJEIqG8bPbz3ZKXiSE2Sf8xLyX8XS6j//0Sg/9bf1FL//6kf9/9F///nEVSTklHd5K5Ar8//zOMQJF1saxb9YaAIeFMFjJEOvKc5qM8+lzx/+TNnnec/l9Alk9jNnW3+YkqpddU6OVFVF1mJkNAGcUXrZSVd3SrUUHb+Ymv9zI+3//OG6H8ut+o6h//9T/6P+j//+XvJqChYGIRO+Iygg3//zOMQKFyoW1AGYOADLDaKMyHvxR/7l3isTD9C/MDhwRyYjstX3FgvEYSR64+zv8ePMNHivtb7lTCZIicPe39ueYRHipUw87r//8dFAKEg+CwV1/+0FhcyFWPazZs/8zQ0RFXI8IGNAooAyQv/zOMQMFjo+zR3TUAIeMaMiVUTokzU0k1VMk2lWxo+O5MYhqJ0yoUI8G0hESNptupaY4Miaa0qb/OJXIhFAXApNnE/+UayCC83/dppouO0f/TUYiE/6P+7/IhVZSBiiQivHWPqANAou3WkKIf/zOMQSFIo+oDtaUAA5hlKq/MNWav8zs4fmI4HTTlIi6W+u4xE0tlC/f24UI5zHtes4lQ4qFCNe3+d1ChLanf5C3Hvv/r49/4h/7v8P1TlQMMMThINRkwfcL0rugWgljODOReZrS3S3oEMC4f/zOMQeHLMmnAGbkABYwYxDFAbYXDdnY+ZMsDgA4wi6ei345A4BW44y51/5bKIzY6xZZE//8kC+5DBmDy///3Y6QMrk+kaJf3//8mDRBZugYGjoMr/+v//1ptpugbvQWmRBENFrgEcIEzAqxv/zOMQKFzHmzAGaQACFN8hctB/l2NMmZRDVLE6QHRglYovFTgjFUKElWLCVHzqDkofKBgfWt1TKMIEaluRg//GD9atia/+//2+J0b//v//6/8Z3RV26vVz2fySNHc/ZoQJ3rADAHTK+jQtC+//zOMQMFRo+sFXaOACmg/rLpA4IiAuy03Uknq/OTdJ9bdLjjggBxyqpTO+uopBhrXbio784Dhl87/vY0K+nkf5wlN3/01HQkO79H7aDwv/4m9vnf8QqBJcklnn91tDYCowRHGk8VRTy76UIkv/zOMQWFVse3l9JOAKKVclWUmIowciKaJZhD53HRJMVRFI2KgNIfxGJcasn6ErOUFzY6+c/TqIpb//0Pb+c/8oJX//1b/O/zTf//jzVgwPww//+/99AA3W0MylcEa2uuI/jd0r15oE7HH7gW//zOMQfHRq6yZWYOADWiZjCIcNBIKFADxwwfAcYTMAJW57nnzAgCMSy9AIHWzMwgWE7OPswRkU6NyCnFWTVCSd0bqQOjJFnqTVAzbvP6v4iOiOonGyce0yrfmf/oWjYW1kdCgnNdZ97tt/xR//zOMQJFQqrDl/JKAKkZPbTI0AYNXg0ytUyYS5P5K6Dz+LsUSe79AYBX5XygX84dI/X/udhIe3fqb3Qxn//qilKX/T9sd1/9DGN/xp1cFSdXlQVBQ6lxUnVAJZuOpSqBHMBySMbVl1iQTU1CP/zOMQTFHFGxZ9YOALnL2FWrjy7e/fcu/YKlHbd1t5xrKaGjco6GoA47zVYLF+OPbqaOjUPD3clXnf9XhyippNvWdmK3NZ//EEtEL0+gpMqCzq4AwUWNUbTOzkOARoJR9a6YqIr0gSe9+FoNv/zOMQgHSMmmAGbaABjw9CcVHiRB2EoJ4MmPBEvl5jcBviXl4djrQe8yxgC+FwRLnVvqyOZqGIQDf2/5oggbFyr//8uLPJ09X///5IHmUaOcLil1f////rf1IH/QKf//+A1MJAIAAePJRJzAv/zOMQKFiFSuAGaWAAmZTqxqyqZKWMXgGMu0+kKtDUQ5UO9MxIUjLDGUDUvpE8YX0qWkEvuPFbY6q9jIY1st4+fUr7mP/9fvXZnl6LMhcQyVzNuR9vvqtyabVa1BmuypuNiBxubkU7L7LmU9P/zOMQQFWMexP/YUAKTmu5flTYa+W4f+O/0g9XOIUTaytRhcKR8THVY0QIFgtPzmIgXhCm//oaaQm/6P/kbf/+pA/8q3+Njv//ITP9P843//5V1AZpa7TOSBBU9h2ps3ZLccWU4wqtlV1/N3P/zOMQZFHmCuZ9ZKAK3jhqpe/m3Mh9mOeifmMokqUUgsY4xCnEGgUWV851fRaI6P/MLd5IosMX0Z3r9DgQ/Wd5V3Jf5XyAMFGhCNyBJKTdrNdjZloSW37KH770P3xYWDdUa5Z4eEmUSETHSmv/zOMQmHmrm2AGYQAB0HorJQ+ax7HvaIll8Hky8+jvaJo2zByIpOtw7V/6ekTI1RXWq0riI43fos8GgoYL8lMUHICpg0cNFv+bfr6Pvj//RKxYWVVYWilJx8nXBy+U/+L0IpySWyRz7IBIQgf/zOMQLFSFHBl3JMAKAap1eV3BOOJxXqm61p2AqDkUWEkcOXsbrJVOa5c/z9rf9+dqVjy+V+3qi8PCXc9CjzXsJCZCUE3Hc2kszd/TIiur/bZVoHB5xtQb5HJZHKYXATIjR9K2EdKqOg2gnJ//zOMQVFOD+5bx6RjZ8Bw2YIaQkLrgCX7HRcSMoXIMxwKhm3A4kixssJAqVWp63KHL4NPesYPDQMvBYAkSVUn1b9a3Oy3t/5bJckVUEpySW262W0RgHouhEp6Mt2gANNhkccVR6f3Gu6Jj6fP/zOMQgFJFW7l55hlaw/wTIpmZkR22aeVOcMyIRJaKPKKsKwqHNy0TrRSF8WAtyKv9RhqU6Gdz67dV/woA88pUCuSeW2yWYLRHBQfaSaVwQL8uz2N4uG/V2+20pn3zsK81MYy0n3SqCC0mLoP/zOMQsFNHy6b5gjyYVllmUfE4dzVVl+7Iqnd+pLZX48/f/9CejfxHU/rkT1sp5H/UPc2TVAKccu/223+GBKKQJ9wV9jp9Fjl2NKnT7k6WPkiUZp5pGl/ZbaBqKl5a1E79Ag11U5QNBHm/5u//zOMQ3FTrW7l5ZxWI/bq3V+Db/8vUnt0fv4p9H+hadW5fH8vBD7+p8P9YA5tza67a0XQMJfRNa3p1u5j36btVvkTSk8ztXk83xcvr6/TelKucFzJ1WRBiQeH1v+CjaAB8UfytcVBwmIfeUF//zOMRBFTkO0b7CTF4MIPuCl5cQiwAT7lBMjWhr9T/8NwH///FhxsAGDDCglvrpgdsq+nWzls1E9P08HvjWq5NC3xvDsz/y1oLJCST4xdfsqjlRaIIbp/nfn9ehUqnUIv//cOC630/w4T+pbP/zOMRLFTo6tFTRhJioBIeaepH+o2TQAPun8LYHS6pgw0uLSudBDck+XZsz3UTTY1K6xLLWGjWbfZ/1I0KDcON0fi73RDipbr/rqaOvzuhfpmmlff/rzf9P+Rd+RZtlosempb0S9KixCgO7L//zOMRVFGI6qFTKTnAAcDHAYN9PgEBH5HTwvkPZ9jMVpZTlKKevCIFmaW3LhEESlZWR0+lQ7ihKCMQxVxyC1f7jwlEWjw1U+dlvDMh4alt0OU1H5H2Q7Ru//hsCSDji048888AtvKQ4Bg5ymv/zOMRiFEEOjFVaQABwQRmN06zwcOPNYRZrEOKcoUnisngCYMOJWYgPILUOU3NISMjjIOAYgegu4xteSk0SNBARgwtIX8d/45CePMYcpEoJOHJC7CSgUYcP8uHkzM3ZwuQXkSwQELcWDDf9Df/zOMRwJysmpZWZaADqasgGhRJhfJIkVD1//dnQt0KA1GJeMywmlR5JaJj//1u//2NUlJHl0z1a8o0hvXah/XCQZGzJNtKPKAlcVs6C1ahe+SvuUnxxnZ7osBSiqPFjT0M6iutQ6ylqVPl1ef/zOMQyFeLWvB/ZKABKUrqUpe6ZXy+rfZ0BmQz9DG/QwmX+dv6B9v//Un+Pb+wsv+AepSA5ZSusToMGGy+4uOqkHAEEgUoZOAg2tVv2brmTdlmkHwC0m9clU90umaSjdhqMzEeRKIuVkqYBFv/zOMQ5H0MioH1baAITIrA0hKDCBUhFMo1MiSAbY6JOtAvIEsDdHVjZ6LqcuoqdaKRkTjj/5r/l3//6Y7nb8mnv7iZf//Wa/6P+cP///Kj3kzB7qO1FUwgjjlgrJaYcCEZjoUmAQCZqEo0RzP/zOMQbGVDWhAGceADIBTF4CAwMR1Hgo4yYqlwzjXJUNBMqNxQZoRFqDGiqtt4c6tW/nwa+n/8Hc+g88nfSk+fkfTmHq/lDIYKDXNW7/DCHI6Z7//Sl5tVgEOgkadIKAOg3WRruv87UonHmyv/zOMQUF+FO3AGYMACemCyaawU3yUg+kLASRUArWEIbGXRuY/yStiL3GeZnNn7PJ37vXhzeYLDcPlw8JwTBZBYRC/gRIYKOLVCJ5b+UcIHBhTk2JsLX7eGFAJ++S3e1hAA4KTVjUae5NsKLw//zOMQTGaLW9Z/LaAKXc1HaiW6qSNRkkZGyKSOtG9FGktGRRypJJPUbJJIooujotKxtRRVWikkkZJJPUiiy43PRfv1frYLi+ixiiij0kkn1oArpdRMSN//5JUv//yb/2LVXlXZ2ijgh4k0eJv/zOMQLF/LWuF1aaALCkI0lZA3spY1bqU3f5cu5VrVXv1slulJZAxPUZig+jrbuJ6UX7JIsi6kBlaWsaROf+bHnX7HB/BOkVIu2Xfb8ZhbKP9L/+cHMlr//8xb//+YHv9pVNWfC3RyI6yg5Y//zOMQKF0MqtAGbaAAQgjTEbGki7UEBgdV3DGLQYdUfWaIOUCTJby+U3TKQOhJX06DUa5G/NG8uooqdX9NTeOzVUv/pv6DIFE2tyee//+n+rpMbf/////K3+ZpfO///6QBCElMQFQBnaipnbv/zOMQMFULSuH3aOAADklNnG35Lq087u9a1lrLL/w//PMjwbCU1TFsn0V/BQktvbRC/zgJBKb/RP9Dgad84k3T5oQgIIm5x//9QHPOf//yD///xP/4bCADiVjjoD+mAwrFUufFq0ox1LkBUnv/zOMQWFTLasR9aUADOGOG+1vy7z9945pxoSSxGdV/bRS/hRHTjv8oX5ymhOEK/XzvXoTg1fzf/sF79P9PNAqm53//i1/6f8aDn/kUAWqWKxyWy22X74aigAEbOSINdmflJ646S67Grbr3Ynf/zOMQgHWKusl+ZUADH0qV0QRYFgghoLh6FtxAE7FR+KzxeOEJ7GRBsrqaskmHZQueujyRzCSw6W+a32fRmC9J3O4ihsRP8hzHY8nU8bq3Ep///manvPa7jE34u/Kf6HuAGhSAam4shzDfRW//zOMQJFNES1AGYSAAmnahbXXgbo/HwxhTz2EbeLGCusUQMNzP9tsSlc+whPvZmxaPZIsuefwqWui1Ag0PujAoLx7iu2GSZhyhz9urT2+v9PU/9n///+lUf/0IQZYlppotNIZbZpGxTK+6lWP/zOMQUFMqCwBXaOACPbmVjXZTf/LePjrnDwW0OorUONN6OaaKS3U2ccjZxzzTYnGKmt/ocnOHif83/46JDf//mix9v/+hdv+UO/8iqAYtOVAAOMniYAtGArIXEEyNhzerbgdBhr0ajU9eoI//zOMQfFRKCpF9aOAB3K1a1U7ny0JnNQ8sjLMd8056P4LSLt/0f8Uhn//9BUE387/5oDTvT3/xwS2o///jX/y3/h2o1uILAUZ5DkzEZA/GHgiI7cUyFVAUGq3z1R+IYeSBTU44XDhc+NMIHBP/zOMQpHxserAGbkABsLKRSx4L5ugNEjCDO/oIIISsWSLGZU/JxnHGby+oRAZBBL+X06HQNkVIo//YzJsroIMpI1kaM0r//oNVoIJl83ZTLZjiCkRkP//7f5puZ/q3IDTUJeEjQqkRjALEDC//zOMQLFWMCuLfZUAAgShlFK4sYZQ7XLuEzKaDldRVkUW7h3ZE5xz5rUORPQ5ucRN+cceANJW98XF/+d/3Lf1NEC///X/+h/fzhBBSm/5K///9P/EM/eSUF4tzabTa8FQJVh5KNTkvTfQXo5P/zOMQUFSL+5b9NUALSw9RUhmTWOf5lzqFDX1JhycUfx6AKdPOmBkFo//Vv6kA9/0EYd//53T1bynO6KFECk7/EUn//6q/6sLxMdkyupQG/yvuucMMMATBB4D2VCkjI2Z/ZRRyqBFLLf9tw3f/zOMQeHJMetZWYOACR0MnGljRqNgeDUWE3YwdUHAvQJGTV/G7jQUhPiYs3O4TjlTiB3/8gfMUm/KF//7VQxv/ov/+hjIQDA3caFRLDa/rnG///kDyZQgQPoaeTMMf//4EVG49C1hwBJB/vzv/zOMQKFaoS6AGPKACy/G9djgP1FGzgVGLmYiKHDnQeVWHYodymZUiPoaRUaX/dmIdBEXd73VqJTPVLbL+lG/RJXOLggHHlQPcOktXiRIucHsPq/k/tt///UgVtmdqj/62uBuG+ukdNGnkwnf/zOMQSFWDe9n/PKAAtzNGk3LaDvXg1g1xeqAaw5VMxkNd6yripRXbOrInBiwiWCgFGLCcJuL1v09jFPOjTBlaFzkri1pJ5kW0+joplNIxA6gU7NbtbbPoaH0SYz6o/XpUEZNnT5LcgGgrJlv/zOMQbFPl68lxhhpZ9KdxaFIsiNSgqgKkVZGolMjVGyjFY1SzUmkvRJbGSltLsBHh4b9SgoFD2RVcVc2SIpuq3f//EXyMJu7+/6+7XYUMqgOK2BGG/j3mW6dlw3430UcCjbF2pATWOYAUGxv/zOMQmFLmrAl5LxKYspBg5kcGVchNOioBv85TEL0Uy//oT+RRYRjXCMPuUY/U5Gs/4f/4gNco7vE4AqR27Xb2RwQiYQjO/lWsqoPcYZiV0mHHIt1z2WqW1fcfLJ73+5NQ8o1iaY5ikABinif/zOMQyFOna7l56VF620i4dTvdqiylWOPQ8LwKVmNalYgTf9ST/yvrf5z/q+/yNANFuOWeRXOtkWMJMW7sHX2717KL0VyihnPef7+W/vn3GUw9DTC99z6zTjyLG1HxjI/LgRYqMc7EAf6txq//zOMQ9FQnWuZtZOAJ1OeYBgTvHm7HBAH6/MB7/570+n/2/9SoBr2m2g/gBPFKj5bU1ZKPaCAntMWAAQAiEXLPGAiwFB5ylhp+IVLBMYSwER8VEGA2IsaDQLyODATyQZkQsDW+b8eEhU8zKu//zOMRHHPpylMubUAB/H4/PEOeen/8W92edo+n/ozkBIPG/r//++fY89lJ3brlbP4neXPny7z///9MBPbHP/v/vXf1JwuSCRoUpML4lTYHnlbXmCS5llSZye4qGKs8pR4sOllUOp28eGFmJXP/zOMQyHuHm0ZWYSADpv6H5oc6r1lmKku/G0nXupU6moeErh96udLs9r4lv+Sjew/+1t7W+nXK9/UlxdQwD0zo4pTYpYEk2CA5vW9dKgLFrhV5f/lf+pQGTWhAxGJYgww9EsF/N2SThmQVZqP/zOMQVFRlqvl3ZUAAOzru1AVJRbH5U6tnn00T0UqaepGPgUt/UoTHKaVJdVJep/pfQ7mia3XxlWip8rt3S7us9LZKt0r6n+d9m6j1KIBum6pyHz1hCcC3r1rBW4RY5Nax59ae/XK3da7ysR//zOMQfFHGWrH1ZKABWKxCFl6kcxihYZaAIK8pivlEnVrtxIWo4wT3l1KHhZqtfGtka/u8lulclW/z3p9Xz3kYxRfCEMRxi1DD3MaRXtkrnGFAy0wMZ69tZ6WXVTwjQTglySCMdZJp8FYGxEv/zOMQsH7vKqAGbaABoF26Dv3QWmaLopir+U0FlBkyNSHjR/lianWoyEGQ2q/49Fss3RSJQpibGlNLJIpf/t0x7n2RN1fkiW6v//kmU6tU0XN90S35MNdDK///9D//+WUtD+JB/QCHbqx6ajv/zOMQMFOMqqAHZUADMNdGlVfayvc/u9QE7tXnMvuxYEEKYoZr/o+rD0KYhN/UW2X9SIQpv//5QQpv+Q/9BEnP//9Rkdv9S3/Fxz///QXL/ov+aMWUNS1HDAA4HGEQiCwIApeppGKamgYAgF//zOMQXFMouqP1bUAAxrczt93yPSO3vLH0sRBKGxpKTGIjv9HzTA8D9WX5g8deh1Tgpf+b/sFYfv/o/+UG3//+IlvJev/zfp8qqOEsuKDwQ4M6eE5qaAaegbdMPmXcYtZd3qYFcDmHlOmpI+v/zOMQiHLPOtAGZaAAwWwOYaDk9JvEYGQOc4Sn/4w49zdBaf/+OQehQmBoMP//+MOU0FpjCD0NP///6kB7j3Nx6GkuFw0Jf////83emmShcNDd5fL5uSn//////lxoLNRAQYMoTHVcRayHF0v/zOMQOF5Gi0AGYOADJpE/r5vrlS5dGRqJPSpwQhCIxgquoj5IUjYSifjnlzEHjRqaf9PjkdHhs878d/MGxo6bUdQp1D+bBokwFSIt3evg0JTqAaCtvI629+JTv+ioRDY9MHODRkoElcjVG4//zOMQOFVMmoAHbUAAXMQCGSympu8nsuf3X9/mDkxURIDAFw7PKGHG29C+Qj0B0t0f/pVlJQpju//TqMRp6/+3iFfq3/80eHf//x76/+3kZz///jGoNOS1Tba3yUQxXhQBHEISl8drHysu8Vv/zOMQXFNIq3l9POAJI+JOwS3pNZr0Qecww8eNRVM1RyLJcBpYmRoS/vU1pwWAObt/zvFIS+d//lCXsc/O5xLxFCJH/Dv/K/+dqAw8+5MNOPPPIEZtKbkTUAkt379G5DV4yv3Vtqr/YTRcxQv/zOMQiHdMK1ZWZUABxULxFES7sYOCUKBmXCuRGfG8QhAF4ZPISP8Wy7D9ycgIjjyH/PHl1niqca7nG/9CxjO55ATCOQnUVB+n/7Nx+55hma13F56VX//3M/P+pHXuVft/6ajJjltjYeojVT//zOMQJFTrS0F/ZOACnPZJTQLIb8HsSvX8sdZbq46r44Z89DqDhIedlaptTeahzwIklZHarW9fHA0cccd/tnahUod28d9fNBH2/9uaFDn/o/+pF///5X/w3AJJUcjcjiCa5woMopnemu02uu//zOMQTFSra0b9ZOAI2aarjzm8v1a7+v0fNguceeJyKt60OpQYBqs83qSo9ugmDXv/18Ui1uvmP18UDdHzn//sC1v9H/42///yxbbU+rIo5sxRoUnA0cYfARuRMmFRC/LImdUQ8EzC4HhyQ0v/zOMQdG5rymAGcUADTF30fx4RmyNxZAri8UCBJDzGKwIANgXg3+Rb4X5OK4N5f/8nPPFvOf/8RZO48uhrfO/9j2mVi39H//+hk888zfVvp///5GThEHHA/B85///KVOs0KhG4QW4AaYGBgYP/zOMQNGJJ6wAGZUABoURQxZCjNnBlh9aaSjQQxORCHGoqCGJB6BKOlB+DBij4KE5iphKUKMRNFe9RaH5YiZTO0/WkVEeajHsvl/oL1zco48ffPt9U/Kf/f//vlX70yD8/llQlBEY7ZqgQFNv/zOMQJFWJWvR/YKAB0WkhPVVgSA7chkqubFWprLtNKbO5dlWq4V9AGCTj5RJ/+WodKI/flA1HmmeIm9v+iO1xXyeI/mNM/r/1q1F83URMevltHhrOVPi22pQW0lJJZHGwp4gyIgk2oZY41mP/zOMQSFTmqvb9ZOAKz/U7LrlSCuU03Ld/d5nv9WzXdQiMGxkoStslo8/AwurTW5QasjzWZFAiHNo+lH483kf+PPkdn/LZKVd4ar/q9bvZWAIm/bQOWFAx01zkoVBbYRV1NGmhBEwAFOVPanv/zOMQcHAmusMuaWADCw0Nt1fpU8aAkgPgSz4nNIlaikjnSkkiUzIKGHPHodoJpKLU1jU4Z1dV4fSCKy2GG0q26Z/+jh5Y6eai9sff///EznwESYtn8s1mfb57/66J/tvXVA5a/WthKg5ywFv/zOMQKFQpSuF/ZOAAlnF8ssZ9C24QysC+s7Ut1qatVs7tZZcy2dOcQTxqRc5TZpvX4V/nWACOHnOfPcKp/2f81BUVb9oQ/5o6Pfb/81Tu/x13t//5zyaoEly2W7/A4gABSI3C1Yy4mIvpmfP/zOMQUFHHWwR1UUAK4bslXPvOtvZCQnIRFiYbV3zUc3IRqmgFULZGSkXyIL1jvzwmkjf6P9qDITn/dAoA/1+Qg0nv+d8l///lfvgQ0Vim6+4J6ACREruP1ZhtUn75mxCBPyXHYHM9Nsew5DP/zOMQhHXvOwAGZaADDmf+RQ55Ikccn/43lxZqPc///lMdhQLgxw54yP//1y4eL48DpuUP///zMlyTLw5BBAbBPB2DHIYWv////8ewwBJGo5yaOdRkakuUR7pK//////9i/LRoTULBpABQjQ//zOMQKFqIO4AGYGADpArhRyUVaGQ/esZ1WFG2DCugZEDkCdIzOfZLZIW5MbYPthtPzzyZmeeUOevlkXtahadvyGf//3jEBATGFbf0Ts5K1lQxlX+xq3AOpen//+bUNybXbbbWxwWmu5AOnPP/zOMQOFSl/Fl/JGAK1EixSRbWZWMNe45gIV3GUKJt8l4y5R0wpKRrlk0gI12jM4mrYBMzSHWMMqHBJsXblXYmBmSawmHSxMKQgr7CVLP/sqryssgi3JJrbJPgmxARkyOLhS8YcrNg/RFay5v/zOMQYFLj65lzCRjILxpoMepxvCpmJFAZObCVhVbRNmwYUaUgYDCRg9ArolbSHRVpKW+JSwVDQiPRKvESMGg6VnXFTv6v/11yMIBA3uYLBIagnOwkkWyVC+DqmDha7obdRy01JxYsKNwphj//zOMQkFOKCqCrZiphtoRuVuoN5jfsUzX6PHVmY+zCG97YfEF7ensm5QOybe7f6E///uT/p/4v/5Az5/rUAFdnSEmu39glJV7ETWOragW62BCPmhmJahyq4uhh2ROK9+XC13Y7Ci2n99TCb+//zOMQvFFp+zn7DCjzs427S6MNFf/9NkFgb18b96GMvt/2boH/txn20cV2fz1f9SgH5FbtvNJRwvJAwcSL2Kl/e4vYtzb9WdSrtXJ/dYy/HK2rWdS3m9RrHnYMA1TZVOaC51LShc3A0CraEvf/zOMQ8FVou1b9YOAI6jxJTYhEbNX//oS847/Q3niZ/Z5b/yfo9VURK7XZJK5QKBRaLgKAgd+YppJYNjhBKgRqsA6QmdN0ksmiug6mmKBLheZY4DEC5GQ9TMpAZIToomZ1KZJNE6CegFuJ56v/zOMRFJesqyl+ZaAJb6YfQlyTGDCef/ikIwWASBPLn/+PhQdBFAs/++nwi5SHmbCMF5lED//3f8dhQHoPo+BMBajzLoXcljb////8T8pjnHufKZgSiBmYEgVpE7///QvyCCj1zOgkEGiAFdf/zOMQMFTF+pAvZUAAp0rpIp9VSP806L1J+7yJWonB0ZlOG6hZzVCYPh8dj456s3NNNUjGxmhzdR+ammhzDX0/6+QsoqB3ckzv9MRkvT5Lku3Z5X6J+DLMbka6ho5oi3OVPi9kxyM00/q/Vwv/zOMQWFUGCtR1YUAK1+zre5Dam7lJb1HpCSNIYpb+g+moXAdGvQ/mCQppaRkg+HxCUCl6jV209W5Us7ldGeUV0VzxTZv89+rX6n+gGa267f62XAbD4fDWAAdoZiDXYSZ1wKKTsDlVlJRN60P/zOMQgHMqqpl+ZaABfxfUGvlOsSHsG6O4dglQ8gjgrA90wMkfyWPCEUaolPs7Fz3dC6CzYyKKK//y+z9Ex9L/K2UsvLZFm1tZX/mT1o2SpM319H//WzJIra1lTE/u7dVVUSYgjMMMcYII/nv/zOMQLFyFSuAGZSABLSwjMVVWtQxFIJZ7JXRBMEzZgjHgiB6EkQMLiUBwXITYCEjhW2xc2w2TKiJoToh5WCBic5wTVnrTUYxj1EEG5/Jr5bwnrZg+BCK351uGD/7qFRvrbTs22lFFonIijFf/zOMQNFSJa3b/POAKXlvOjEmuu0tGXJ7E5dJ4pNNqN1sxI8BMWoIx04lod6mplc03vQWMvNNoPN/zv2OdBa3+FTW9Jpox9v/mocfzvUdJfO//9/pUoKW26WMR8lBWEC2Lltu0RRHKszvduP//zOMQXFOHatH9ZOAI9v5TuzXk2sMt5JzeWvx4nojqcYcACXPGpHvJiFh1WzlUIjX//T1MX+OsJAyiW8wdQ9/lqMqHPI/8r6/kVf0fEjO0oRvVY06INWhtejt3sqDB2ntdqM4IAUYUHvPcLoP/zOMQiG5MGyAGYUADMQQLX573ECPguguRa/e74rDEoRD8ef337C2LBINxYJf/7NsOlh6PiEVShUr///9yAjPLE5c0uPiEoRf////njwxzDSYaFQkD///+A1UOO/sH8BFSpI2TCoEJTTn5dl//zOMQSFULWwFXYOAD4vFLaXHHVNTY6ytf+8d0qEAuJa0OOeaadTqIf/3+kwEjvOocdzjvFI03/zv5QHJz//1NNjoPDn///FP//84bkg7/rAPbXjrkrTC+AQIbmsaVUuWO8XZxrYZXMs8tVu//zOMQcFVrS0b9YUALMN/y2F0gUgiBiQisebt66HAuk6m5365U26FAtf/6+MQUmdv/8Rg2Mdreno/IAzZf//xc///8h/8NqQG122221t1uu/222DAGaSRANAyktA85KLAqQxBwHBRILGVallv/zOMQlHlrS3l+aaALFH/gV9grRJSgNYXQc47jA2HeAxSx1juNzUk0jNvFh6foF/Ws1S9/sHwpNrZL9ug0ScjPukFASo9UbaAnyW3VpePhb/5kf/+/3LF+VFn1Io/Mm1f01JsUOmojuUZm0mP/zOMQKF5squAGaaAAK/Wo1lLqJIa0Vu9n/oHKCLGTVj3JdmCsVhd2ZPWb+OTXHsUFvzr2sbbXQv5Ob5Pb6afrTNDB99E8Tm+TE/of/Kv/pN9b/ofs/1nvnDj/nvnP/T/0qAEJqsAkuZTIluf/zOMQKFGsmrHXbUABDFmr88yrSpAVetfvHH+6rZ//e9zSECEThadSI1v9vBkandepfe2xogSZ///0EKb/r/Q4iEO///6Cqb/2/ocLTf//yA3//+RURKNx7Tb6yQMgLRNi2HMc27epuzWf0z//zOMQXFQrW2l9PUAKlPqetK4/QF4dISSRX6+/gukrtv0JaPOPNRAHShbnf8iZUUDQeky2b2fzdCcBY3//84G5///49b//+Pv/LKkhqtpttmNRoNRqNRqNQZ8Hknbyt0mH6gfILKiYKkOZJn//zOMQhHJvPDl+MOAIAMJgDKZUXjSRExq/PjcnFw0Dg0In5PPvJmGONP43e9zxIEtCijQ7/vfPzxxB41Dipw2//3z389nONOR3dn////f7jiuYfMcnPo7f//9v//y61gC1QOQdPDxkhFpK5gP/zOMQNFKKCyDXYKABpIcsJFuTOdvyrcirT1JlnhS46MVnBxyiR6HaNHbZB6GCbGdnKVbu0yPMqDHLLeuZ9e0YX6P+X8Ovf//4e///x7f8i//kVA0yOSQhQczcQygpTNIxH9HuWteja9I/II//zOMQZFWMmuF9aOAAT9LQzuWWWHa093zaKC00813HiRz5yTW7hCbZLJoR/nGAcMv//+Jg9/9f+UF3//9Qct///En///EX///HlABAum2222t2u21G0wAMN5BIYzkR4DovTMB0KXhS9kCB0mf/zOMQiHWKytl+aaAACo+VQ8BtclwxycNYVMTgYxKDAuUAeC00LpIkoxDPLPvuHIfUXnTZ1GPrV9kjQeDoDufrUtv91XGo2+TGS/S7qs7N8nf//7e1buTn+cPfMvZ9VQYUHkLUNkJW4wFW7uP/zOMQLFnsayAGZaACO/AUoqOPTZzlFKKQoiXlo1BDTII7nDSbtWgmtT6kE0UVOcV0mZMsT5FN0qUmkfv9D9L+yjpu3XnUNVfKP/603/6zL/5R//TZ//1m3/9RqDv8m29vEpLFIlEYNqd5N5//zOMQQFQMCzH/YUAAxbxq4d1nl8y60PU1/myZJoqEyOadNNR0f+okkv+LgmC0/8Xjn//+Nn/QiDYKU0476D13///X+hwURrf/////8iEP8FgSokoa4qHuGPeA0BWVFmWYyixnZxxvb7l/vTP/zOMQbFVsCqH1ZaAKiW5/+alss2a6fstGyH44UXb1oEsCmlB/5NKP/f/UVkk39YnpR/1Jf//6X/GMWv///f/l5v0WcLsvyNR8vRZnEf4OT+OzgqDT/to6jJ4kGRqI4t8RBIIGDwXCERvjQxf/zOMQkHePO1AGPOACYPic4bB/4lnuyuPOceNW/kDGPQhGqkWB0Jzv/7mefHTCJ40P//PczEQHhAaDQwSzUHWFIjDcAEbITEb//vJnuQbzz8Hw2mso1ucc6P//////80dUIwt1Ng9ACUDXBPP/zOMQLE/lC3RPPKABMy44U07Wqsw4mq1tS2KxsQ71UsPkcSe90FpWVFah1AUVS70fVlupnXRDHYRHIVMgEa4VQWnh+sjQ/dFcvu+5a+v+n3dYBKSSayyP2JAURdizBfGySwA5RHtOwdRVXjP/zOMQaFSF+9lxJhn7uRMxjnq3b0+7U62zInO/Y/FGyUTL1Wyh3mvPkfjWBXLf9hIWcHTowgBipkVWGXjaRRrwaPKEur/0emgCS5Z/7ADIKYxEgoLLeOVLCXvJAHsqywlLwdfYahfQTzBuYAv/zOMQkFID+ubTaRjgUDAoE2sXRTrDDTXkLHE6RRgeBWhWhpaNOntanMS157R9cqdSg7DSmeivzv7PqAbklkks+hdBCB5CxxYsu/0rGtjetVluQEWqbKdYqz3gqPEzUaNe2Vkqa3KC8MJ38EP/zOMQxFHJW4bx6Tsok7V2QdR/9XNz1nuKxEJHLTqIldfON///3/5U7yn//R6oAY0OB5xTg7MIOQHYMQM/aL7TI1WQBWoaC9E8mvYNSwepy+2v6uxF6PZey9eOR2V5/iOS/nIVDb+iCO2qOp//zOMQ+FSnaqbjTFHQcd9epCFn13iGJFf84Qyf9Hr+///t8hQBgi67I4kgXYNlPRdGw6kLS21+cqLC7p7rzPrGnD/6tnlzCdl5izHnodOVVYmZFc3wWRqebUlsoXAJEZ7XbjEt0O//qoXv/EP/zOMRIFVGusb9aUAIlvJf9R/yXlf/b4i9blRqWApAeFD3hxTL5hgV9mnMzQscSrnI4XH2vEpNF4X5cHyYHyz5K5IF+JgzIBCfOJBgLBhqHDgtfk555Ip5MKxGaL2/mGGPcwnYW0oW//MMPe//zOMRRHkPOsAGaUACQR8ilWX/+Y27c+eP+XSaaQI///shnsrmGNRj1ZC9jXKob//////+UCackKURqx4A8lqqcla9WW+FauMwTB17wS6nBPltUocg9Sw6OFEli8kZjGCxNW/nW1mJr1nvNuv/zOMQ3FVFG2b3PaALRdaZmSLaJNHxyXIRE6jZX8z4m21aN3k/V98tnqsVVBSllubcjcbB2CEE3OJEKd29lxD1HkmG6zQLXSJSzRocImbmChhhJkjUmGROB9SR/nH5i3mvmvnH626JK/8nN1P/zOMRAFWJW3l9PaAK+pL7dbf9/+v6vdus9toyPr9T6NvkVBMlkrksklo1EotGooAAoBYhUXzgEhJpqTRoBRDQkQBJeOsikl5PpPEd5CQXkCWDoJZIAlHWSi2RyyiEB20E/7pnE8EAPiRMpj//zOMRJJkMmzl+aWAJWUv/8lpEwoAEEkwvekv//gmJn3+5KDsnUa///8se03PjrIgJgODvorTSNNVv///9E+ffmw6EzREnjvjSuHLzCjp3T////+44TJe0+8+zv0wPX/v4ADd8R6LrHNSYENP/zOMQPGRKaxMuYUACsETU5mFmwNQ47t5FSBxiOGC8PkgsKdAvaaFK85Uck8m8Yuh5eVOqXo1HqK/41f4y/I+6HEZY16mZIaLu2Mi/yja/zy2/8q22Ub8vVa7J8lr5H/p/6VQkXHHtLbbGgu//zOMQJF5LS4l/PaAIKdvKGIpaySYR2t4vfwP+jYua53QMnEmY4XjZkU3e+1HpDMPJH9IyGT+ksyHsFiat//6QxhhTVv0i01/SSGMJ+bGz//0WWSIlBt/qb/RJV///5j93kVQSkhuraeoAXRP/zOMQJFyLapb9aUAA0CBxbpKiHhUN2ZJNpgztm9Wt3ZfL+5Vday/MilyoxHB6TEw9PNoWdWPVvFYm/yoXz/eovBpf//8JwKnb+a3+g+//53GAtkH/b/QfP///IC3qf4dURmnRwcjUERXz6/f/zOMQLFmHe2AGYKAC5bKnS/4ft2ZnigTA4eFvjlFxrh8RT4HcPuRRFSk/chCMdWS/+UTF1OR2ctS/+QhGOKHOqJR0cRd9IZDAYDx8/U2v/QQQHw+ZOHH7dX/l1DMjkk+RRYSiRdA6qmTz5yv/zOMQQFxrSvH3ZUABlL/Izu7S47x7zv8/H/yn+aJohiZTShpre1STQ4JwhTnc5f9TXc9woAiOeh//ss0SgvSVqmf9PGIVCU3M/83mh8/v/08QX//+Mz3/Dihm41LbI5Igbg3uCsidCYJIzMf/zOMQSFSrS1b9SaAKsihuzJrN1u5leqy+O42M0kji93SfmylJGY5xWUbMcNv+ZPqGoWy+l/1Nyotf//9ZK+//vzhC9X/t47W6//+XXUfyVSP12mt2n1A+G4uGwwAJU0QWBbXXXaYXqeR6Wbv/zOMQcHCsm+l+YOALiQ1LpTVj8XHyAyNj2Hx0S1PZyo4L4PwfkzzKwWrag3JiQOEP/yoPyYBAkKPP/+AwHDM80ef5z/892see43+b//+e9sww8+Qv9P1//5kzPPJnnvRiaMwseCMfpcpJSu//zOMQKFYFe0AGZSAC9kb0KoRVo8rmJXKI1LSyEsctAZUtYMNNQDbsiSfmW5wR7n7thmpZWZccv19+3/jTN7Cc07//6j8BixVQ5gktfrdkFs6Pt0u2dur+RACcft//+0DSSCBkTUoNpYFqdjP/zOMQTFVrW2b/ZUADDl+t3697dezhj3LLW3zhFFihxEaY5rUOO/jMandvIvPvIgnELaL/76jEUe3nN/jESDTdf/bmjj/9/+Uf//+THej1VAbbcjtzudDSB28sYvKrU73eFN9nm+173NVrXef/zOMQcFSqC1b9YUALfyMnEIUIoKOjEpiZvneKpL69B63NY6oLw67UO/5V88KoBEzT6/9R76f/6Eyc30O6G9ipb/lX/8OoQWCYGYGuNCjGXk64OwaWnqCgKCLLBWuBH1ddFOPcYQuiZD1HQwf/zOMQmHbsmtAGaaABPJMvD0LhRBTSTHozcky+XS0zJ6Dl4iN8oumtSZaimbJof0XZBBaI+KNlaP/c0dSC0jRxn/Ih///6DXXr7nEd///pvX0D++gt/nD+hnP/d/xsQlIxuNtuUMAsZeS+m6v/zOMQOFVoq4b/PKAKBu3JRWwZoE+LVriF7Wz66MAxh4dMQ45VK22yQ0ClM+LGsgUbkdTjw6vp/9lZzG/0/o5VN//6yjvX1lj36jwVBQ97airiBsqoB5uSzazOUKQEZVbNdoavd8hWnT63xb//zOMQXFOou3b9PUAK5I3xbO5hELQU4mFTTShd6KushnEznN9pxMC63HxETEJUeBEuxL/0ZHjEat/u3v521f+6coLaf8r/5P09NAAt8p/k7zDDAM5mfU8c0wA89woEhIbUtTWaUXoLdzcZhiP/zOMQiHOMOqZWaOAFpp+woBcFgTCkaAGA4IFgEj5AwaCKcCwWsgkGNE5NnjgXCdjjGr3+JbmCWjFH+/43SJBp5Be3/8fPY93HCAl////uxhkg3/////9T5554kOAMFBEwiMO8kxgwmVHV9Uv/zOMQNFclivAGZWAChubnNdUsi0pnobhqRj88fRQKiodEHl13klMxSNXGjYRUo0XVYsdOxHEIOs85vNfPxXqc8xLo/9XyssoduWAqPW5HXT7/3Jr5D9SoBluS3bOSYMQJJGI661CmpSNSeNP/zOMQUFVsq3b/PUAJce2vtyjWtvkJY0iDooJGIFcocSuzmbZEPhFDVPocVBkWW63IQuQIh8//9egUpv+//v///j7/q3/T///Iv/T/kZLUAKa5bmnYAaMw7HoKIOm70w+VNndw/G9es0tru7v/zOMQdFSsCvZ9YOAJz+fmWRDR2TKzzDjT1qys52eEIwnrUdBcf9kOQSjf/sYvUeU7/Nb/t///m/9W////+x5f/HSPw0hpttkEkRZWIESELvDmUOC/37T2fneb7yefj97h8JRCdTbjygFzAa//zOMQnHnrm3MuYQACQPi6Tw+EM0kR7NRBl/+VmKKC8c1af/VHEwIYPCYc91rF///1exg6JXa/9v67tP6SHdSCAXgsD0WDu+efWmZft/r//8RRYpiSRTa1NI2bw4qz/0QDJpfv9rZGw0LAeLf/zOMQMFRFC9l/MMADWOjz3qlr0MbTdN6GvX7LphMnUrkW+5+ah/LW6Hk6TqbXz5O0b6r3mu3+UeZQechjh4CNCWRdqWaFsvcM0/cu1duZT7OKO2WKVEct2v+21lcDhZQAQ3iYiLo4CvpAmif/zOMQWFNl7Dl5ZhlJyxZGZtHEKsoVVHFG51DDpAKpYtqbQV3Lz1WMquFIvypmXszc2ChJJ1nXGP6V3ltGFYqsNAYe4Rdf+7kd1KgSnZHI45JAAf4aQIAhphvEQ5vuorw3JLBYWDkiZOzAK2f/zOMQhFFEq3l55hpLQfwQQQjwhkHby4fmggQb+hHHiE9v7hz7+eWE0JKO2pew+FL+6jUCCFpcZW4m+62NqBKmlut1tttEEjapHzPWtvqyzzQbiUiSf0m8dcl3sleERFyyrVOUTKVZJcDArq//zOMQuFFLS9l57ClpHmRig7WuWxxEDG7f9GpMP9vI/vsNJ//+qF/6P/1///xv2+ioAf37bWnILgOY1IGq1ftjdUzbNJsEbeFxNHZMS5pDOe7f8448ZC0HoaorOXNaYLHcrOVQoRDdFzn+UZ//zOMQ7E3Ha0Z7CVDZDiMWjf87/qS/+n1P//yjpLf5KAaSTs2sllDjgMZmBlPujI68HY1onjuUyzm6Ll2re59XP1GVZg9SZcd1VQ9XBv+HIi/6poz1PxdNYOmLGULX//7f5JvlXdR7/iXbUev/zOMRMFIGCwb9ZQAJb/8s7/hoBAzSSz//880ADYB7c4ZghgJjtcfFggGFqHhwBJCU6VscRv4EIItmQS4HaMiag6Xj0GZAExg9OPdnGUQZPHeCQNs3bUjnV+OkzxqOrm1MPMP9f+RDrHTNmNP/zOMRZI4LqsZWaWAB/5czpmxlMHWynFvlZaSV3w/okN////65tV1dfVfczwvd/////q3nHxT1q2uypOYOp/+V/6AT5HLJLJJA2i6HEotuMFxgd/W1X2324UNIt26tU2LIPBciNR1mL5rHPyP/zOMQqFPoq2b/POALjg+RXob0I+lTh4mW6t/yrnnHKExz7eUf2nPJed//yW2t/nv1tgV3u9FUAKSqpeHdPOIWQBTr0NZYS3srmlEp7HuWFav2vEYzvK1ufRzlElWMIlnzURHxs8eJDZuUJcf/zOMQ1FVrSmH1ZOADwm8knKjHm/pjp3FI82j+7e3VvX//kf+v/m///5R3+0kogRx4iMGTCYyOQljmjB3Vlui1wxEHMjEfhUunhEDKKkDHMIcTsnAD5BagBkI4ihIMSg6VJh8AipBhF3bW6Bv/zOMQ+JKsmiAGbkACVCcAtHEARIgso/Psmnh74WvjSEZBcwVV/t9xjx6KgjwmyYIN//tyKjjGbMCLkIUhwET////IeVyKEURHLIOblRRob/////pqQQZky4SepBzf///CNM6xAYYYB/1pgq//zOMQKF7E+sAPZYAIJACy59n1Qol0uaNKYzKWUUstaLQSqVPvS8GiF05aaeISVcuOVrpVTLvOnrGRy7Q6tV06e12taGNctOXW9OxTj34KuiYOrFAaxK7DtP/s9v//B70etQbSUt221nEYvy//zOMQKF3Mq1b56VNYgQP0zv2XfwVTv0J7+kWi5Iqss/2S+xEROWRTpcZykMJoUDWomKRN583EQmfm5qpY40hA7OOf1Nb/F4mt/j4z/KkCt//9BJb/Kt/zP//8h///xJJVGtuTX/3bAK8MdDP/zOMQLF4LWzb9POAIAvlVYbagdTiLMjgZy254J1lyX3r6HBrDIHFhMNi43IjBpxzDyiMqj83x0i/Qec8oIrTWU9zTxSDlLv9uvx0SenzW/1N///oNn/zTf+d///jzeIm6uM2t8IMgLk1VxHf/zOMQMFeFK3AGYMABmuwXrN+aSTZZfCTiTfk75NjhVfSl70/hLaJX/+177vsdXavWf+7273yxxgKy9YEnCgSBUAhrVuOcuCqBYeIlU/9EseU1eEv//2/6VAGXqABechccJmZ08CiyfTvUsZv/zOMQTF+surB3aUACZphYFtBq2b2t5f+u2M+5oeaVFVZECGLRz//ShKnQGk3/0nN+okoLTru82RH2/woxCnP+3/zR6Ckm1RF//VmF4NxM///+Lyy///6khMkDANVMGMWH8hAOsNLl61bXLf//zOMQSFQsurF1aOAIiXLZsd13n87resdYNqjooOTekxjUb6t5QXf/0/xSMAxzHUTl5qjwlGmV/ASRf///QAo7///YThK3///HS3///hEdVOFEgMGEK+jyb9MERdR3IYdQqgYkobxzrP1QlNP/zOMQcG/MmoAGbgACKh4zNUioQw4VzZM+otIAKBBx4Ij9N3ZzAoB7A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';
    
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('status');
    const startBtn = document.getElementById('startBtn');
    const latencyEl = document.getElementById('latency');
    const spectatorBadge = document.getElementById('spectatorBadge');
    const pauseOverlay = document.getElementById('pauseOverlay');
    const pauseText = document.getElementById('pauseText');
    const pauseTimer = document.getElementById('pauseTimer');
    const emojiBar = document.getElementById('emojiBar');
    let currentLatency = null;
    let player1Name = 'Player 1';
    let player2Name = 'Player 2';
    
    // Game state + interpolation
    const ball = { x: 0.5, y: 0.5 };
    const prevBall = { x: 0.5, y: 0.5 };
    let paddle1 = 0.5, paddle2 = 0.5;
    let prevPaddle1 = 0.5, prevPaddle2 = 0.5;
    let score1 = 0, score2 = 0;
    let phase = 'waiting';
    let stateTime = 0;
    let myRole = null;
    let mySlot = null;
    let renderFrameId = null;
    let pingInterval = null;
    let gameActive = true;
    
    // Fix 9: Floating emoji tracking
    const floatingEmojis = [];
    const MAX_FLOATING_EMOJIS = 5;
    
    // Fix 3: Pause countdown interval
    let pauseCountdownInterval = null;
    
    // Pre-cache gradients
    const paddleHeight = canvas.height * 0.15;
    const paddleWidth = canvas.width * 0.02;
    const grad1 = ctx.createLinearGradient(0, 0, paddleWidth, 0);
    grad1.addColorStop(0, '#f97316');
    grad1.addColorStop(1, '#fbbf24');
    const grad2 = ctx.createLinearGradient(canvas.width - paddleWidth, 0, canvas.width, 0);
    grad2.addColorStop(0, '#8b5cf6');
    grad2.addColorStop(1, '#7c3aed');
    
    // WebSocket connection
    const roomId = window.location.pathname.split('/')[2];
    const urlParams = new URLSearchParams(window.location.search);
    const aiMode = urlParams.get('ai') === 'true';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const aiQuery = aiMode ? '?ai=true' : '';
    const ws = new WebSocket(\`\${protocol}//\${window.location.host}/r/\${roomId}\${aiQuery}\`);
    
    ws.onopen = () => {
      console.log('Connected to game room');
      statusEl.textContent = 'CONNECTED';
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }, 3000);
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'role':
          myRole = data.role;
          mySlot = data.slot;
          if (data.name && mySlot === 1) { player1Name = data.name; document.getElementById('p1name').textContent = player1Name; }
          if (data.name && mySlot === 2) { player2Name = data.name; document.getElementById('p2name').textContent = player2Name; }
          if (myRole === 'spectator') {
            // Fix 14: Show dedicated badge, don't use fading status
            spectatorBadge.style.display = 'block';
            // Fix 9: Show emoji bar for spectators
            emojiBar.style.display = 'flex';
          }
          break;
          
        case 'waiting':
          statusEl.style.opacity = '1';
          statusEl.textContent = data.message;
          break;
          
        case 'ready':
          statusEl.style.opacity = '1';
          statusEl.textContent = 'READY!';
          startBtn.style.display = 'block';
          if (data.player1Name) { player1Name = data.player1Name; document.getElementById('p1name').textContent = player1Name; }
          if (data.player2Name) { player2Name = data.player2Name; document.getElementById('p2name').textContent = player2Name; }
          break;
          
        case 'ai_opponent':
          statusEl.textContent = 'VS AI 🤖';
          player2Name = 'AI 🤖';
          document.getElementById('p2name').textContent = player2Name;
          break;
          
        case 'state':
          prevBall.x = ball.x; prevBall.y = ball.y;
          prevPaddle1 = paddle1; prevPaddle2 = paddle2;
          ball.x = data.ball.x; ball.y = data.ball.y;
          paddle1 = data.paddle1; paddle2 = data.paddle2;
          score1 = data.score1; score2 = data.score2;
          phase = data.phase;
          stateTime = performance.now();
          // Fix 3: Update pause overlay from state if paused
          if (data.phase === 'paused' && data.disconnectedSlot) {
            showPauseOverlay(data.disconnectedSlot, data.remainingSeconds);
          }
          break;
          
        case 'countdown':
          startBtn.style.display = 'none';
          statusEl.style.opacity = '1';
          statusEl.textContent = data.value;
          // Fix 3: Clear pause overlay on countdown (resume)
          hidePauseOverlay();
          playSound('countdown');
          break;
          
        case 'game_start':
          startBtn.style.display = 'none';
          statusEl.style.opacity = '0';
          hidePauseOverlay();
          playSound('start');
          startMusic();
          break;
          
        case 'score':
          playSound('score');
          statusEl.style.opacity = '1';
          statusEl.textContent = \`PLAYER \${data.scorer} SCORES!\`;
          shakeScreen();
          setTimeout(() => { statusEl.style.opacity = '0'; }, 1500);
          break;
          
        case 'game_over':
          statusEl.style.opacity = '1';
          hidePauseOverlay();
          if (data.reason === 'opponent_disconnected') {
            statusEl.textContent = \`PLAYER \${data.winner} WINS! (Opponent disconnected)\`;
          } else {
            statusEl.textContent = \`PLAYER \${data.winner} WINS!\`;
          }
          playSound('gameover');
          stopMusic();
          break;
          
        case 'game_ended':
          statusEl.style.opacity = '1';
          hidePauseOverlay();
          statusEl.textContent = 'GAME ENDED';
          stopMusic();
          break;
          
        case 'pong':
          if (data.timestamp) {
            currentLatency = Date.now() - data.timestamp;
            latencyEl.textContent = currentLatency + 'ms';
            latencyEl.style.color = currentLatency < 50 ? 'rgba(74,222,128,0.6)' : 
                                     currentLatency < 100 ? 'rgba(251,191,36,0.6)' : 'rgba(239,68,68,0.6)';
          }
          break;
          
        // Fix 17: Missing message handlers
        
        case 'reaction':
          // Fix 9: Show floating emoji for everyone
          showFloatingEmoji(data.emoji, data.from);
          break;
          
        case 'player_disconnected':
          // Fix 3: Show pause overlay with countdown
          showPauseOverlay(data.slot, data.timeout, data.name);
          break;
          
        case 'player_reconnected':
          // Fix 3: Clear overlay, show reconnected message
          hidePauseOverlay();
          statusEl.style.opacity = '1';
          statusEl.textContent = (data.name || 'Player') + ' reconnected!';
          setTimeout(() => { statusEl.style.opacity = '0'; }, 2000);
          break;
          
        case 'game_paused':
          // Fix 3: Late-joining spectators see current pause state
          showPauseOverlay(data.disconnectedSlot, data.remainingSeconds);
          break;
          
        case 'spectator_info':
          // Fix 13: Show spectator info in status (briefly)
          statusEl.style.opacity = '1';
          statusEl.textContent = data.message;
          setTimeout(() => { statusEl.style.opacity = '0'; }, 3000);
          break;
          
        case 'room_closed':
          // Fix 5: Room is closed, show error and link
          statusEl.style.opacity = '1';
          statusEl.innerHTML = data.reason + '<br><a href="/" style="color:#f97316;font-size:1rem">Back to Lobby</a>';
          gameActive = false;
          break;
      }
    };
    
    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      statusEl.textContent = 'CONNECTION ERROR';
    };
    
    ws.onclose = () => {
      console.log('Disconnected');
      if (gameActive) {
        statusEl.style.opacity = '1';
        statusEl.textContent = 'DISCONNECTED';
      }
      gameActive = false;
      stopMusic();
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    };
    
    // Fix 3: Pause overlay helpers
    function showPauseOverlay(slot, seconds, name) {
      const playerName = name || (slot === 1 ? player1Name : player2Name);
      pauseText.textContent = 'Waiting for ' + playerName + ' to reconnect...';
      pauseTimer.textContent = seconds || '15';
      pauseOverlay.style.display = 'flex';
      
      // Clear existing countdown
      if (pauseCountdownInterval) clearInterval(pauseCountdownInterval);
      
      let remaining = seconds || 15;
      pauseCountdownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(pauseCountdownInterval);
          pauseCountdownInterval = null;
          pauseTimer.textContent = '0';
        } else {
          pauseTimer.textContent = remaining;
        }
      }, 1000);
    }
    
    function hidePauseOverlay() {
      pauseOverlay.style.display = 'none';
      if (pauseCountdownInterval) {
        clearInterval(pauseCountdownInterval);
        pauseCountdownInterval = null;
      }
    }
    
    // Fix 9: Floating emoji display
    function showFloatingEmoji(emoji, from) {
      // Limit max simultaneous
      while (floatingEmojis.length >= MAX_FLOATING_EMOJIS) {
        const oldest = floatingEmojis.shift();
        if (oldest && oldest.parentNode) oldest.parentNode.removeChild(oldest);
      }
      
      const el = document.createElement('div');
      el.className = 'floating-emoji';
      // Random horizontal offset
      const offset = (Math.random() - 0.5) * 200;
      el.style.left = 'calc(50% + ' + offset + 'px)';
      el.innerHTML = '<span style="font-size:2rem">' + emoji + '</span><span class="emoji-name">' + (from || '') + '</span>';
      
      const canvasWrap = canvas.parentElement;
      canvasWrap.appendChild(el);
      floatingEmojis.push(el);
      
      // Remove after animation
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
        const idx = floatingEmojis.indexOf(el);
        if (idx !== -1) floatingEmojis.splice(idx, 1);
      }, 1500);
    }
    
    // Fix 9: Emoji bar click handlers
    let emojiCooldown = false;
    document.querySelectorAll('#emojiBar button').forEach(btn => {
      btn.addEventListener('click', () => {
        if (emojiCooldown || ws.readyState !== WebSocket.OPEN) return;
        const emoji = btn.getAttribute('data-emoji');
        ws.send(JSON.stringify({ type: 'reaction', emoji: emoji }));
        
        // Visual cooldown
        emojiCooldown = true;
        document.querySelectorAll('#emojiBar button').forEach(b => b.disabled = true);
        setTimeout(() => {
          emojiCooldown = false;
          document.querySelectorAll('#emojiBar button').forEach(b => b.disabled = false);
        }, 2000);
      });
    });
    
    // Client-side paddle prediction + throttle
    let localPaddleY = 0.5;
    let lastSendTime = 0;
    
    function handleInput(e) {
      if (!mySlot) return;
      
      const rect = canvas.getBoundingClientRect();
      let clientY;
      
      if (e.touches) {
        e.preventDefault();
        clientY = e.touches[0].clientY;
      } else {
        clientY = e.clientY;
      }
      
      const y = Math.max(0.075, Math.min(0.925, (clientY - rect.top) / rect.height));
      localPaddleY = y;
      
      const now = performance.now();
      if (now - lastSendTime > 66) {
        ws.send(JSON.stringify({ type: 'paddle', y: y }));
        lastSendTime = now;
      }
    }
    
    canvas.addEventListener('mousemove', handleInput);
    canvas.addEventListener('touchmove', handleInput, { passive: false });
    
    startBtn.addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'start_game' }));
      startBtn.style.display = 'none';
    });
    
    // Render loop
    function render() {
      const elapsed = performance.now() - stateTime;
      const t = Math.min(elapsed / 33, 1);
      const lerpBallX = prevBall.x + (ball.x - prevBall.x) * t;
      const lerpBallY = prevBall.y + (ball.y - prevBall.y) * t;
      const lerpP1 = mySlot === 1 ? localPaddleY : prevPaddle1 + (paddle1 - prevPaddle1) * t;
      const lerpP2 = mySlot === 2 ? localPaddleY : prevPaddle2 + (paddle2 - prevPaddle2) * t;
      
      ctx.fillStyle = '#0f0f0f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      ctx.strokeStyle = 'rgba(249,115,22,0.3)';
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.moveTo(canvas.width / 2, 0);
      ctx.lineTo(canvas.width / 2, canvas.height);
      ctx.stroke();
      ctx.setLineDash([]);
      
      ctx.fillStyle = '#fbbf24';
      ctx.font = '48px "Courier New"';
      ctx.textAlign = 'center';
      ctx.fillText(score1, canvas.width / 4, 60);
      ctx.fillText(score2, (canvas.width * 3) / 4, 60);
      
      ctx.fillStyle = grad1;
      ctx.fillRect(0, lerpP1 * canvas.height - paddleHeight / 2, paddleWidth, paddleHeight);
      
      ctx.fillStyle = grad2;
      ctx.fillRect(canvas.width - paddleWidth, lerpP2 * canvas.height - paddleHeight / 2, paddleWidth, paddleHeight);
      
      const bx = lerpBallX * canvas.width;
      const by = lerpBallY * canvas.height;
      const br = canvas.width * 0.01;
      
      ctx.fillStyle = 'rgba(249,115,22,0.3)';
      ctx.beginPath();
      ctx.arc(bx, by, br * 2.5, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(bx, by, br * 0.5, 0, Math.PI * 2);
      ctx.fill();
      
      if (gameActive) renderFrameId = requestAnimationFrame(render);
    }
    
    renderFrameId = requestAnimationFrame(render);
    
    // Sound effects (Fix 20: softer, warmer sounds)
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    function playSound(type, customFreq) {
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      
      if (type === 'paddle') {
        // Soft thud: low sine, quick decay
        osc.type = 'sine';
        osc.frequency.setValueAtTime(220, t);
        osc.frequency.exponentialRampToValueAtTime(110, t + 0.08);
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        osc.start(t);
        osc.stop(t + 0.12);
      } else if (type === 'wall') {
        // Gentle tap: higher sine, very short
        osc.type = 'sine';
        osc.frequency.value = 330;
        gain.gain.setValueAtTime(0.06, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
        osc.start(t);
        osc.stop(t + 0.06);
      } else if (type === 'score') {
        // Warm chime: two-note ascending
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.setValueAtTime(660, t + 0.12);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.setValueAtTime(0.1, t + 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        osc.start(t);
        osc.stop(t + 0.4);
      } else if (type === 'countdown') {
        // Soft tick
        osc.type = 'sine';
        osc.frequency.value = customFreq || 600;
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.start(t);
        osc.stop(t + 0.1);
      } else if (type === 'start') {
        // Rising chime: three quick notes
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.setValueAtTime(554, t + 0.08);
        osc.frequency.setValueAtTime(660, t + 0.16);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.setValueAtTime(0.12, t + 0.08);
        gain.gain.setValueAtTime(0.1, t + 0.16);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        osc.start(t);
        osc.stop(t + 0.35);
      } else if (type === 'gameover') {
        // Deep warm tone
        osc.type = 'sine';
        osc.frequency.setValueAtTime(330, t);
        osc.frequency.exponentialRampToValueAtTime(220, t + 0.5);
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
        osc.start(t);
        osc.stop(t + 0.6);
      }
      
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
    
    // Fix 19: Background music
    let bgMusic = null;
    let bgMusicPlaying = false;
    let musicMuted = false;
    
    function initMusic() {
      if (bgMusic) return;
      bgMusic = new Audio('data:audio/mp3;base64,' + MUSIC_B64);
      bgMusic.loop = true;
      bgMusic.volume = 0.15;
    }
    
    function startMusic() {
      if (musicMuted || bgMusicPlaying) return;
      initMusic();
      bgMusic.play().catch(() => {}); // may fail without user gesture
      bgMusicPlaying = true;
    }
    
    function stopMusic() {
      if (!bgMusic) return;
      bgMusic.pause();
      bgMusic.currentTime = 0;
      bgMusicPlaying = false;
    }
    
    function toggleMusic() {
      musicMuted = !musicMuted;
      if (musicMuted) {
        if (bgMusic) bgMusic.pause();
        bgMusicPlaying = false;
        musicBtn.textContent = '🔇';
      } else {
        if (phase === 'playing') startMusic();
        musicBtn.textContent = '🎵';
      }
    }
    
    // Music toggle button
    const musicBtn = document.createElement('button');
    musicBtn.id = 'musicToggle';
    musicBtn.textContent = '🎵';
    musicBtn.style.cssText = 'position:absolute;top:12px;right:12px;z-index:20;background:rgba(249,115,22,0.15);border:1px solid rgba(249,115,22,0.3);color:#fbbf24;font-size:1.2rem;padding:6px 10px;border-radius:6px;cursor:pointer;transition:all 0.2s;';
    musicBtn.addEventListener('click', toggleMusic);
    musicBtn.addEventListener('mouseenter', () => { musicBtn.style.background = 'rgba(249,115,22,0.3)'; });
    musicBtn.addEventListener('mouseleave', () => { musicBtn.style.background = 'rgba(249,115,22,0.15)'; });
    canvas.parentElement.appendChild(musicBtn);
    
    let activeShake = null;
    function shakeScreen() {
      if (activeShake) clearInterval(activeShake);
      let intensity = 10;
      activeShake = setInterval(() => {
        canvas.style.transform = \`translate(\${Math.random() * intensity - intensity/2}px, \${Math.random() * intensity - intensity/2}px)\`;
        intensity *= 0.9;
        if (intensity < 0.5) {
          clearInterval(activeShake);
          activeShake = null;
          canvas.style.transform = '';
        }
      }, 50);
    }
  </script>
</body>
</html>`;

const ANALYTICS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Global Pong - Live Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      background: #0a0a0a;
      color: #f5f5f5;
      padding: 2rem;
      max-width: 1400px;
      margin: 0 auto;
    }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #f97316, #fbbf24);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .back { color: #f97316; text-decoration: none; font-size: 0.9rem; }
    .back:hover { opacity: 0.8; }
    .live-dot { display: inline-block; width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-right: 6px; animation: blink 1.5s infinite; }
    @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-top: 2rem; }
    .grid-full { grid-column: 1 / -1; }
    .card {
      background: rgba(249,115,22,0.05);
      border: 1px solid rgba(249,115,22,0.2);
      padding: 1.5rem;
    }
    .card h2 { color: #fbbf24; font-size: 1.1rem; margin-bottom: 1rem; }
    .stats-row { display: flex; gap: 2rem; flex-wrap: wrap; }
    .stat { text-align: center; }
    .stat-big { font-size: 3rem; color: #f97316; }
    .stat-label { opacity: 0.5; font-size: 0.8rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid rgba(249,115,22,0.1); }
    th { color: #fbbf24; font-size: 0.75rem; text-transform: uppercase; }
    td { font-size: 0.85rem; }
    .bar-container { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
    .bar { height: 14px; background: linear-gradient(90deg, #f97316, #fbbf24); min-width: 2px; transition: width 0.3s; }
    .event-feed { max-height: 400px; overflow-y: auto; }
    .event-item { padding: 0.5rem 0; border-bottom: 1px solid rgba(249,115,22,0.08); display: flex; align-items: center; gap: 0.75rem; animation: fadeIn 0.3s; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
    .event-icon { font-size: 1.2rem; min-width: 24px; text-align: center; }
    .event-text { font-size: 0.85rem; flex: 1; }
    .event-time { font-size: 0.7rem; opacity: 0.4; min-width: 50px; text-align: right; }
    .event-room { color: #f97316; font-size: 0.75rem; }
    .loading { opacity: 0.5; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
    .footer { margin-top: 3rem; font-size: 0.8rem; opacity: 0.3; }
    .footer a { color: #f97316; text-decoration: none; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <a href="/" class="back">&larr; Back to Game</a>
  <h1>Live Dashboard</h1>
  <p style="opacity:0.5;margin-top:0.5rem"><span class="live-dot"></span>Real-time system view &bull; Hyperdrive + Postgres</p>
  
  <div class="grid">
    <div class="card">
      <h2>TOTALS</h2>
      <div id="totals" class="loading">Loading...</div>
    </div>
    <div class="card">
      <h2>ACTIVITY (24H)</h2>
      <div id="activity" class="loading">Loading...</div>
    </div>
    <div class="card grid-full">
      <h2><span class="live-dot"></span>LIVE EVENT FEED</h2>
      <div id="liveFeed" class="event-feed loading">Waiting for events...</div>
    </div>
    <div class="card">
      <h2>TOP CITIES</h2>
      <div id="cities" class="loading">Loading...</div>
    </div>
    <div class="card">
      <h2>TOP GAMES</h2>
      <div id="topGames" class="loading">Loading...</div>
    </div>
  </div>
  
  <div class="footer">Built by <a href="https://spark.jeka.org">Spark</a> | Data via Hyperdrive &rarr; Postgres</div>

  <script>
    const eventIcons = {
      player_joined: '&#x1F3AE;',
      point_scored: '&#x26BD;',
      game_over: '&#x1F3C6;',
    };
    const eventLabels = {
      player_joined: 'Player joined',
      point_scored: 'Point scored',
      game_over: 'Game over',
    };
    
    function timeAgo(ts) {
      const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
      if (s < 5) return 'now';
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s/60) + 'm ago';
      return Math.floor(s/3600) + 'h ago';
    }
    
    function renderEvent(e) {
      const icon = eventIcons[e.event_type] || '&#x2022;';
      const label = eventLabels[e.event_type] || e.event_type;
      let detail = '';
      if (e.event_type === 'player_joined') {
        const m0 = e.metadata ? (typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata) : {}; detail = (m0.name ? m0.name + ' from ' : '') + (e.city || 'Unknown') + (e.country ? ', ' + e.country : '') + (e.colo ? ' (via ' + e.colo + ')' : '');
      } else if (e.event_type === 'point_scored' && e.metadata) {
        const m = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
        detail = (m.score1 || 0) + '-' + (m.score2 || 0) + (m.rally_hits ? ' (' + m.rally_hits + ' hits)' : '');
      } else if (e.event_type === 'game_over' && e.metadata) {
        const m = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
        detail = 'Winner: P' + (e.player_slot || '?') + ' | ' + (m.score1||0) + '-' + (m.score2||0) + (m.duration_seconds ? ' | ' + m.duration_seconds + 's' : '');
      }
      return '<div class="event-item">' +
        '<span class="event-icon">' + icon + '</span>' +
        '<div class="event-text">' + label + '<br><span class="event-room">' + (e.room_id || '') + '</span> <span style="opacity:0.5;font-size:0.8rem">' + detail + '</span></div>' +
        '<span class="event-time">' + timeAgo(e.timestamp) + '</span>' +
        '</div>';
    }
    
    let lastEventCount = 0;
    
    async function loadLiveFeed() {
      try {
        const res = await fetch('/api/events/live');
        const data = await res.json();
        const el = document.getElementById('liveFeed');
        if (data.events && data.events.length > 0) {
          el.innerHTML = data.events.slice(0, 10).map(renderEvent).join('');
        } else {
          el.innerHTML = '<span style="opacity:0.5">No events yet. Play a game to see data flow!</span>';
        }
        el.classList.remove('loading');
      } catch (err) {
        console.error('Live feed error:', err);
      }
    }
    
    async function loadAnalytics() {
      try {
        const res = await fetch('/api/analytics');
        const data = await res.json();
        
        if (data.error) {
          document.querySelectorAll('.loading').forEach(el => {
            el.innerHTML = '<span style="color:#ef4444">Error: ' + data.error + '</span>';
            el.classList.remove('loading');
          });
          return;
        }
        
        const t = data.totals;
        document.getElementById('totals').innerHTML = 
          '<div class="stats-row">' +
          '<div class="stat"><div class="stat-big">' + (t.total || 0) + '</div><div class="stat-label">Events</div></div>' +
          '<div class="stat"><div class="stat-big">' + (t.rooms || 0) + '</div><div class="stat-label">Rooms</div></div>' +
          '</div>';
        document.getElementById('totals').classList.remove('loading');
        
        const actEl = document.getElementById('activity');
        if (data.activity.length === 0) {
          actEl.innerHTML = '<span style="opacity:0.5">No activity in last 24h</span>';
        } else {
          const maxGames = Math.max(...data.activity.map(a => parseInt(a.games)));
          actEl.innerHTML = data.activity.slice(0, 12).map(a => {
            const hour = new Date(a.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const pct = Math.max(5, (parseInt(a.games) / maxGames) * 100);
            return '<div class="bar-container"><span style="min-width:55px;font-size:0.75rem">' + hour + '</span>' +
                   '<div class="bar" style="width:' + pct + '%"></div>' +
                   '<span style="font-size:0.75rem;opacity:0.5">' + a.games + '</span></div>';
          }).join('');
        }
        actEl.classList.remove('loading');
        
        const citEl = document.getElementById('cities');
        if (data.cities.length === 0) {
          citEl.innerHTML = '<span style="opacity:0.5">No city data yet</span>';
        } else {
          citEl.innerHTML = '<table><tr><th>City</th><th>Country</th><th>Games</th></tr>' +
            data.cities.slice(0, 10).map(c => '<tr><td>' + c.city + '</td><td>' + (c.country || '?') + '</td><td style="color:#f97316">' + c.games + '</td></tr>').join('') +
            '</table>';
        }
        citEl.classList.remove('loading');
        
        const tgEl = document.getElementById('topGames');
        if (data.topGames.length === 0) {
          tgEl.innerHTML = '<span style="opacity:0.5">No completed games yet</span>';
        } else {
          tgEl.innerHTML = '<table><tr><th>Room</th><th>Points</th><th>Rally</th></tr>' +
            data.topGames.slice(0, 8).map(g => '<tr><td>' + g.room_id + '</td><td style="color:#f97316">' + (g.points || 0) + '</td><td>' + (g.longest_rally || '-') + '</td></tr>').join('') +
            '</table>';
        }
        tgEl.classList.remove('loading');
        
      } catch (err) {
        console.error('Error loading analytics:', err);
      }
    }
    
    // Initial load
    loadAnalytics();
    loadLiveFeed();
    
    // Live feed refreshes every 3s, analytics every 15s
    setInterval(loadLiveFeed, 3000);
    setInterval(loadAnalytics, 15000);
  </script>
</body>
</html>`;
