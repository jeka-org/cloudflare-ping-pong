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

interface PlayerInfo {
  ws: WebSocket;
  slot: 1 | 2 | null; // null = spectator
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
  phase: 'waiting' | 'countdown' | 'playing' | 'scored' | 'finished';
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
  private aiDifficulty: number = 0.7; // 0-1, how fast AI reacts
  
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
    
    // Check if AI opponent requested
    const url = new URL(request.url);
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
    
    // Send role assignment
    this.send(server, {
      type: 'role',
      role: playerInfo.slot ? `player${playerInfo.slot}` : 'spectator',
      slot: playerInfo.slot,
    });
    
    // If we now have 2 players, start countdown
    if (!player1 && player2 && playerInfo.slot === 1) {
      this.startCountdown();
    } else if (player1 && !player2 && playerInfo.slot === 2) {
      this.startCountdown();
    }
    
    // If AI mode and first player just connected, start immediately
    if (this.aiEnabled && playerInfo.slot === 1 && !player2) {
      this.send(server, {
        type: 'ai_opponent',
        difficulty: this.aiDifficulty,
      });
      this.startCountdown();
    }
    
    // Save player connection to SQLite
    await this.savePlayerConnection(playerInfo);
    
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
      const targetY = ball.y;
      const currentY = this.gameState.paddle2;
      const diff = targetY - currentY;
      // AI tracks the ball with some imperfection based on difficulty
      const speed = 0.02 * this.aiDifficulty;
      // Add slight randomness so AI isn't perfect
      const jitter = (Math.random() - 0.5) * 0.01 * (1 - this.aiDifficulty);
      if (Math.abs(diff) > 0.02) {
        this.gameState.paddle2 = Math.max(0.075, Math.min(0.925,
          currentY + Math.sign(diff) * speed + jitter
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
        
        // Save results
        this.ctx.waitUntil(this.saveGameResults());
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
      
      // Save rallies
      for (const rally of this.rallies) {
        sql.exec(
          `INSERT INTO rallies (started_at, ended_at, hits, winner_slot) VALUES (?, ?, ?, ?)`,
          rally.started_at,
          rally.ended_at,
          rally.hits,
          rally.winner_slot || 0
        );
      }
      
      // Save final game state
      const gameData = JSON.stringify({
        score1: this.gameState.score1,
        score2: this.gameState.score2,
        rallies: this.rallies.length,
        longestRally: Math.max(...this.rallies.map((r) => r.hits), 0),
        duration: this.gameStartTime ? (Date.now() - this.gameStartTime) / 1000 : 0,
      });
      
      sql.exec(
        `INSERT OR REPLACE INTO game_state (key, value) VALUES ('final_result', ?)`,
        gameData
      );
    } catch (err) {
      console.error('Error saving game results:', err);
    }
  }
}

// Type definitions
interface Env {
  GAME_ROOM: DurableObjectNamespace;
  DB: D1Database;
  HYPERDRIVE: Hyperdrive;
}
