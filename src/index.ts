// Main Worker - routes HTTP requests, serves UI, creates rooms

import { GameRoom } from './game-room';
import { generateRoomName } from './room-names';
import {
  createRoom,
  getRoom,
  getRecentGames,
  getLeaderboard,
  getGlobalStats,
} from './d1-queries';
import pg from 'pg';

export { GameRoom };

interface Env {
  GAME_ROOM: DurableObjectNamespace;
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
      
      // API: Create new room
      if (url.pathname === '/api/create' && request.method === 'POST') {
        const roomId = generateRoomName();
        const cf = request.cf;
        
        // Create room record in D1
        await createRoom(
          env.DB,
          roomId,
          (cf?.colo as string) || null,
          (cf?.city as string) || null,
          (cf?.country as string) || null
        );
        
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
      
      // API: Get global stats
      if (url.pathname === '/api/stats') {
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
            `INSERT INTO game_events (room_id, event_type, player_slot, colo, city, country, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [event.room_id, event.event_type, event.player_slot, event.colo, event.city, event.country, JSON.stringify(event.metadata || {})]
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
               GROUP BY room_id ORDER BY points DESC LIMIT 10`
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
        
        // Check if this is a WebSocket upgrade request
        const upgradeHeader = request.headers.get('Upgrade');
        
        if (upgradeHeader === 'websocket') {
          // Route WebSocket to Durable Object
          const id = env.GAME_ROOM.idFromName(roomId);
          const stub = env.GAME_ROOM.get(id);
          return stub.fetch(request);
        } else {
          // Serve game page
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
  </style>
</head>
<body>
  <h1>🔥 GLOBAL PONG 🔥</h1>
  <div class="subtitle">Real-Time Multiplayer on Cloudflare's Edge</div>
  
  <button class="button" id="createBtn">CREATE ROOM</button>
  <button class="button button-secondary" id="aiBtn" style="margin-top: 0.5rem;">PLAY VS AI 🤖</button>
  
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
          setHTML(topEl, '<table><tr><th>Room</th><th>Points</th><th>Best Rally</th></tr>' +
            data.topGames.slice(0,8).map(g => '<tr><td style="font-size:0.75rem">' + g.room_id + '</td><td style="color:#f97316">' + (g.points||0) + '</td><td>' + (g.longest_rally||0) + ' hits</td></tr>').join('') + '</table>');
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
    
    // Load everything
    loadStats();
    loadLiveFeed();
    loadAnalytics();
    
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
    /* Cloud shapes */
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
    /* Flare: warm glow behind the canvas */
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
    /* Ember sparks floating up */
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
      top: 10px;
      left: 10px;
      font-size: 0.9rem;
      color: #f97316;
      text-decoration: none;
      opacity: 0.6;
      transition: opacity 0.3s;
      z-index: 20;
    }
    .home-link:hover { opacity: 1; }
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
  <a href="/" class="home-link">← Home</a>
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
      <div id="latency"></div>
    </div>
  </div>

  <script>
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('status');
    const startBtn = document.getElementById('startBtn');
    const latencyEl = document.getElementById('latency');
    let currentLatency = null;
    let player1Name = 'Player 1';
    let player2Name = 'Player 2';
    
    // Game state + interpolation (reuse objects, no allocations per frame)
    const ball = { x: 0.5, y: 0.5 };
    const prevBall = { x: 0.5, y: 0.5 };
    let paddle1 = 0.5, paddle2 = 0.5;
    let prevPaddle1 = 0.5, prevPaddle2 = 0.5;
    let score1 = 0, score2 = 0;
    let phase = 'waiting';
    let stateTime = 0;
    let myRole = null;
    let mySlot = null;
    
    // Pre-cache gradients (avoid creating per frame)
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
      // Start latency measurement
      setInterval(() => {
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
            statusEl.textContent = 'SPECTATING';
            setTimeout(() => { statusEl.style.opacity = '0'; }, 2000);
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
          // Mutate in place - zero allocations
          prevBall.x = ball.x; prevBall.y = ball.y;
          prevPaddle1 = paddle1; prevPaddle2 = paddle2;
          ball.x = data.ball.x; ball.y = data.ball.y;
          paddle1 = data.paddle1; paddle2 = data.paddle2;
          score1 = data.score1; score2 = data.score2;
          phase = data.phase;
          stateTime = performance.now();
          break;
          
        case 'countdown':
          startBtn.style.display = 'none';
          statusEl.style.opacity = '1';
          statusEl.textContent = data.value;
          playSound(800, 0.1);
          break;
          
        case 'game_start':
          startBtn.style.display = 'none';
          statusEl.style.opacity = '0';
          playSound(1200, 0.2);
          break;
          
        case 'score':
          playSound(400, 0.3);
          statusEl.style.opacity = '1';
          statusEl.textContent = \`PLAYER \${data.scorer} SCORES!\`;
          shakeScreen();
          setTimeout(() => { statusEl.style.opacity = '0'; }, 1500);
          break;
          
        case 'game_over':
          statusEl.style.opacity = '1';
          statusEl.textContent = \`PLAYER \${data.winner} WINS!\`;
          playSound(1000, 0.5);
          break;
          
        case 'pong':
          if (data.timestamp) {
            currentLatency = Date.now() - data.timestamp;
            latencyEl.textContent = currentLatency + 'ms';
            latencyEl.style.color = currentLatency < 50 ? 'rgba(74,222,128,0.6)' : 
                                     currentLatency < 100 ? 'rgba(251,191,36,0.6)' : 'rgba(239,68,68,0.6)';
          }
          break;
      }
    };
    
    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      statusEl.textContent = 'CONNECTION ERROR';
    };
    
    ws.onclose = () => {
      console.log('Disconnected');
      statusEl.textContent = 'DISCONNECTED';
    };
    
    // Client-side paddle prediction + throttle
    let localPaddleY = 0.5;
    let lastSendTime = 0;
    
    // Mouse/touch controls
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
      localPaddleY = y; // immediate local update
      
      // Throttle sends to ~15/sec (every 66ms)
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
      // Interpolation factor (smooth between server updates)
      const elapsed = performance.now() - stateTime;
      const t = Math.min(elapsed / 33, 1);
      const lerpBallX = prevBall.x + (ball.x - prevBall.x) * t;
      const lerpBallY = prevBall.y + (ball.y - prevBall.y) * t;
      const lerpP1 = mySlot === 1 ? localPaddleY : prevPaddle1 + (paddle1 - prevPaddle1) * t;
      const lerpP2 = mySlot === 2 ? localPaddleY : prevPaddle2 + (paddle2 - prevPaddle2) * t;
      
      // Clear
      ctx.fillStyle = '#0f0f0f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Center line (no shadow needed)
      ctx.strokeStyle = 'rgba(249,115,22,0.3)';
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.moveTo(canvas.width / 2, 0);
      ctx.lineTo(canvas.width / 2, canvas.height);
      ctx.stroke();
      ctx.setLineDash([]);
      
      // Scores (no shadow - saves GPU every frame)
      ctx.fillStyle = '#fbbf24';
      ctx.font = '48px "Courier New"';
      ctx.textAlign = 'center';
      ctx.fillText(score1, canvas.width / 4, 60);
      ctx.fillText(score2, (canvas.width * 3) / 4, 60);
      
      // Left paddle (orange, cached gradient, no shadow)
      ctx.fillStyle = grad1;
      ctx.fillRect(
        0,
        lerpP1 * canvas.height - paddleHeight / 2,
        paddleWidth,
        paddleHeight
      );
      
      // Right paddle (purple, cached gradient, no shadow)
      ctx.fillStyle = grad2;
      ctx.fillRect(
        canvas.width - paddleWidth,
        lerpP2 * canvas.height - paddleHeight / 2,
        paddleWidth,
        paddleHeight
      );
      
      // Ball - interpolated position, no shadow (perf)
      const bx = lerpBallX * canvas.width;
      const by = lerpBallY * canvas.height;
      const br = canvas.width * 0.01;
      
      // Outer glow circle (no shadowBlur, just a larger translucent circle)
      ctx.fillStyle = 'rgba(249,115,22,0.3)';
      ctx.beginPath();
      ctx.arc(bx, by, br * 2.5, 0, Math.PI * 2);
      ctx.fill();
      
      // Main ball
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
      
      // Hot core
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(bx, by, br * 0.5, 0, Math.PI * 2);
      ctx.fill();
      
      requestAnimationFrame(render);
    }
    
    render();
    
    // Sound effects (Web Audio API)
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    function playSound(frequency, duration) {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      oscillator.frequency.value = frequency;
      oscillator.type = 'square';
      
      gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(
        0.01,
        audioCtx.currentTime + duration
      );
      
      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + duration);
      
      // Clean up after sound finishes to prevent memory leak
      oscillator.onended = () => {
        oscillator.disconnect();
        gainNode.disconnect();
      };
    }
    
    // Screen shake effect (cancel previous before starting new)
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
