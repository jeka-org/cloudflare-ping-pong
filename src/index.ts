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
      
      // Analytics dashboard page
      if (url.pathname === '/analytics') {
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
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
      position: relative;
      overflow: hidden;
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
      margin-top: 3rem;
      display: flex;
      gap: 3rem;
      flex-wrap: wrap;
      justify-content: center;
      position: relative;
      z-index: 1;
    }
    .stat {
      text-align: center;
    }
    .stat-value {
      font-size: 3rem;
      color: #f97316;
      text-shadow: 0 0 10px rgba(249,115,22,0.5);
    }
    .stat-label {
      font-size: 1rem;
      opacity: 0.5;
      margin-top: 0.5rem;
    }
    .recent-games {
      margin-top: 3rem;
      width: 100%;
      max-width: 800px;
      position: relative;
      z-index: 1;
    }
    .recent-games h2 {
      font-size: 1.5rem;
      margin-bottom: 1rem;
      text-align: center;
      color: #fbbf24;
    }
    .game-item {
      background: rgba(249,115,22,0.05);
      border: 1px solid rgba(249,115,22,0.2);
      padding: 1rem;
      margin-bottom: 0.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .game-score {
      font-size: 1.5rem;
      font-weight: bold;
      color: #f97316;
    }
    .loading {
      opacity: 0.5;
      animation: pulse 1s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
    .footer {
      margin-top: 3rem;
      font-size: 0.8rem;
      opacity: 0.3;
      position: relative;
      z-index: 1;
    }
    .footer a { color: #f97316; text-decoration: none; }
    .footer a:hover { opacity: 0.8; }
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
  
  <div class="recent-games">
    <h2>RECENT GAMES</h2>
    <div id="recentGamesList" class="loading">Loading...</div>
  </div>

  <script>
    // Load stats
    async function loadStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('totalGames').textContent = data.stats.total_games;
        document.getElementById('activeGames').textContent = data.stats.active_games;
        document.getElementById('totalPlayers').textContent = data.stats.total_players;
      } catch (err) {
        console.error('Error loading stats:', err);
      }
    }
    
    // Load recent games
    async function loadRecentGames() {
      try {
        const res = await fetch('/api/recent');
        const data = await res.json();
        const list = document.getElementById('recentGamesList');
        
        if (data.games.length === 0) {
          list.innerHTML = '<div style="text-align:center;opacity:0.5">No games yet. Be the first!</div>';
          list.classList.remove('loading');
          return;
        }
        
        list.innerHTML = data.games.map(game => \`
          <div class="game-item">
            <div>
              <strong>\${game.id}</strong><br>
              <small>\${game.player1_city || '?'} vs \${game.player2_city || '?'}</small>
            </div>
            <div class="game-score">\${game.final_score || 'N/A'}</div>
          </div>
        \`).join('');
        list.classList.remove('loading');
      } catch (err) {
        console.error('Error loading recent games:', err);
        document.getElementById('recentGamesList').innerHTML = 
          '<div style="text-align:center;opacity:0.5">Error loading games</div>';
      }
    }
    
    // Create room
    document.getElementById('createBtn').addEventListener('click', async () => {
      const btn = document.getElementById('createBtn');
      btn.disabled = true;
      btn.textContent = 'CREATING...';
      
      try {
        const res = await fetch('/api/create', { method: 'POST' });
        const data = await res.json();
        window.location.href = data.url;
      } catch (err) {
        console.error('Error creating room:', err);
        alert('Error creating room. Please try again.');
        btn.disabled = false;
        btn.textContent = 'CREATE ROOM';
      }
    });
    
    // Play vs AI
    document.getElementById('aiBtn').addEventListener('click', async () => {
      const btn = document.getElementById('aiBtn');
      btn.disabled = true;
      btn.textContent = 'CREATING...';
      
      try {
        const res = await fetch('/api/create', { method: 'POST' });
        const data = await res.json();
        window.location.href = data.url + '?ai=true';
      } catch (err) {
        console.error('Error creating room:', err);
        alert('Error creating room. Please try again.');
        btn.disabled = false;
        btn.textContent = 'PLAY VS AI 🤖';
      }
    });
    
    // Load data
    loadStats();
    loadRecentGames();
    
    // Refresh stats every 10 seconds
    setInterval(loadStats, 10000);
  </script>
  <div class="footer">✨ Built by <a href="https://spark.jeka.org">Spark</a> • Workers + Durable Objects + D1 + Hyperdrive</div>
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
    }
    #gameCanvas {
      border: 2px solid #f97316;
      box-shadow: 0 0 20px rgba(249,115,22,0.4), 0 0 40px rgba(249,115,22,0.2), inset 0 0 60px rgba(249,115,22,0.05);
      background: #0f0f0f;
      position: relative;
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
  <div style="position: relative;">
    <canvas id="gameCanvas" width="800" height="600"></canvas>
    <div class="scanlines"></div>
    <div id="status">CONNECTING...</div>
    <button id="startBtn">START GAME 🔥</button>
    <div id="latency"></div>
  </div>

  <script>
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('status');
    const startBtn = document.getElementById('startBtn');
    const latencyEl = document.getElementById('latency');
    let currentLatency = null;
    
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
          // Don't show player number, wait for waiting/ready status
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
          break;
          
        case 'ai_opponent':
          statusEl.textContent = 'VS AI 🤖';
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
    canvas.addEventListener('touchmove', handleInput);
    
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
  <title>Global Pong - Analytics</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      background: #0a0a0a;
      color: #f5f5f5;
      padding: 2rem;
      max-width: 1200px;
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
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 2rem; margin-top: 2rem; }
    .card {
      background: rgba(249,115,22,0.05);
      border: 1px solid rgba(249,115,22,0.2);
      padding: 1.5rem;
    }
    .card h2 { color: #fbbf24; font-size: 1.2rem; margin-bottom: 1rem; }
    .stat-big { font-size: 3rem; color: #f97316; }
    .stat-label { opacity: 0.5; font-size: 0.9rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid rgba(249,115,22,0.1); }
    th { color: #fbbf24; font-size: 0.8rem; text-transform: uppercase; }
    td { font-size: 0.9rem; }
    .bar-container { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
    .bar { height: 16px; background: linear-gradient(90deg, #f97316, #fbbf24); min-width: 2px; }
    .loading { opacity: 0.5; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
    .footer { margin-top: 3rem; font-size: 0.8rem; opacity: 0.3; }
    .footer a { color: #f97316; text-decoration: none; }
  </style>
</head>
<body>
  <a href="/" class="back">&larr; Back to Game</a>
  <h1>&#x1F4CA; Analytics</h1>
  <p style="opacity:0.5;margin-top:0.5rem">Powered by Hyperdrive + Postgres</p>
  
  <div class="grid">
    <div class="card">
      <h2>TOTALS</h2>
      <div id="totals" class="loading">Loading...</div>
    </div>
    <div class="card">
      <h2>ACTIVITY (24H)</h2>
      <div id="activity" class="loading">Loading...</div>
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
  
  <div class="footer">Built by <a href="https://spark.jeka.org">Spark</a> | Data via Hyperdrive to Postgres</div>

  <script>
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
          '<div style="display:flex;gap:2rem">' +
          '<div><div class="stat-big">' + (t.total || 0) + '</div><div class="stat-label">Events</div></div>' +
          '<div><div class="stat-big">' + (t.rooms || 0) + '</div><div class="stat-label">Rooms</div></div>' +
          '</div>';
        document.getElementById('totals').classList.remove('loading');
        
        const actEl = document.getElementById('activity');
        if (data.activity.length === 0) {
          actEl.innerHTML = '<span style="opacity:0.5">No activity in last 24h</span>';
        } else {
          const maxGames = Math.max(...data.activity.map(a => parseInt(a.games)));
          actEl.innerHTML = data.activity.map(a => {
            const hour = new Date(a.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const pct = Math.max(5, (parseInt(a.games) / maxGames) * 100);
            return '<div class="bar-container"><span style="min-width:60px;font-size:0.8rem">' + hour + '</span>' +
                   '<div class="bar" style="width:' + pct + '%"></div>' +
                   '<span style="font-size:0.8rem;opacity:0.6">' + a.games + ' games</span></div>';
          }).join('');
        }
        actEl.classList.remove('loading');
        
        const citEl = document.getElementById('cities');
        if (data.cities.length === 0) {
          citEl.innerHTML = '<span style="opacity:0.5">No city data yet</span>';
        } else {
          citEl.innerHTML = '<table><tr><th>City</th><th>Country</th><th>Games</th></tr>' +
            data.cities.map(c => '<tr><td>' + c.city + '</td><td>' + (c.country || '?') + '</td><td style="color:#f97316">' + c.games + '</td></tr>').join('') +
            '</table>';
        }
        citEl.classList.remove('loading');
        
        const tgEl = document.getElementById('topGames');
        if (data.topGames.length === 0) {
          tgEl.innerHTML = '<span style="opacity:0.5">No completed games yet</span>';
        } else {
          tgEl.innerHTML = '<table><tr><th>Room</th><th>Points</th><th>Longest Rally</th></tr>' +
            data.topGames.map(g => '<tr><td>' + g.room_id + '</td><td style="color:#f97316">' + (g.points || 0) + '</td><td>' + (g.longest_rally || '-') + '</td></tr>').join('') +
            '</table>';
        }
        tgEl.classList.remove('loading');
        
      } catch (err) {
        console.error('Error loading analytics:', err);
        document.querySelectorAll('.loading').forEach(el => {
          el.innerHTML = '<span style="color:#ef4444">Failed to load</span>';
          el.classList.remove('loading');
        });
      }
    }
    
    loadAnalytics();
    setInterval(loadAnalytics, 30000);
  </script>
</body>
</html>`;
