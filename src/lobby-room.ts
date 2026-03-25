// LobbyRoom Durable Object - central registry for all active game rooms

import { DurableObject } from 'cloudflare:workers';

export interface RoomInfo {
  roomId: string;
  status: 'waiting' | 'ready' | 'playing' | 'finished';
  player1Name: string;
  player2Name: string | null;
  player1Colo: string | null;
  player2Colo: string | null;
  player1City: string | null;
  player2City: string | null;
  score: [number, number];
  spectatorCount: number;
  createdAt: number;
  updatedAt: number;
}

export class LobbyRoom extends DurableObject {
  private rooms: Map<string, RoomInfo> = new Map();
  private viewers: Set<WebSocket> = new Set();
  private alarmScheduled = false;

  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;
    await this.loadState();
    await this.scheduleAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();
    const url = new URL(request.url);
    
    // WebSocket upgrade for live lobby updates
    if (request.headers.get('Upgrade') === 'websocket') {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      
      this.ctx.acceptWebSocket(server);
      this.viewers.add(server);
      
      // Send initial state immediately
      this.send(server, {
        type: 'lobby_state',
        rooms: Array.from(this.rooms.values()),
      });
      
      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }
    
    // RPC endpoints called by GameRoom DOs
    if (request.method === 'POST') {
      const path = url.pathname;
      
      if (path === '/register') {
        const info = await request.json() as RoomInfo;
        await this.registerRoom(info);
        return Response.json({ ok: true });
      }
      
      if (path === '/unregister') {
        const { roomId } = await request.json() as { roomId: string };
        await this.unregisterRoom(roomId);
        return Response.json({ ok: true });
      }
      
      if (path === '/update') {
        const { roomId, patch } = await request.json() as {
          roomId: string;
          patch: Partial<RoomInfo>;
        };
        await this.updateRoom(roomId, patch);
        return Response.json({ ok: true });
      }
      
      if (path === '/heartbeat') {
        const { roomId } = await request.json() as { roomId: string };
        await this.heartbeat(roomId);
        return Response.json({ ok: true });
      }
    }
    
    // HTTP GET fallback for non-WebSocket clients
    if (request.method === 'GET' && url.pathname === '/list') {
      return Response.json({
        rooms: Array.from(this.rooms.values()),
      });
    }
    
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      if (typeof message !== 'string') return;
      
      const data = JSON.parse(message);
      
      if (data.type === 'subscribe') {
        // Client explicitly subscribes (already added to viewers on connect)
        this.send(ws, {
          type: 'lobby_state',
          rooms: Array.from(this.rooms.values()),
        });
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.viewers.delete(ws);
  }

  // Room registry methods (called by GameRoom DOs via RPC)
  
  async registerRoom(info: RoomInfo): Promise<void> {
    info.updatedAt = Date.now();
    this.rooms.set(info.roomId, info);
    await this.persistRoom(info);
    this.broadcastLobbyUpdate();
  }

  async unregisterRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
    await this.deletePersistedRoom(roomId);
    this.broadcastLobbyUpdate();
  }

  async updateRoom(roomId: string, patch: Partial<RoomInfo>): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    Object.assign(room, patch);
    room.updatedAt = Date.now();
    
    await this.persistRoom(room);
    this.broadcastLobbyUpdate();
  }

  async heartbeat(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    room.updatedAt = Date.now();
    await this.persistRoom(room);
  }

  // Broadcast lobby state to all connected homepage viewers
  private broadcastLobbyUpdate() {
    const payload = JSON.stringify({
      type: 'lobby_update',
      rooms: Array.from(this.rooms.values()),
    });
    
    for (const ws of this.viewers) {
      this.send(ws, payload);
    }
  }

  private send(ws: WebSocket, data: any) {
    try {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      ws.send(message);
    } catch (err) {
      console.error('Error sending to WebSocket:', err);
    }
  }

  // SQLite persistence
  private async loadState() {
    try {
      const sql = this.ctx.storage.sql;
      
      // Create table if it doesn't exist
      sql.exec(`
        CREATE TABLE IF NOT EXISTS lobby_rooms (
          room_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      
      // Load all rooms
      const rows = sql.exec<{
        room_id: string;
        data: string;
        updated_at: number;
      }>('SELECT room_id, data, updated_at FROM lobby_rooms').toArray();
      
      for (const row of rows) {
        const info = JSON.parse(row.data) as RoomInfo;
        this.rooms.set(row.room_id, info);
      }
      
      // Prune stale rooms on startup (older than 5 minutes)
      const now = Date.now();
      const staleThreshold = 5 * 60 * 1000;
      
      for (const [roomId, room] of this.rooms.entries()) {
        if (now - room.updatedAt > staleThreshold) {
          this.rooms.delete(roomId);
          await this.deletePersistedRoom(roomId);
        }
      }
    } catch (err) {
      console.error('Error loading lobby state:', err);
    }
  }

  private async persistRoom(info: RoomInfo) {
    try {
      const sql = this.ctx.storage.sql;
      sql.exec(
        `INSERT OR REPLACE INTO lobby_rooms (room_id, data, updated_at) VALUES (?, ?, ?)`,
        info.roomId,
        JSON.stringify(info),
        info.updatedAt
      );
    } catch (err) {
      console.error('Error persisting room:', err);
    }
  }

  private async deletePersistedRoom(roomId: string) {
    try {
      const sql = this.ctx.storage.sql;
      sql.exec(`DELETE FROM lobby_rooms WHERE room_id = ?`, roomId);
    } catch (err) {
      console.error('Error deleting persisted room:', err);
    }
  }

  // Alarm for staleness checking (prune rooms that haven't updated in 5 minutes)
  private async scheduleAlarm() {
    if (this.alarmScheduled) return;
    
    // Run every 60 seconds
    const nextAlarm = Date.now() + 60 * 1000;
    await this.ctx.storage.setAlarm(nextAlarm);
    this.alarmScheduled = true;
  }

  async alarm() {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    
    let pruned = false;
    for (const [roomId, room] of this.rooms.entries()) {
      if (now - room.updatedAt > staleThreshold) {
        this.rooms.delete(roomId);
        await this.deletePersistedRoom(roomId);
        pruned = true;
      }
    }
    
    if (pruned) {
      this.broadcastLobbyUpdate();
    }
    
    // Reschedule alarm
    this.alarmScheduled = false;
    await this.scheduleAlarm();
  }
}

// Type definitions
interface Env {
  LOBBY: DurableObjectNamespace;
}
