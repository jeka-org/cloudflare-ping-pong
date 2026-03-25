export const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="data:image/png;base64,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">
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
      font-size: clamp(0.9rem, 3vw, 1.5rem);
      max-width: 90vw;
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
    @media (max-width: 480px) {
      h1 { font-size: 1.8rem !important; }
      .subtitle { font-size: 0.8rem; margin-bottom: 1.5rem; }
      .button { font-size: 0.9rem; padding: 0.6rem 1.2rem; width: 100%; max-width: 280px; box-sizing: border-box; }
      .button-secondary { margin-top: 0.4rem; }
      .stats { gap: 1rem; margin-top: 1rem; }
      .stat-value { font-size: 1.5rem; }
      .stat-label { font-size: 0.7rem; }
      .dash-header h2 { font-size: 0.9rem; }
      .card h3 { font-size: 0.75rem; }
      .card { padding: 0.6rem; }
      .lobby-section { padding: 0.8rem; margin: 1rem auto 0.8rem; }
      .lobby-room { padding: 0.6rem 0.8rem; }
      .lobby-room-name { font-size: 0.85rem; }
      .btn-join, .btn-spectate, .btn-secondary { font-size: 0.75rem; padding: 0.4rem 0.8rem; min-height: 44px; }
      .lobby-empty-actions { flex-direction: column; gap: 0.5rem; align-items: center; }
      .lobby-empty-actions .btn-join, .lobby-empty-actions .btn-spectate { width: 100%; max-width: 220px; }
      body { padding: 15px 10px 10px; }
      .footer { font-size: 0.65rem; }
    }
    
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
  <div class="subtitle"><a href="https://github.com/jeka-org/cloudflare-ping-pong" style="color:inherit;text-decoration:none;opacity:0.6">Real-Time Multiplayer on Cloudflare's Edge</a></div>
  
  <button class="button" id="createBtn">CREATE ROOM</button>
  <button class="button button-secondary" id="aiBtn" style="margin-top: 0.5rem;">PLAY VS AI 🤖</button>
  
  <!-- Fix 15: Live Lobby Section - immediately after hero buttons -->
  <div class="lobby-section">
    <div class="dash-header">
      <h2>🏓 ACTIVE GAMES</h2>
    </div>
    
    <div id="lobbyRooms" class="lobby-rooms loading">
      Connecting to lobby...
    </div>
  </div>
  
  <div class="dashboard">
    <div class="dash-header">
      <span class="live-dot"></span>
      <h2>LIVE DASHBOARD</h2>
      <a href="https://hyperdrive.jeka.org" style="opacity:0.4;font-size:0.75rem;margin-left:0.5rem;color:#f97316;text-decoration:none">Hyperdrive + Postgres</a>
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
        const wn = m.winner_name || ('Player ' + (e.player_slot||'?'));
        detail = wn + ' wins | ' + (m.score1||0) + '-' + (m.score2||0) + (m.duration_seconds ? ' | ' + m.duration_seconds + 's' : '');
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
        var el;
        el = document.getElementById('totalGames'); if (el) el.textContent = data.stats.total_games;
        el = document.getElementById('activeGames'); if (el) el.textContent = data.stats.active_games;
        el = document.getElementById('totalPlayers'); if (el) el.textContent = data.stats.total_players;
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
          setHTML(totEl, '<div style="display:flex;gap:2rem;justify-content:center;flex-wrap:wrap">' +
            '<div style="text-align:center"><div style="font-size:2rem;color:#f97316">' + (data.totals.total||0) + '</div><div style="font-size:0.75rem;opacity:0.5">Events</div></div>' +
            '<div style="text-align:center"><div style="font-size:2rem;color:#fbbf24">' + (data.totals.rooms||0) + '</div><div style="font-size:0.75rem;opacity:0.5">Rooms</div></div>' +
            '<div style="text-align:center"><div style="font-size:2rem;color:#f97316" id="totalGames">--</div><div style="font-size:0.75rem;opacity:0.5">Games</div></div>' +
            '<div style="text-align:center"><div style="font-size:2rem;color:#22c55e" id="activeGames">--</div><div style="font-size:0.75rem;opacity:0.5">Active</div></div>' +
            '<div style="text-align:center"><div style="font-size:2rem;color:#fbbf24" id="totalPlayers">--</div><div style="font-size:0.75rem;opacity:0.5">Players</div></div>' +
            '</div>');
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
