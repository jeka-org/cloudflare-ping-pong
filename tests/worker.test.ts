import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

describe('Worker routes', () => {
  beforeEach(async () => {
    // Create tables if they don't exist
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, creator_colo TEXT, creator_city TEXT, creator_country TEXT, status TEXT DEFAULT 'waiting', finished_at TEXT, player1_colo TEXT, player2_colo TEXT, player1_city TEXT, player2_city TEXT, winner_slot INTEGER, final_score TEXT, total_rallies INTEGER, longest_rally INTEGER, game_duration_seconds REAL)`).run();
    
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leaderboard (player_id TEXT PRIMARY KEY, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, longest_rally INTEGER DEFAULT 0, games_played INTEGER DEFAULT 0, last_played TEXT)`).run();
    
    // Clean up test data
    await env.DB.exec('DELETE FROM rooms');
  });

  it('serves homepage at /', async () => {
    const resp = await SELF.fetch('http://localhost/');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const text = await resp.text();
    expect(text).toContain('GLOBAL PONG');
  });

  it('creates a new room via /api/create', async () => {
    const resp = await SELF.fetch('http://localhost/api/create', { method: 'POST' });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { roomId: string; url: string };
    expect(data.roomId).toMatch(/^[a-z]+-[a-z]+$/);
    expect(data.url).toContain('/r/');
  });

  it('returns CORS headers for API endpoints', async () => {
    const resp = await SELF.fetch('http://localhost/api/create', { method: 'OPTIONS' });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('serves game page at /r/:roomId', async () => {
    const resp = await SELF.fetch('http://localhost/r/test-room');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const text = await resp.text();
    expect(text).toContain('gameCanvas');
  });

  it('returns recent games', async () => {
    const resp = await SELF.fetch('http://localhost/api/recent');
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { games: any[] };
    expect(Array.isArray(data.games)).toBe(true);
  });

  it('returns leaderboard', async () => {
    const resp = await SELF.fetch('http://localhost/api/leaderboard');
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { leaderboard: any[] };
    expect(Array.isArray(data.leaderboard)).toBe(true);
  });

  it('returns global stats', async () => {
    const resp = await SELF.fetch('http://localhost/api/stats');
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { stats: any };
    expect(data.stats).toBeDefined();
    expect(typeof data.stats.total_games).toBe('number');
  });

  it('returns 404 for unknown routes', async () => {
    const resp = await SELF.fetch('http://localhost/nonexistent');
    expect(resp.status).toBe(404);
  });
});
