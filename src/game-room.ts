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
import { saveGameResults as saveGameResultsD1, updateRoomPlaying, updateRoomStatus, updatePlayerStats } from './d1-queries';
import { generatePlayerName } from './room-names';

// Fix 9: Emoji reaction whitelist
const REACTION_WHITELIST = new Set(['🔥', '👏', '😱', '💀', '😂', '👀', '❤️', '🏓']);

interface PlayerInfo {
  ws: WebSocket;
  slot: 1 | 2 | null; // null = spectator
  role: 'player' | 'spectator';
  name: string;
  colo: string | null;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  latency: number | null;
  connectedAt: string;
  lastReactionTime: number; // Fix 9: rate limit
}

interface GameState {
  ball: Ball;
  paddle1: number; // y position
  paddle2: number; // y position
  score1: number;
  score2: number;
  phase: 'waiting' | 'ready' | 'countdown' | 'playing' | 'scored' | 'finished' | 'paused';
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

export class GameRoom extends DurableObject<Env> {
  private players: Map<WebSocket, PlayerInfo> = new Map();
  private gameState: GameState;
  private gameLoopInterval: number | null = null;
  private lastTickTime: number = Date.now();
  private tickRate = 1000 / 60; // 60fps physics
  private broadcastCounter = 0; // only broadcast every other tick (30fps network)
  private rallies: RallyStats[] = [];
  private gameStartTime: number | null = null;
  private aiEnabled: boolean = false;
  private aiDifficulty: number = 0.5;
  private aiTargetY: number = 0.5;
  private aiReactionTimer: number = 0;
  private aiMistakeOffset: number = 0;
  private roomId: string | null = null;
  
  // Fix 2: Heartbeat interval
  private heartbeatInterval: number | null = null;
  
  // Fix 3: Reconnection support
  private disconnectedSlot: 1 | 2 | null = null;
  private disconnectedSlotName: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCountdownInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectSecondsLeft: number = 0;
  
  // Fix 6: End reason tracking
  private endReason: 'completed' | 'disconnected' | 'abandoned' | null = null;
  
  // Fix 12: Double-save guard
  private resultsSaved = false;
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    
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
    
    this.ctx.blockConcurrencyWhile(async () => {
      await this.loadState();
    });
  }
  
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    this.roomId = pathParts[2] || null;
    
    // Fix 5: Reject WebSocket to terminal-state rooms
    const terminalStates = ['finished', 'disconnected', 'abandoned'];
    if (terminalStates.includes(this.gameState.phase)) {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      this.ctx.acceptWebSocket(server);
      this.send(server, { type: 'room_closed', reason: 'This game has ended.' });
      server.close(1000, 'Room in terminal state');
      return new Response(null, { status: 101, webSocket: client });
    }
    
    // Check if AI opponent requested
    if (url.searchParams.get('ai') === 'true') {
      this.aiEnabled = true;
      const diff = url.searchParams.get('difficulty');
      if (diff) this.aiDifficulty = Math.max(0.3, Math.min(1.0, parseFloat(diff)));
    }
    
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    this.ctx.acceptWebSocket(server);
    
    const cf = request.cf;
    const playerInfo: PlayerInfo = {
      ws: server,
      slot: null,
      role: 'spectator',
      name: generatePlayerName(),
      colo: (cf?.colo as string) || null,
      city: (cf?.city as string) || null,
      country: (cf?.country as string) || null,
      latitude: parseFloat(cf?.latitude as string) || null,
      longitude: parseFloat(cf?.longitude as string) || null,
      latency: null,
      connectedAt: new Date().toISOString(),
      lastReactionTime: 0,
    };
    
    // Assign player slot
    const existingPlayers = Array.from(this.players.values());
    const player1 = existingPlayers.find((p) => p.slot === 1);
    const player2 = existingPlayers.find((p) => p.slot === 2);
    
    // Fix 3: Check if this connection is a reconnect during grace period
    if (this.disconnectedSlot && !this.isSlotOccupied(this.disconnectedSlot)) {
      // Reconnecting player gets the disconnected slot
      playerInfo.slot = this.disconnectedSlot;
      playerInfo.role = 'player';
      // Preserve original slot name (Fix 3: slot name preservation)
      if (this.disconnectedSlotName) {
        playerInfo.name = this.disconnectedSlotName;
      }
      
      // Clear reconnect timers
      this.clearReconnectTimers();
      this.disconnectedSlot = null;
      this.disconnectedSlotName = null;
      
      this.players.set(server, playerInfo);
      
      // Send role assignment
      this.send(server, {
        type: 'role',
        role: `player${playerInfo.slot}`,
        slot: playerInfo.slot,
        name: playerInfo.name,
      });
      
      // Resume game: broadcast reconnect, then 3-2-1 countdown
      this.broadcast({
        type: 'player_reconnected',
        slot: playerInfo.slot,
        name: playerInfo.name,
      });
      
      // Resume with countdown
      this.startResumeCountdown();
      
      await this.savePlayerConnection(playerInfo);
      this.logEvent('player_reconnected', playerInfo.slot, playerInfo, { name: playerInfo.name });
      this.broadcastState();
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    if (!player1) {
      playerInfo.slot = 1;
      playerInfo.role = 'player';
    } else if (!player2 && !this.aiEnabled) {
      playerInfo.slot = 2;
      playerInfo.role = 'player';
    } else {
      playerInfo.slot = null;
      playerInfo.role = 'spectator';
    }
    
    this.players.set(server, playerInfo);
    
    // Send role assignment
    this.send(server, {
      type: 'role',
      role: playerInfo.role === 'player' ? `player${playerInfo.slot}` : 'spectator',
      slot: playerInfo.slot,
      name: playerInfo.name,
    });
    
    // Update spectator count and notify lobby
    if (playerInfo.role === 'spectator') {
      this.notifyLobbySpectatorCount();
      
      // Fix 13: If AI game, send spectator info
      if (this.aiEnabled) {
        this.send(server, { type: 'spectator_info', message: 'Watching AI game' });
      }
      
      // Fix 3: If game is paused, send pause state to new spectator
      if (this.gameState.phase === 'paused' && this.disconnectedSlot) {
        this.send(server, {
          type: 'game_paused',
          disconnectedSlot: this.disconnectedSlot,
          remainingSeconds: this.reconnectSecondsLeft,
          score1: this.gameState.score1,
          score2: this.gameState.score2,
        });
      }
    }
    
    // Fix 2: Start heartbeat on first player connect
    if (playerInfo.slot === 1 && !this.heartbeatInterval) {
      this.startHeartbeat();
    }
    
    // If we now have 2 players, set ready
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
      
      // Notify lobby: transition to ready
      this.notifyLobbyUpdate({
        status: 'ready',
        player2Name: pp2?.name || null,
        player2Colo: pp2?.colo || null,
        player2City: pp2?.city || null,
      });
    } else if (playerInfo.slot && !this.aiEnabled) {
      this.send(server, { type: 'waiting', message: 'Waiting for Player 2...' });
      
      // Register with lobby (waiting state)
      if (playerInfo.slot === 1) {
        this.notifyLobbyRegister();
        
        // Fix 16: Set 10-minute waiting room expiry alarm
        await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
      }
    }
    
    // Fix 4: AI games register as 'playing' immediately
    if (this.aiEnabled && playerInfo.slot === 1 && !player2) {
      this.send(server, {
        type: 'ai_opponent',
        difficulty: this.aiDifficulty,
        aiName: 'AI 🤖',
      });
      // Start countdown first, THEN register with lobby as 'playing'
      this.startCountdown();
      // Register after startCountdown so lobby sees 'playing' status
      this.notifyLobbyRegisterAsPlaying();
    }
    
    await this.savePlayerConnection(playerInfo);
    this.logEvent('player_joined', playerInfo.slot, playerInfo, { name: playerInfo.name });
    this.broadcastState();
    
    return new Response(null, { status: 101, webSocket: client });
  }
  
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      if (typeof message !== 'string') return;
      
      const data = JSON.parse(message);
      const player = this.players.get(ws);
      
      if (!player) return;
      
      // Spectators can only send reactions
      if (player.role === 'spectator') {
        if (data.type === 'reaction') {
          // Fix 9: Server-side validation
          if (!REACTION_WHITELIST.has(data.emoji)) return;
          
          // Fix 9: Rate limit - max 1 per 2 seconds per connection
          const now = Date.now();
          if (now - player.lastReactionTime < 2000) return;
          player.lastReactionTime = now;
          
          this.broadcast({
            type: 'reaction',
            emoji: data.emoji,
            from: player.name,
          });
        }
        return;
      }
      
      // Player-only actions
      switch (data.type) {
        case 'paddle':
          if (player.slot === 1) {
            this.gameState.paddle1 = Math.max(0.075, Math.min(0.925, data.y));
          } else if (player.slot === 2) {
            this.gameState.paddle2 = Math.max(0.075, Math.min(0.925, data.y));
          }
          break;
          
        case 'start_game':
          if (player.slot && this.gameState.phase === 'ready') {
            this.startCountdown();
          }
          break;
          
        case 'ping':
          this.send(ws, { type: 'pong', timestamp: data.timestamp });
          break;
          
        case 'pong':
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
    
    if (player?.slot) {
      // Fix 3: Check if game is in a playable state for grace period
      const playablePhases = ['playing', 'scored', 'countdown', 'paused'];
      
      if (playablePhases.includes(this.gameState.phase)) {
        // Check if both players are now disconnected
        const remainingPlayers = Array.from(this.players.values()).filter(p => p.slot !== null);
        
        if (remainingPlayers.length === 0 && !this.aiEnabled) {
          // Both players disconnected - immediate end (Fix 3)
          await this.endGame('abandoned');
          return;
        }
        
        // Check if we're already in a pause state (other player already disconnected)
        if (this.disconnectedSlot) {
          // Second player also disconnected during grace - end immediately
          this.clearReconnectTimers();
          await this.endGame('abandoned');
          return;
        }
        
        // Start grace period (Fix 3)
        this.disconnectedSlot = player.slot;
        this.disconnectedSlotName = player.name;
        this.gameState.phase = 'paused';
        this.reconnectSecondsLeft = 15;
        
        // Broadcast disconnection to all connections
        this.broadcast({
          type: 'player_disconnected',
          slot: player.slot,
          timeout: 15,
          name: player.name,
        });
        
        // Start countdown timer (broadcasts remaining time)
        this.reconnectCountdownInterval = setInterval(() => {
          this.reconnectSecondsLeft--;
          if (this.reconnectSecondsLeft <= 0) {
            this.clearReconnectTimers();
          }
          // Keep broadcasting frozen state during pause
          this.broadcastState();
        }, 1000);
        
        // Set 15-second reconnect timeout
        const disconnectedSlotForTimer = player.slot!;
        this.reconnectTimer = setTimeout(async () => {
          this.clearReconnectTimers();
          // Grace period expired
          const hasScore = this.gameState.score1 > 0 || this.gameState.score2 > 0;
          if (hasScore) {
            await this.endGame('disconnected', disconnectedSlotForTimer);
          } else {
            await this.endGame('abandoned');
          }
        }, 15000);
        
        return;
      }
      
      // Game not in playable state - handle based on phase
      if (this.gameState.phase === 'waiting' || this.gameState.phase === 'ready') {
        // Player left before game started
        await this.endGame('abandoned');
        return;
      }
      
      // Already finished or other terminal state
      if (this.gameState.phase === 'finished') {
        // Nothing to do, game already ended
        return;
      }
    } else if (player?.role === 'spectator') {
      this.notifyLobbySpectatorCount();
    }
  }
  
  async alarm() {
    // Fix 16: Waiting room expiry
    if (this.gameState.phase === 'waiting') {
      console.log('Waiting room expired after 10 minutes');
      
      // Update D1 status to expired
      if (this.roomId) {
        await updateRoomStatus(this.env.DB, this.roomId, 'expired').catch(err =>
          console.error('D1 expire error:', err)
        );
      }
      
      // Notify all connections
      this.broadcast({ type: 'room_closed', reason: 'Room expired - no opponent joined in 10 minutes.' });
      
      // Close all connections
      for (const ws of this.players.keys()) {
        ws.close(1000, 'Room expired');
      }
      this.players.clear();
      
      this.cleanup();
      this.notifyLobbyUnregister();
      
      await this.ctx.storage.deleteAll();
      return;
    }
    
    // Fix 16: Reschedule for active games (30 min cleanup)
    if (['playing', 'paused', 'countdown', 'ready'].includes(this.gameState.phase)) {
      await this.ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000);
      return;
    }
    
    // Terminal state - clean up room entirely
    console.log('Room alarm triggered - cleaning up');
    for (const ws of this.players.keys()) {
      ws.close(1000, 'Room expired');
    }
    this.players.clear();
    this.cleanup();
    await this.ctx.storage.deleteAll();
  }
  
  // Fix 2: Start heartbeat
  private startHeartbeat() {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      this.callLobby('/heartbeat', { roomId: this.roomId }).catch(err =>
        console.error('Heartbeat error:', err)
      );
    }, 30000) as unknown as number;
  }
  
  // Fix 2: Cleanup method - called by all game-end paths
  private cleanup() {
    this.stopGameLoop();
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.clearReconnectTimers();
  }
  
  // Fix 3: Clear reconnect timers
  private clearReconnectTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectCountdownInterval) {
      clearInterval(this.reconnectCountdownInterval);
      this.reconnectCountdownInterval = null;
    }
  }
  
  // Fix 3: Check if a slot is currently occupied
  private isSlotOccupied(slot: 1 | 2): boolean {
    for (const p of this.players.values()) {
      if (p.slot === slot) return true;
    }
    return false;
  }
  
  // Fix 3: Resume game after reconnection with 3-2-1 countdown
  private startResumeCountdown() {
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
        this.broadcast({ type: 'game_start' });
        // Game loop should already be running; if not, restart it
        if (!this.gameLoopInterval) {
          this.startGameLoop();
        }
      }
    }, 1000);
  }
  
  /**
   * Unified game-end handler. All 7 game-end paths go through here.
   * Every path calls: notifyLobbyUnregister() + D1 status update + cleanup()
   */
  private async endGame(reason: 'completed' | 'disconnected' | 'abandoned', disconnectedPlayerSlot?: number) {
    this.endReason = reason;
    this.gameState.phase = 'finished';
    this.cleanup();
    
    const hasScore = this.gameState.score1 > 0 || this.gameState.score2 > 0;
    const longestRally = this.rallies.length > 0 ? Math.max(...this.rallies.map(r => r.hits)) : 0;
    const duration = this.gameStartTime ? Math.round((Date.now() - this.gameStartTime) / 1000) : 0;
    
    if (reason === 'completed') {
      // Fix 1: First to 5
      const winnerSlot = this.gameState.score1 >= 3 ? 1 : 2;
      
      this.broadcast({
        type: 'game_over',
        winner: winnerSlot,
        score1: this.gameState.score1,
        score2: this.gameState.score2,
        rallies: this.rallies,
      });
      
      // Fix 12: Save results with guard
      await this.saveGameResults(winnerSlot, 'finished');
      
      // Fix 7: Update leaderboard
      await this.updateLeaderboard(winnerSlot, longestRally);
      
    } else if (reason === 'disconnected' && hasScore) {
      // Fix 6: Has score + disconnect → winner is remaining player
      const winnerSlot = disconnectedPlayerSlot === 1 ? 2 : 1;
      
      this.broadcast({
        type: 'game_over',
        winner: winnerSlot,
        score1: this.gameState.score1,
        score2: this.gameState.score2,
        reason: 'opponent_disconnected',
        rallies: this.rallies,
      });
      
      await this.saveGameResults(winnerSlot, 'disconnected');
      
      // Fix 7: Update leaderboard for disconnect wins too
      await this.updateLeaderboard(winnerSlot, longestRally);
      
    } else {
      // Abandoned: no score + disconnect, or both disconnect
      this.broadcast({
        type: 'game_ended',
        reason: 'abandoned',
      });
      
      // Fix 6: Don't save game results for abandoned, just update D1 status
      if (this.roomId) {
        await updateRoomStatus(this.env.DB, this.roomId, 'abandoned').catch(err =>
          console.error('D1 abandon error:', err)
        );
      }
    }
    
    // Every game-end path: unregister from lobby
    this.notifyLobbyUnregister();
    
    // Log analytics
    this.logEvent('game_over', null, null, {
      reason,
      score1: this.gameState.score1,
      score2: this.gameState.score2,
      rallies: this.rallies.length,
      duration_seconds: duration,
    });
    
    // Set alarm to clean up room data in 30 minutes
    await this.ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000);
  }
  
  // Fix 7: Update leaderboard, excluding AI
  private async updateLeaderboard(winnerSlot: number, longestRally: number) {
    const players = Array.from(this.players.values());
    const p1 = players.find(p => p.slot === 1);
    const p2 = players.find(p => p.slot === 2);
    
    // Get names from current players or from disconnected slot name
    const p1Name = p1?.name || (this.disconnectedSlotName && this.disconnectedSlot === 1 ? this.disconnectedSlotName : 'Player 1');
    const p2Name = this.aiEnabled ? 'AI 🤖' : (p2?.name || (this.disconnectedSlotName && this.disconnectedSlot === 2 ? this.disconnectedSlotName : 'Player 2'));
    
    try {
      // Player 1 stats (always human)
      if (p1Name && p1Name !== 'Player 1') {
        await updatePlayerStats(this.env.DB, p1Name, winnerSlot === 1, longestRally);
      }
      
      // Player 2 stats (only if human, not AI - Fix 7)
      if (!this.aiEnabled && p2Name && p2Name !== 'Player 2') {
        await updatePlayerStats(this.env.DB, p2Name, winnerSlot === 2, longestRally);
      }
    } catch (err) {
      console.error('Leaderboard update error:', err);
    }
  }
  
  // Game loop
  private startGameLoop() {
    if (this.gameLoopInterval !== null) return;
    
    this.lastTickTime = Date.now();
    this.gameStartTime = this.gameStartTime || Date.now();
    
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
    // Fix 3: During pause, keep broadcasting frozen state but skip physics
    if (this.gameState.phase === 'paused') {
      this.broadcastCounter++;
      if (this.broadcastCounter % 2 === 0) this.broadcastState();
      return;
    }
    
    if (this.gameState.phase !== 'playing' && this.gameState.phase !== 'scored') return;
    if (this.gameState.phase === 'scored') {
      this.broadcastCounter++;
      if (this.broadcastCounter % 2 === 0) this.broadcastState();
      return;
    }
    
    // AI paddle movement
    if (this.aiEnabled) {
      const ball = this.gameState.ball;
      const currentY = this.gameState.paddle2;
      
      this.aiReactionTimer--;
      if (this.aiReactionTimer <= 0) {
        this.aiReactionTimer = Math.floor(8 + (1 - this.aiDifficulty) * 15);
        this.aiTargetY = ball.y;
        
        const mistakeChance = 0.15 * (1 - this.aiDifficulty);
        if (Math.random() < mistakeChance) {
          this.aiMistakeOffset = (Math.random() - 0.5) * 0.3;
        } else {
          this.aiMistakeOffset = (Math.random() - 0.5) * 0.08;
        }
        
        if (ball.vx < 0) {
          this.aiTargetY = 0.5 + (Math.random() - 0.5) * 0.2;
        }
      }
      
      const target = this.aiTargetY + this.aiMistakeOffset;
      const diff = target - currentY;
      const speed = 0.008 + 0.012 * this.aiDifficulty;
      
      if (Math.abs(diff) > 0.03) {
        this.gameState.paddle2 = Math.max(0.075, Math.min(0.925,
          currentY + Math.sign(diff) * speed
        ));
      }
    }
    
    // Update ball position
    let ball = updateBall(this.gameState.ball);
    ball = checkWallBounce(ball);
    
    const leftPaddleCheck = checkPaddleCollision(ball, this.gameState.paddle1, 'left');
    if (leftPaddleCheck.hit) {
      ball = leftPaddleCheck.ball;
      this.gameState.rallyHits++;
      this.broadcast({ type: 'hit', side: 'left', y: this.gameState.paddle1, rally: this.gameState.rallyHits });
    }
    
    const rightPaddleCheck = checkPaddleCollision(ball, this.gameState.paddle2, 'right');
    if (rightPaddleCheck.hit) {
      ball = rightPaddleCheck.ball;
      this.gameState.rallyHits++;
      this.broadcast({ type: 'hit', side: 'right', y: this.gameState.paddle2, rally: this.gameState.rallyHits });
    }
    
    const scoreCheck = checkScore(ball);
    if (scoreCheck.scored && scoreCheck.scorer) {
      if (scoreCheck.scorer === 1) {
        this.gameState.score1++;
      } else {
        this.gameState.score2++;
      }
      
      if (this.gameState.currentRallyStart !== null) {
        this.rallies.push({
          started_at: new Date(this.gameState.currentRallyStart).toISOString(),
          ended_at: new Date().toISOString(),
          hits: this.gameState.rallyHits,
          winner_slot: scoreCheck.scorer,
        });
      }
      
      this.broadcast({
        type: 'score',
        scorer: scoreCheck.scorer,
        score1: this.gameState.score1,
        score2: this.gameState.score2,
        rallyHits: this.gameState.rallyHits,
      });
      
      this.notifyLobbyUpdate({
        score: [this.gameState.score1, this.gameState.score2],
      });
      
      this.logEvent('point_scored', scoreCheck.scorer, null, {
        score1: this.gameState.score1,
        score2: this.gameState.score2,
        rally_hits: this.gameState.rallyHits,
      });
      
      // Fix 1: First to 5 points
      if (this.gameState.score1 >= 3 || this.gameState.score2 >= 3) {
        this.ctx.waitUntil(this.endGame('completed'));
        return;
      }
      
      // Reset for next point
      this.gameState.phase = 'scored';
      this.gameState.ball = resetBall(scoreCheck.scorer === 1 ? 2 : 1);
      this.gameState.rallyHits = 0;
      this.gameState.currentRallyStart = null;
      
      setTimeout(() => {
        if (this.gameState.phase === 'scored') {
          this.gameState.phase = 'playing';
          this.gameState.currentRallyStart = Date.now();
        }
      }, 1000);
    } else {
      this.gameState.ball = ball;
    }
    
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
    
    // Notify lobby: game starting (for human games)
    if (!this.aiEnabled) {
      this.notifyLobbyUpdate({
        status: 'playing',
      });
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
    const state: any = {
      type: 'state',
      ball: this.gameState.ball,
      paddle1: this.gameState.paddle1,
      paddle2: this.gameState.paddle2,
      score1: this.gameState.score1,
      score2: this.gameState.score2,
      phase: this.gameState.phase,
      spectatorCount: this.getSpectatorCount(),
    };
    
    // Fix 3: Include pause info in state broadcasts
    if (this.gameState.phase === 'paused' && this.disconnectedSlot) {
      state.disconnectedSlot = this.disconnectedSlot;
      state.remainingSeconds = this.reconnectSecondsLeft;
    }
    
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
  
  // Fix 12: Guard against double saves
  private async saveGameResults(winnerSlot: number, status: 'finished' | 'disconnected') {
    if (this.resultsSaved) return;
    this.resultsSaved = true;
    
    try {
      const sql = this.ctx.storage.sql;
      
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
      
      // Save to D1 with explicit status (Fix 6)
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
            Math.round(duration),
            status
          );
        } catch (d1Err) {
          console.error('Error saving to D1:', d1Err);
        }
      }
    } catch (err) {
      console.error('Error saving game results:', err);
    }
  }
  
  private logEvent(eventType: string, playerSlot: number | null, playerInfo: PlayerInfo | null, metadata: Record<string, any> = {}) {
    const body = JSON.stringify({
      room_id: this.roomId,
      event_type: eventType,
      player_slot: playerSlot,
      colo: playerInfo?.colo || null,
      city: playerInfo?.city || null,
      country: playerInfo?.country || null,
      latitude: playerInfo?.latitude || null,
      longitude: playerInfo?.longitude || null,
      metadata,
    });
    this.ctx.waitUntil(
      fetch('https://pong.jeka.org/api/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal': 'true' },
        body,
      }).catch(err => console.error('Analytics event error:', err))
    );
  }
  
  // Lobby notification methods
  
  private notifyLobbyRegister() {
    if (!this.roomId) return;
    
    const players = Array.from(this.players.values());
    const p1 = players.find(p => p.slot === 1);
    const p2 = players.find(p => p.slot === 2);
    
    const roomInfo = {
      roomId: this.roomId,
      status: this.gameState.phase === 'waiting' ? 'waiting' : 'playing',
      player1Name: p1?.name || '',
      player2Name: p2?.name || null,
      player1Colo: p1?.colo || null,
      player2Colo: p2?.colo || null,
      player1City: p1?.city || null,
      player2City: p2?.city || null,
      score: [this.gameState.score1, this.gameState.score2] as [number, number],
      spectatorCount: this.getSpectatorCount(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    this.ctx.waitUntil(
      this.callLobby('/register', roomInfo).catch(err => 
        console.error('Lobby register error:', err)
      )
    );
  }
  
  // Fix 4: AI games register as 'playing' with AI name
  private notifyLobbyRegisterAsPlaying() {
    if (!this.roomId) return;
    
    const players = Array.from(this.players.values());
    const p1 = players.find(p => p.slot === 1);
    
    const roomInfo = {
      roomId: this.roomId,
      status: 'playing',
      player1Name: p1?.name || '',
      player2Name: 'AI 🤖',
      player1Colo: p1?.colo || null,
      player2Colo: null,
      player1City: p1?.city || null,
      player2City: null,
      score: [0, 0] as [number, number],
      spectatorCount: this.getSpectatorCount(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    this.ctx.waitUntil(
      this.callLobby('/register', roomInfo).catch(err =>
        console.error('Lobby register (AI) error:', err)
      )
    );
  }
  
  private notifyLobbyUpdate(patch: any) {
    if (!this.roomId) return;
    
    this.ctx.waitUntil(
      this.callLobby('/update', {
        roomId: this.roomId,
        patch,
      }).catch(err => console.error('Lobby update error:', err))
    );
  }
  
  private notifyLobbyUnregister() {
    if (!this.roomId) return;
    
    this.ctx.waitUntil(
      this.callLobby('/unregister', {
        roomId: this.roomId,
      }).catch(err => console.error('Lobby unregister error:', err))
    );
  }
  
  private notifyLobbySpectatorCount() {
    this.notifyLobbyUpdate({
      spectatorCount: this.getSpectatorCount(),
    });
  }
  
  private getSpectatorCount(): number {
    return Array.from(this.players.values()).filter(p => p.role === 'spectator').length;
  }
  
  private async callLobby(path: string, body: any): Promise<void> {
    const lobbyId = this.env.LOBBY.idFromName('global');
    const lobby = this.env.LOBBY.get(lobbyId);
    await lobby.fetch(`https://lobby${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

// Type definitions
interface Env {
  GAME_ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  DB: D1Database;
  HYPERDRIVE: Hyperdrive;
}
