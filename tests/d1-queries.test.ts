import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createRoom,
  updateRoomPlaying,
  saveGameResults,
  getRoom,
  getRecentGames,
  getLeaderboard,
  updatePlayerStats,
  getGlobalStats,
} from '../src/d1-queries';

describe('D1 room operations', () => {
  beforeEach(async () => {
    // Create tables if they don't exist
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, creator_colo TEXT, creator_city TEXT, creator_country TEXT, status TEXT DEFAULT 'waiting', finished_at TEXT, player1_colo TEXT, player2_colo TEXT, player1_city TEXT, player2_city TEXT, winner_slot INTEGER, final_score TEXT, total_rallies INTEGER, longest_rally INTEGER, game_duration_seconds REAL)`).run();
    
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leaderboard (player_id TEXT PRIMARY KEY, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, longest_rally INTEGER DEFAULT 0, games_played INTEGER DEFAULT 0, last_played TEXT)`).run();
    
    // Reset tables before each test
    await env.DB.exec('DELETE FROM rooms');
    await env.DB.exec('DELETE FROM leaderboard');
  });

  it('creates a room record', async () => {
    await createRoom(env.DB, 'test-room', 'SFO', 'San Francisco', 'US');

    const room = await getRoom(env.DB, 'test-room');
    expect(room?.id).toBe('test-room');
    expect(room?.status).toBe('waiting');
    expect(room?.creator_colo).toBe('SFO');
  });

  it('updates room status to playing', async () => {
    await createRoom(env.DB, 'test-room', 'SFO', 'San Francisco', 'US');
    await updateRoomPlaying(env.DB, 'test-room', 'SFO', 'San Francisco', 'FRA', 'Frankfurt');

    const room = await getRoom(env.DB, 'test-room');
    expect(room?.status).toBe('playing');
    expect(room?.player1_colo).toBe('SFO');
    expect(room?.player2_colo).toBe('FRA');
  });

  it('saves game results', async () => {
    await createRoom(env.DB, 'test-room', 'SFO', 'San Francisco', 'US');
    await saveGameResults(env.DB, 'test-room', 1, 5, 3, 12, 8, 125.5);

    const room = await getRoom(env.DB, 'test-room');
    expect(room?.status).toBe('finished');
    expect(room?.winner_slot).toBe(1);
    expect(room?.final_score).toBe('5-3');
    expect(room?.total_rallies).toBe(12);
    expect(room?.longest_rally).toBe(8);
  });

  it('returns recent games', async () => {
    await createRoom(env.DB, 'room-1', 'SFO', 'San Francisco', 'US');
    await saveGameResults(env.DB, 'room-1', 1, 5, 3, 10, 5, 100);

    await createRoom(env.DB, 'room-2', 'FRA', 'Frankfurt', 'DE');
    await saveGameResults(env.DB, 'room-2', 2, 3, 5, 8, 4, 90);

    const games = await getRecentGames(env.DB, 10);
    expect(games.length).toBe(2);
    expect(games[0].status).toBe('finished');
  });

  it('updates player stats', async () => {
    await updatePlayerStats(env.DB, 'player-1', true, 10);

    const leaderboard = await getLeaderboard(env.DB, 10);
    expect(leaderboard.length).toBe(1);
    expect(leaderboard[0].player_id).toBe('player-1');
    expect(leaderboard[0].wins).toBe(1);
    expect(leaderboard[0].losses).toBe(0);
    expect(leaderboard[0].longest_rally).toBe(10);
  });

  it('increments player stats on subsequent games', async () => {
    await updatePlayerStats(env.DB, 'player-1', true, 10);
    await updatePlayerStats(env.DB, 'player-1', false, 12);

    const leaderboard = await getLeaderboard(env.DB, 10);
    expect(leaderboard[0].wins).toBe(1);
    expect(leaderboard[0].losses).toBe(1);
    expect(leaderboard[0].games_played).toBe(2);
    expect(leaderboard[0].longest_rally).toBe(12); // max of 10 and 12
  });

  it('returns leaderboard sorted by wins', async () => {
    await updatePlayerStats(env.DB, 'player-a', true, 5);
    await updatePlayerStats(env.DB, 'player-a', true, 6);
    await updatePlayerStats(env.DB, 'player-b', true, 8);

    const leaderboard = await getLeaderboard(env.DB, 10);
    expect(leaderboard[0].player_id).toBe('player-a'); // 2 wins
    expect(leaderboard[1].player_id).toBe('player-b'); // 1 win
  });

  it('returns global stats', async () => {
    await createRoom(env.DB, 'room-1', 'SFO', 'San Francisco', 'US');
    await updateRoomPlaying(env.DB, 'room-1', 'SFO', 'San Francisco', 'FRA', 'Frankfurt');

    await createRoom(env.DB, 'room-2', 'FRA', 'Frankfurt', 'DE');
    await saveGameResults(env.DB, 'room-2', 1, 5, 3, 10, 5, 100);

    await updatePlayerStats(env.DB, 'player-1', true, 5);
    await updatePlayerStats(env.DB, 'player-2', false, 5);

    const stats = await getGlobalStats(env.DB);
    expect(stats.total_games).toBe(2);
    expect(stats.active_games).toBe(1); // room-1 is still playing
    expect(stats.total_players).toBe(2);
  });
});
