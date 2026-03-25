import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createRoom,
  saveGameResults,
  updateRoomStatus,
  getRoom,
  getRecentGames,
  updatePlayerStats,
  getLeaderboard,
  getGlobalStats,
  cleanStaleRooms,
} from '../src/d1-queries';

/**
 * Game logic integration tests
 * Tests the game-end paths, scoring rules, and state transitions
 * that map to the state machine in FIXES-SPEC.md
 */

describe('Game-end paths', () => {
  beforeEach(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, creator_colo TEXT, creator_city TEXT, creator_country TEXT, status TEXT DEFAULT 'waiting', finished_at TEXT, player1_colo TEXT, player2_colo TEXT, player1_city TEXT, player2_city TEXT, player1_name TEXT, player2_name TEXT, winner_slot INTEGER, final_score TEXT, total_rallies INTEGER, longest_rally INTEGER, game_duration_seconds REAL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leaderboard (player_id TEXT PRIMARY KEY, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, longest_rally INTEGER DEFAULT 0, games_played INTEGER DEFAULT 0, last_played TEXT)`).run();
    await env.DB.exec('DELETE FROM rooms');
    await env.DB.exec('DELETE FROM leaderboard');
  });

  // Path 1: Normal win (score reaches 3) → status 'finished'
  it('saves completed game with correct winner when player 1 wins 3-1', async () => {
    await createRoom(env.DB, 'game-1', 'SEA', 'Seattle', 'US');
    await saveGameResults(env.DB, 'game-1', 1, 3, 1, 4, 8, 60);

    const room = await getRoom(env.DB, 'game-1');
    expect(room?.status).toBe('finished');
    expect(room?.winner_slot).toBe(1);
    expect(room?.final_score).toBe('3-1');
  });

  it('saves completed game with correct winner when player 2 wins 2-3', async () => {
    await createRoom(env.DB, 'game-2', 'SEA', 'Seattle', 'US');
    await saveGameResults(env.DB, 'game-2', 2, 2, 3, 5, 12, 90);

    const room = await getRoom(env.DB, 'game-2');
    expect(room?.status).toBe('finished');
    expect(room?.winner_slot).toBe(2);
    expect(room?.final_score).toBe('2-3');
  });

  it('updates leaderboard for both players on completed game', async () => {
    await updatePlayerStats(env.DB, 'Swift Fox', true, 12);
    await updatePlayerStats(env.DB, 'Bold Tiger', false, 12);

    const board = await getLeaderboard(env.DB, 10);
    const winner = board.find(p => p.player_id === 'Swift Fox');
    const loser = board.find(p => p.player_id === 'Bold Tiger');
    expect(winner?.wins).toBe(1);
    expect(winner?.losses).toBe(0);
    expect(loser?.wins).toBe(0);
    expect(loser?.losses).toBe(1);
  });

  // Path 2: Grace expires with score → status 'disconnected'
  it('saves disconnected game with remaining player as winner', async () => {
    await createRoom(env.DB, 'game-dc', 'SEA', 'Seattle', 'US');
    // Player 1 disconnected at 2-1, so player 2 wins
    await saveGameResults(env.DB, 'game-dc', 2, 2, 1, 3, 5, 45, 'disconnected');

    const room = await getRoom(env.DB, 'game-dc');
    expect(room?.status).toBe('disconnected');
    expect(room?.winner_slot).toBe(2);
    expect(room?.final_score).toBe('2-1');
  });

  // Path 3: Grace expires without score → status 'abandoned'
  it('marks game as abandoned when no score and disconnect', async () => {
    await createRoom(env.DB, 'game-abandon', 'SEA', 'Seattle', 'US');
    await updateRoomStatus(env.DB, 'game-abandon', 'abandoned');

    const room = await getRoom(env.DB, 'game-abandon');
    expect(room?.status).toBe('abandoned');
    expect(room?.winner_slot).toBeNull();
    expect(room?.final_score).toBeNull();
  });

  // Path 5: Waiting room expires → status 'expired'
  it('marks waiting room as expired', async () => {
    await createRoom(env.DB, 'game-expire', 'SEA', 'Seattle', 'US');
    await updateRoomStatus(env.DB, 'game-expire', 'expired');

    const room = await getRoom(env.DB, 'game-expire');
    expect(room?.status).toBe('expired');
  });

  // Abandoned games should NOT appear in recent games
  it('recent games excludes abandoned and expired rooms', async () => {
    await createRoom(env.DB, 'good-game', 'SEA', 'Seattle', 'US');
    await saveGameResults(env.DB, 'good-game', 1, 3, 0, 3, 5, 30);

    await createRoom(env.DB, 'abandoned-game', 'SEA', 'Seattle', 'US');
    await updateRoomStatus(env.DB, 'abandoned-game', 'abandoned');

    await createRoom(env.DB, 'expired-game', 'SEA', 'Seattle', 'US');
    await updateRoomStatus(env.DB, 'expired-game', 'expired');

    const recent = await getRecentGames(env.DB, 10);
    expect(recent.length).toBe(1);
    expect(recent[0].id).toBe('good-game');
  });

  // Disconnected games with score SHOULD appear in recent games
  it('recent games includes disconnected games with scores', async () => {
    await createRoom(env.DB, 'dc-game', 'SEA', 'Seattle', 'US');
    await saveGameResults(env.DB, 'dc-game', 1, 2, 1, 3, 4, 40, 'disconnected');

    const recent = await getRecentGames(env.DB, 10);
    expect(recent.length).toBe(1);
    expect(recent[0].status).toBe('disconnected');
  });
});

describe('Win condition: best of 5 (first to 3)', () => {
  it('score 3-0 is a valid final score (player 1 sweep)', async () => {
    // Minimum points for a win: 3-0
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, creator_colo TEXT, creator_city TEXT, creator_country TEXT, status TEXT DEFAULT 'waiting', finished_at TEXT, player1_colo TEXT, player2_colo TEXT, player1_city TEXT, player2_city TEXT, player1_name TEXT, player2_name TEXT, winner_slot INTEGER, final_score TEXT, total_rallies INTEGER, longest_rally INTEGER, game_duration_seconds REAL)`).run();
    await env.DB.exec('DELETE FROM rooms');
    
    await createRoom(env.DB, 'sweep', 'SEA', 'Seattle', 'US');
    await saveGameResults(env.DB, 'sweep', 1, 3, 0, 3, 5, 20);
    const room = await getRoom(env.DB, 'sweep');
    expect(room?.final_score).toBe('3-0');
    expect(room?.winner_slot).toBe(1);
  });

  it('score 2-3 is a valid final score (player 2 wins best-of-5)', async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, creator_colo TEXT, creator_city TEXT, creator_country TEXT, status TEXT DEFAULT 'waiting', finished_at TEXT, player1_colo TEXT, player2_colo TEXT, player1_city TEXT, player2_city TEXT, player1_name TEXT, player2_name TEXT, winner_slot INTEGER, final_score TEXT, total_rallies INTEGER, longest_rally INTEGER, game_duration_seconds REAL)`).run();
    await env.DB.exec('DELETE FROM rooms');
    
    await createRoom(env.DB, 'close-game', 'SEA', 'Seattle', 'US');
    await saveGameResults(env.DB, 'close-game', 2, 2, 3, 5, 15, 120);
    const room = await getRoom(env.DB, 'close-game');
    expect(room?.final_score).toBe('2-3');
    expect(room?.winner_slot).toBe(2);
  });

  it('max total points in best-of-5 is 5 (2-3 or 3-2)', async () => {
    // This test documents the rule: no game should ever have more than 5 total points
    // because one side must reach 3 first
    const validScores = ['3-0', '3-1', '3-2', '0-3', '1-3', '2-3'];
    for (const score of validScores) {
      const [s1, s2] = score.split('-').map(Number);
      expect(s1 + s2).toBeLessThanOrEqual(5);
      expect(Math.max(s1, s2)).toBe(3);
    }
  });
});

describe('Active games count', () => {
  beforeEach(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, creator_colo TEXT, creator_city TEXT, creator_country TEXT, status TEXT DEFAULT 'waiting', finished_at TEXT, player1_colo TEXT, player2_colo TEXT, player1_city TEXT, player2_city TEXT, player1_name TEXT, player2_name TEXT, winner_slot INTEGER, final_score TEXT, total_rallies INTEGER, longest_rally INTEGER, game_duration_seconds REAL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leaderboard (player_id TEXT PRIMARY KEY, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, longest_rally INTEGER DEFAULT 0, games_played INTEGER DEFAULT 0, last_played TEXT)`).run();
    await env.DB.exec('DELETE FROM rooms');
    await env.DB.exec('DELETE FROM leaderboard');
  });

  it('counts waiting, playing, and ready as active', async () => {
    await createRoom(env.DB, 'waiting-room', 'SEA', 'Seattle', 'US');
    // waiting-room stays as 'waiting'

    await createRoom(env.DB, 'playing-room', 'SEA', 'Seattle', 'US');
    await env.DB.prepare("UPDATE rooms SET status = 'playing' WHERE id = 'playing-room'").run();

    await createRoom(env.DB, 'ready-room', 'SEA', 'Seattle', 'US');
    await env.DB.prepare("UPDATE rooms SET status = 'ready' WHERE id = 'ready-room'").run();

    await createRoom(env.DB, 'finished-room', 'SEA', 'Seattle', 'US');
    await saveGameResults(env.DB, 'finished-room', 1, 3, 1, 4, 8, 60);

    const stats = await getGlobalStats(env.DB);
    expect(stats.active_games).toBe(3); // waiting + playing + ready
    expect(stats.total_games).toBe(4);
  });

  it('does not count abandoned, expired, or disconnected as active', async () => {
    await createRoom(env.DB, 'abandoned', 'SEA', 'Seattle', 'US');
    await updateRoomStatus(env.DB, 'abandoned', 'abandoned');

    await createRoom(env.DB, 'expired', 'SEA', 'Seattle', 'US');
    await updateRoomStatus(env.DB, 'expired', 'expired');

    await createRoom(env.DB, 'disconnected', 'SEA', 'Seattle', 'US');
    await saveGameResults(env.DB, 'disconnected', 1, 2, 1, 3, 4, 30, 'disconnected');

    const stats = await getGlobalStats(env.DB);
    expect(stats.active_games).toBe(0);
  });
});

describe('Stale room cleanup', () => {
  beforeEach(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, creator_colo TEXT, creator_city TEXT, creator_country TEXT, status TEXT DEFAULT 'waiting', finished_at TEXT, player1_colo TEXT, player2_colo TEXT, player1_city TEXT, player2_city TEXT, player1_name TEXT, player2_name TEXT, winner_slot INTEGER, final_score TEXT, total_rallies INTEGER, longest_rally INTEGER, game_duration_seconds REAL)`).run();
    await env.DB.exec('DELETE FROM rooms');
  });

  it('expires waiting rooms older than 15 minutes', async () => {
    // Insert a room with old timestamp
    await env.DB.prepare(
      "INSERT INTO rooms (id, created_at, status) VALUES ('stale-room', datetime('now', '-20 minutes'), 'waiting')"
    ).run();

    await env.DB.prepare(
      "INSERT INTO rooms (id, created_at, status) VALUES ('fresh-room', datetime('now'), 'waiting')"
    ).run();

    await cleanStaleRooms(env.DB);

    const stale = await getRoom(env.DB, 'stale-room');
    const fresh = await getRoom(env.DB, 'fresh-room');
    expect(stale?.status).toBe('expired');
    expect(fresh?.status).toBe('waiting');
  });
});
