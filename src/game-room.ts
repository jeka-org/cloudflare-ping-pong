// GameRoom Durable Object - manages one game room with WebSocket connections and authoritative physics

import { DurableObject } from 'cloudflare:workers';
import {
  Ball,
  Paddle,
  updateBall,
  checkWallBounce,
  checkPaddleCollision,
  checkScore,
  resetBall,
  createPaddle,
} from './physics';
import { saveGameResults as saveGameResultsD1, updateRoomPlaying } from './d1-queries';
import { generatePlayerName } from './room-names';

interface PlayerInfo {
  ws: WebSocket;
  slot: 1 | 2 | null; // null = spectator
  name: string;
  colo: string | null;
  city: string | null;
  country: string | null;
  latency: number | null;
  connectedAt: string;
}

interface GameState {
  ball: Ball;
  paddle1: number; // y position
  paddle2: number; // y position
  score1: number;
  score2: number;
  phase: 'waiting' | 'ready' | 'countdown' | 'playing' | 'scored' | 'finished';
  countdownValue: number;
  rallyHits: number;
  currentRallyStart: number | null;
}

interface RallyStats {
  started_at: string;
  ended_at: string;
  hits: number;
  winner_slot: number | null;
}

export class GameRoom extends DurableObject {
  private players: Map<WebSocket, PlayerInfo> = new Map();
  private gameState: GameState;
  private gameLoopInterval: number | null = null;
  private lastTickTime: number = Date.now();
  private tickRate = 1000 / 60; // 60fps physics
  private broadcastCounter = 0; // only broadcast every other tick (30fps network)
  private rallies: RallyStats[] = [];
  private gameStartTime: number | null = null;
  private aiEnabled: boolean = false;
  private aiDifficulty: number = 0.5; // 0-1, how fast AI reacts
  private aiTargetY: number = 0.5; // where AI thinks ball will be
  private aiReactionTimer: number = 0; // frames until AI recalculates
  private aiMistakeOffset: number = 0; // deliberate error
  private roomId: string | null = null;
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    
    // Initialize game state
    this.gameState = {
      ball: resetBall(),
      paddle1: 0.5,
      paddle2: 0.5,
      score1: 0,
      score2: 0,
      phase: 'waiting',
      countdownValue: 3,
      rallyHits: 0,
      currentRallyStart: null,
    };
    
    // Load persisted state from SQLite if exists
    this.ctx.blockConcurrencyWhile(async () => {
      await this.loadState();
    });
  }
  
  async fetch(request: Request): Promise<Response> {
    // Upgrade HTTP to WebSocket
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    
    // Capture room ID from URL
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    this.roomId = pathParts[2] || null;
    
    // Check if AI opponent requested
    if (url.searchParams.get('ai') === 'true') {
      this.aiEnabled = true;
      const diff = url.searchParams.get('difficulty');
      if (diff) this.aiDifficulty = Math.max(0.3, Math.min(1.0, parseFloat(diff)));
    }
    
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    // Accept the WebSocket connection
    this.ctx.acceptWebSocket(server);
    
    // Store player info
    const cf = request.cf;
    const playerInfo: PlayerInfo = {
      ws: server,
      slot: null, // will assign below
      name: generatePlayerName(),
      colo: (cf?.colo as string) || null,
      city: (cf?.city as string) || null,
      country: (cf?.country as string) || null,
      latency: null,
      connectedAt: new Date().toISOString(),
    };
    
    // Assign player slot
    const existingPlayers = Array.from(this.players.values());
    const player1 = existingPlayers.find((p) => p.slot === 1);
    const player2 = existingPlayers.find((p) => p.slot === 2);
    
    if (!player1) {
      playerInfo.slot = 1;
    } else if (!player2) {
      playerInfo.slot = 2;
    } else {
      playerInfo.slot = null; // spectator
    }
    
    this.players.set(server, playerInfo);
    
    // Send role assignment with player name
    this.send(server, {
      type: 'role',
      role: playerInfo.slot ? `player${playerInfo.slot}` : 'spectator',
      slot: playerInfo.slot,
      name: playerInfo.name,
    });
    
    // If we now have 2 players, set ready and let them start
    if ((!player1 && player2 && playerInfo.slot === 1) ||
        (player1 && !player2 && playerInfo.slot === 2)) {
      this.gameState.phase = 'ready';
      const allPlayers = Array.from(this.players.values());
      const pp1 = allPlayers.find(p => p.slot === 1);
      const pp2 = allPlayers.find(p => p.slot === 2);
      this.broadcast({ 
        type: 'ready', 
        message: 'Both players connected! Press START',
        player1Name: pp1?.name || 'Player 1',
        player2Name: pp2?.name || 'Player 2',
      });
    } else if (playerInfo.slot && !this.aiEnabled) {
      // Only one player so far
      this.send(server, { type: 'waiting', message: 'Waiting for Player 2...' });
    }
    
    // If AI mode and first player just connected, start immediately
    if (this.aiEnabled && playerInfo.slot === 1 && !player2) {
      this.send(server, {
        type: 'ai_opponent',
        difficulty: this.aiDifficulty,
        aiName: 'AI 🤖',
      });
      this.startCountdown();
    }
    
    // Save player connection to SQLite
    await this.savePlayerConnection(playerInfo);
    
    // Log analytics
    this.logEvent('player_joined', playerInfo.slot, playerInfo, { name: playerInfo.name });
    
    // Broadcast current state
    this.broadcastState();
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
  
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      if (typeof message !== 'string') return;
      
      const data = JSON.parse(message);
      const player = this.players.get(ws);
      
      if (!player) return;
      
      switch (data.type) {
        case 'paddle':
          // Update paddle position for this player
          if (player.slot === 1) {
            this.gameState.paddle1 = Math.max(0.075, Math.min(0.925, data.y));
          } else if (player.slot === 2) {
            this.gameState.paddle2 = Math.max(0.075, Math.min(0.925, data.y));
          }
          break;
          
        case 'start_game':
          // Any player can request game start
          if (player.slot && this.gameState.phase === 'ready') {
            this.startCountdown();
          }
          break;
          
        case 'ping':
          // Respond with pong for latency measurement
          this.send(ws, { type: 'pong', timestamp: data.timestamp });
          break;
          
        case 'pong':
          // Calculate latency
          if (data.timestamp) {
            player.latency = Date.now() - data.timestamp;
          }
          break;
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  }
  
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const player = this.players.get(ws);
    this.players.delete(ws);
    
    // If a player (not spectator) disconnects, end the game
    if (player?.slot) {
      this.gameState.phase = 'finished';
      this.stopGameLoop();
      
      // Broadcast game ended
      this.broadcast({
        type: 'game_ended',
        reason: 'player_disconnected',
        disconnectedPlayer: player.slot,
      });
      
      // Save game results
      await this.saveGameResults();
      
      // Set alarm to clean up room in 30 minutes
      await this.ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000);
    }
  }
  
  async alarm() {
    // Room expired - clean up
    console.log('Room alarm triggered - cleaning up');
    
    // Close all connections
    for (const ws of this.players.keys()) {
      ws.close(1000, 'Room expired');
    }
    
    this.players.clear();
    this.stopGameLoop();
    
    // Clear storage
    await this.ctx.storage.deleteAll();
  }
  
  // Game loop - runs at 60fps
  private startGameLoop() {
    if (this.gameLoopInterval !== null) return;
    
    this.lastTickTime = Date.now();
    this.gameStartTime = Date.now();
    
    this.gameLoopInterval = setInterval(() => {
      this.gameTick();
    }, this.tickRate) as unknown as number;
  }
  
  private stopGameLoop() {
    if (this.gameLoopInterval !== null) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
  }
  
  private gameTick() {
    if (this.gameState.phase !== 'playing' && this.gameState.phase !== 'scored') return;
    if (this.gameState.phase === 'scored') {
      // During scored pause, still broadcast state but skip physics
      this.broadcastCounter++;
      if (this.broadcastCounter % 2 === 0) this.broadcastState();
      return;
    }
    
    // AI paddle movement (if enabled, AI is always player 2)
    if (this.aiEnabled) {
      const ball = this.gameState.ball;
      const currentY = this.gameState.paddle2;
      
      // AI only recalculates target periodically (simulates reaction time)
      this.aiReactionTimer--;
      if (this.aiReactionTimer <= 0) {
        // Reset reaction timer: lower difficulty = slower reactions
        this.aiReactionTimer = Math.floor(8 + (1 - this.aiDifficulty) * 15);
        
        // AI predicts ball position but with error
        this.aiTargetY = ball.y;
        
        // Add deliberate mistake: AI sometimes aims wrong
        // Bigger mistakes at lower difficulty
        const mistakeChance = 0.15 * (1 - this.aiDifficulty);
        if (Math.random() < mistakeChance) {
          this.aiMistakeOffset = (Math.random() - 0.5) * 0.3;
        } else {
          this.aiMistakeOffset = (Math.random() - 0.5) * 0.08;
        }
        
        // AI only reacts well when ball is coming toward it (x velocity > 0)
        if (ball.vx < 0) {
          // Ball going away: AI drifts toward center lazily
          this.aiTargetY = 0.5 + (Math.random() - 0.5) * 0.2;
        }
      }
      
      const target = this.aiTargetY + this.aiMistakeOffset;
      const diff = target - currentY;
      // Speed: lower difficulty = slower paddle
      const speed = 0.008 + 0.012 * this.aiDifficulty;
      
      if (Math.abs(diff) > 0.03) {
        this.gameState.paddle2 = Math.max(0.075, Math.min(0.925,
          currentY + Math.sign(diff) * speed
        ));
      }
    }
    
    // Update ball position
    let ball = updateBall(this.gameState.ball);
    
    // Check wall bounces
    ball = checkWallBounce(ball);
    
    // Check paddle collisions
    const leftPaddleCheck = checkPaddleCollision(ball, this.gameState.paddle1, 'left');
    if (leftPaddleCheck.hit) {
      ball = leftPaddleCheck.ball;
      this.gameState.rallyHits++;
    }
    
    const rightPaddleCheck = checkPaddleCollision(ball, this.gameState.paddle2, 'right');
    if (rightPaddleCheck.hit) {
      ball = rightPaddleCheck.ball;
      this.gameState.rallyHits++;
    }
    
    // Check scoring
    const scoreCheck = checkScore(ball);
    if (scoreCheck.scored && scoreCheck.scorer) {
      // Someone scored!
      if (scoreCheck.scorer === 1) {
        this.gameState.score1++;
      } else {
        this.gameState.score2++;
      }
      
      // Record rally
      if (this.gameState.currentRallyStart !== null) {
        this.rallies.push({
          started_at: new Date(this.gameState.currentRallyStart).toISOString(),
          ended_at: new Date().toISOString(),
          hits: this.gameState.rallyHits,
          winner_slot: scoreCheck.scorer,
        });
      }
      
      // Broadcast score event
      this.broadcast({
        type: 'score',
        scorer: scoreCheck.scorer,
        score1: this.gameState.score1,
        score2: this.gameState.score2,
        rallyHits: this.gameState.rallyHits,
      });
      
      // Log to analytics
      this.logEvent('point_scored', scoreCheck.scorer, null, {
        score1: this.gameState.score1,
        score2: this.gameState.score2,
        rally_hits: this.gameState.rallyHits,
      });
      
      // Check for game over (first to 5)
      if (this.gameState.score1 >= 5 || this.gameState.score2 >= 5) {
        this.gameState.phase = 'finished';
        this.stopGameLoop();
        
        this.broadcast({
          type: 'game_over',
          winner: this.gameState.score1 >= 5 ? 1 : 2,
          score1: this.gameState.score1,
          score2: this.gameState.score2,
          rallies: this.rallies,
        });
        
        // Save results + analytics
        this.ctx.waitUntil(this.saveGameResults());
        this.logEvent('game_over', this.gameState.score1 >= 5 ? 1 : 2, null, {
          score1: this.gameState.score1,
          score2: this.gameState.score2,
          rallies: this.rallies.length,
          duration_seconds: this.gameStartTime ? Math.round((Date.now() - this.gameStartTime) / 1000) : 0,
        });
        return;
      }
      
      // Reset for next point
      this.gameState.phase = 'scored';
      this.gameState.ball = resetBall(scoreCheck.scorer === 1 ? 2 : 1);
      this.gameState.rallyHits = 0;
      this.gameState.currentRallyStart = null;
      
      // Short pause, then resume
      setTimeout(() => {
        if (this.gameState.phase === 'scored') {
          this.gameState.phase = 'playing';
          this.gameState.currentRallyStart = Date.now();
        }
      }, 1000);
    } else {
      // Update ball
      this.gameState.ball = ball;
    }
    
    // Broadcast state every other tick (30fps network, 60fps physics)
    this.broadcastCounter++;
    if (this.broadcastCounter % 2 === 0) {
      this.broadcastState();
    }
  }
  
  private startCountdown() {
    this.gameState.phase = 'countdown';
    this.gameState.countdownValue = 3;
    
    // Update D1 with player names
    const players = Array.from(this.players.values());
    const p1 = players.find(p => p.slot === 1);
    const p2 = players.find(p => p.slot === 2);
    if (this.roomId) {
      this.ctx.waitUntil(
        updateRoomPlaying(
          this.env.DB,
          this.roomId,
          p1?.colo || null, p1?.city || null, p1?.name || null,
          p2?.colo || null, p2?.city || null, this.aiEnabled ? 'AI 🤖' : (p2?.name || null)
        ).catch(err => console.error('D1 update error:', err))
      );
    }
    
    const countdownInterval = setInterval(() => {
      if (this.gameState.countdownValue > 0) {
        this.broadcast({
          type: 'countdown',
          value: this.gameState.countdownValue,
        });
        this.gameState.countdownValue--;
      } else {
        clearInterval(countdownInterval);
        this.gameState.phase = 'playing';
        this.gameState.currentRallyStart = Date.now();
        this.broadcast({
          type: 'game_start',
        });
        this.startGameLoop();
      }
    }, 1000);
  }
  
  private broadcastState() {
    const state = {
      type: 'state',
      ball: this.gameState.ball,
      paddle1: this.gameState.paddle1,
      paddle2: this.gameState.paddle2,
      score1: this.gameState.score1,
      score2: this.gameState.score2,
      phase: this.gameState.phase,
    };
    
    this.broadcast(state);
  }
  
  private broadcast(data: any) {
    const message = JSON.stringify(data);
    for (const ws of this.players.keys()) {
      try {
        ws.send(message);
      } catch (err) {
        console.error('Error sending to WebSocket:', err);
      }
    }
  }
  
  private send(ws: WebSocket, data: any) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error('Error sending to WebSocket:', err);
    }
  }
  
  // SQLite persistence
  private async loadState() {
    try {
      const sql = this.ctx.storage.sql;
      
      // Create tables if they don't exist
      sql.exec(`
        CREATE TABLE IF NOT EXISTS game_state (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
      
      sql.exec(`
        CREATE TABLE IF NOT EXISTS players (
          slot INTEGER PRIMARY KEY,
          connected_at TEXT,
          colo TEXT,
          city TEXT,
          country TEXT
        )
      `);
      
      sql.exec(`
        CREATE TABLE IF NOT EXISTS rallies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT,
          ended_at TEXT,
          hits INTEGER,
          winner_slot INTEGER
        )
      `);
      
      // Load rallies
      const rallyRows = sql.exec<{
        started_at: string;
        ended_at: string;
        hits: number;
        winner_slot: number;
      }>('SELECT started_at, ended_at, hits, winner_slot FROM rallies').toArray();
      
      this.rallies = rallyRows;
    } catch (err) {
      console.error('Error loading state from SQLite:', err);
    }
  }
  
  private async savePlayerConnection(player: PlayerInfo) {
    if (!player.slot) return;
    
    try {
      const sql = this.ctx.storage.sql;
      sql.exec(
        `INSERT OR REPLACE INTO players (slot, connected_at, colo, city, country) VALUES (?, ?, ?, ?, ?)`,
        player.slot,
        player.connectedAt,
        player.colo || '',
        player.city || '',
        player.country || ''
      );
    } catch (err) {
      console.error('Error saving player connection:', err);
    }
  }
  
  private async saveGameResults() {
    try {
      const sql = this.ctx.storage.sql;
      
      // Save rallies to DO local storage
      for (const rally of this.rallies) {
        sql.exec(
          `INSERT INTO rallies (started_at, ended_at, hits, winner_slot) VALUES (?, ?, ?, ?)`,
          rally.started_at,
          rally.ended_at,
          rally.hits,
          rally.winner_slot || 0
        );
      }
      
      const longestRally = this.rallies.length > 0 ? Math.max(...this.rallies.map((r) => r.hits)) : 0;
      const duration = this.gameStartTime ? (Date.now() - this.gameStartTime) / 1000 : 0;
      const winnerSlot = this.gameState.score1 >= 5 ? 1 : 2;
      
      // Save final game state to DO local storage
      const gameData = JSON.stringify({
        score1: this.gameState.score1,
        score2: this.gameState.score2,
        rallies: this.rallies.length,
        longestRally,
        duration,
      });
      
      sql.exec(
        `INSERT OR REPLACE INTO game_state (key, value) VALUES ('final_result', ?)`,
        gameData
      );
      
      // Also save to D1 so homepage can show recent games
      if (this.roomId) {
        try {
          await saveGameResultsD1(
            this.env.DB,
            this.roomId,
            winnerSlot,
            this.gameState.score1,
            this.gameState.score2,
            this.rallies.length,
            longestRally,
            Math.round(duration)
          );
        } catch (d1Err) {
          console.error('Error saving to D1:', d1Err);
        }
      }
    } catch (err) {
      console.error('Error saving game results:', err);
    }
  }
  
  // Fire-and-forget analytics event to Postgres via main Worker
  private logEvent(eventType: string, playerSlot: number | null, playerInfo: PlayerInfo | null, metadata: Record<string, any> = {}) {
    const body = JSON.stringify({
      room_id: this.roomId,
      event_type: eventType,
      player_slot: playerSlot,
      colo: playerInfo?.colo || null,
      city: playerInfo?.city || null,
      country: playerInfo?.country || null,
      metadata,
    });
    // Use waitUntil so it doesn't block game logic
    this.ctx.waitUntil(
      fetch('https://pong.jeka.org/api/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal': 'true' },
        body,
      }).catch(err => console.error('Analytics event error:', err))
    );
  }
}

// Type definitions
interface Env {
  GAME_ROOM: DurableObjectNamespace;
  DB: D1Database;
  HYPERDRIVE: Hyperdrive;
}
