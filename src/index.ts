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
  <div class="spark-badge">✨ built by Spark</div>
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
  <div class="footer">✨ Powered by <a href="https://jeka.org">Spark</a> • Workers + Durable Objects + D1 + Hyperdrive</div>
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
  </div>

  <script>
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('status');
    
    // Game state
    let gameState = {
      ball: { x: 0.5, y: 0.5 },
      paddle1: 0.5,
      paddle2: 0.5,
      score1: 0,
      score2: 0,
      phase: 'waiting'
    };
    let myRole = null;
    let mySlot = null;
    
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
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'role':
          myRole = data.role;
          mySlot = data.slot;
          if (myRole === 'spectator') {
            statusEl.textContent = 'SPECTATING';
          } else {
            statusEl.textContent = \`PLAYER \${mySlot}\`;
          }
          setTimeout(() => { statusEl.style.opacity = '0'; }, 2000);
          break;
          
        case 'ai_opponent':
          statusEl.textContent = 'VS AI 🤖';
          break;
          
        case 'state':
          gameState = data;
          break;
          
        case 'countdown':
          statusEl.style.opacity = '1';
          statusEl.textContent = data.value;
          playSound(800, 0.1);
          break;
          
        case 'game_start':
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
    
    // Mouse/touch controls
    function handleInput(e) {
      if (!mySlot) return;
      
      const rect = canvas.getBoundingClientRect();
      let clientY;
      
      if (e.touches) {
        clientY = e.touches[0].clientY;
      } else {
        clientY = e.clientY;
      }
      
      const y = (clientY - rect.top) / rect.height;
      
      ws.send(JSON.stringify({
        type: 'paddle',
        y: Math.max(0.075, Math.min(0.925, y))
      }));
    }
    
    canvas.addEventListener('mousemove', handleInput);
    canvas.addEventListener('touchmove', handleInput);
    
    // Render loop
    function render() {
      // Clear
      ctx.fillStyle = '#0f0f0f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Center line
      ctx.strokeStyle = 'rgba(249,115,22,0.3)';
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.moveTo(canvas.width / 2, 0);
      ctx.lineTo(canvas.width / 2, canvas.height);
      ctx.stroke();
      ctx.setLineDash([]);
      
      // Scores
      ctx.fillStyle = '#fbbf24';
      ctx.font = '48px "Courier New"';
      ctx.textAlign = 'center';
      ctx.shadowBlur = 15;
      ctx.shadowColor = 'rgba(249,115,22,0.6)';
      ctx.fillText(gameState.score1, canvas.width / 4, 60);
      ctx.fillText(gameState.score2, (canvas.width * 3) / 4, 60);
      ctx.shadowBlur = 0;
      
      // Paddles
      const paddleHeight = canvas.height * 0.15;
      const paddleWidth = canvas.width * 0.02;
      
      // Left paddle (orange)
      ctx.shadowBlur = 20;
      ctx.shadowColor = '#f97316';
      const grad1 = ctx.createLinearGradient(0, 0, paddleWidth, 0);
      grad1.addColorStop(0, '#f97316');
      grad1.addColorStop(1, '#fbbf24');
      ctx.fillStyle = grad1;
      ctx.fillRect(
        0,
        gameState.paddle1 * canvas.height - paddleHeight / 2,
        paddleWidth,
        paddleHeight
      );
      
      // Right paddle (purple)
      ctx.shadowColor = '#7c3aed';
      const grad2 = ctx.createLinearGradient(canvas.width - paddleWidth, 0, canvas.width, 0);
      grad2.addColorStop(0, '#8b5cf6');
      grad2.addColorStop(1, '#7c3aed');
      ctx.fillStyle = grad2;
      ctx.fillRect(
        canvas.width - paddleWidth,
        gameState.paddle2 * canvas.height - paddleHeight / 2,
        paddleWidth,
        paddleHeight
      );
      
      // Ball with ember glow
      const ballX = gameState.ball.x * canvas.width;
      const ballY = gameState.ball.y * canvas.height;
      const ballRadius = canvas.width * 0.01;
      
      // Outer glow
      ctx.shadowBlur = 30;
      ctx.shadowColor = '#f97316';
      const ballGrad = ctx.createRadialGradient(ballX, ballY, 0, ballX, ballY, ballRadius * 2);
      ballGrad.addColorStop(0, '#fbbf24');
      ballGrad.addColorStop(0.5, '#f97316');
      ballGrad.addColorStop(1, 'rgba(220,38,38,0.3)');
      ctx.fillStyle = ballGrad;
      ctx.beginPath();
      ctx.arc(ballX, ballY, ballRadius * 1.5, 0, Math.PI * 2);
      ctx.fill();
      
      // Bright core
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ballX, ballY, ballRadius * 0.5, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.shadowBlur = 0;
      
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
    }
    
    // Screen shake effect
    function shakeScreen() {
      const originalTransform = canvas.style.transform;
      let intensity = 10;
      const shakeInterval = setInterval(() => {
        canvas.style.transform = \`translate(\${Math.random() * intensity - intensity/2}px, \${Math.random() * intensity - intensity/2}px)\`;
        intensity *= 0.9;
        if (intensity < 0.5) {
          clearInterval(shakeInterval);
          canvas.style.transform = originalTransform;
        }
      }, 50);
    }
  </script>
</body>
</html>`;
