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
import { HOME_HTML } from './templates/home';
import { GAME_HTML } from './templates/game';

import { ERROR_HTML } from './templates/error';
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
        let client;
        try {
          const event = await request.json() as any;
          client = new pg.Client(env.HYPERDRIVE.connectionString);
          await client.connect();
          await client.query(
            `INSERT INTO game_events (room_id, event_type, player_slot, colo, city, country, latitude, longitude, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [event.room_id, event.event_type, event.player_slot, event.colo, event.city, event.country, event.latitude, event.longitude, JSON.stringify(event.metadata || {})]
          );
          return Response.json({ ok: true }, { headers: corsHeaders });
        } catch (err: any) {
          console.error('Analytics event error:', err);
          return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
        } finally {
          if (client) await client.end().catch(() => {});
        }
      }
      
      // API: Analytics data from Postgres
      if (url.pathname === '/api/analytics') {
        let client2;
        try {
          client2 = new pg.Client(env.HYPERDRIVE.connectionString);
          await client2.connect();
          
          const [activity, cities, topGames, eventCount] = await Promise.all([
            client2.query(
              `SELECT date_trunc('hour', timestamp) AS hour, COUNT(DISTINCT room_id) AS games, COUNT(*) AS events
               FROM game_events WHERE timestamp > NOW() - INTERVAL '24 hours'
               GROUP BY 1 ORDER BY 1 DESC LIMIT 24`
            ),
            client2.query(
              `SELECT city, country, COUNT(DISTINCT room_id) AS games, COUNT(*) AS events
               FROM game_events WHERE city IS NOT NULL
               GROUP BY city, country ORDER BY games DESC LIMIT 20`
            ),
            client2.query(
              `SELECT room_id, 
                      COUNT(*) FILTER (WHERE event_type = 'point_scored') AS points,
                      MAX((metadata->>'rally_hits')::int) AS longest_rally,
                      MAX((metadata->>'duration_seconds')::int) AS duration
               FROM game_events 
               WHERE event_type IN ('point_scored', 'game_over')
               GROUP BY room_id ORDER BY longest_rally DESC NULLS LAST LIMIT 10`
            ),
            client2.query(`SELECT COUNT(*) AS total, COUNT(DISTINCT room_id) AS rooms FROM game_events`),
          ]);
          
          // client closed in finally
          
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
          const client3 = new pg.Client(env.HYPERDRIVE.connectionString);
          await client3.connect();
          const result = await client3.query(
            `SELECT room_id, event_type, player_slot, colo, city, country, metadata, timestamp
             FROM game_events ORDER BY timestamp DESC LIMIT 20`
          );
          await client3.end();
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

