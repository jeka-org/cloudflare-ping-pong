// D1 query helpers for rooms and leaderboard

export interface RoomRecord {
  id: string;
  created_at: string;
  creator_colo: string | null;
  creator_city: string | null;
  creator_country: string | null;
  status: 'waiting' | 'playing' | 'finished' | 'expired';
  finished_at: string | null;
  player1_colo: string | null;
  player2_colo: string | null;
  player1_city: string | null;
  player2_city: string | null;
  player1_name: string | null;
  player2_name: string | null;
  winner_slot: number | null;
  final_score: string | null;
  total_rallies: number | null;
  longest_rally: number | null;
  game_duration_seconds: number | null;
}

export interface LeaderboardEntry {
  player_id: string;
  wins: number;
  losses: number;
  longest_rally: number;
  games_played: number;
  last_played: string;
}

/**
 * Create a new room record
 */
export async function createRoom(
  db: D1Database,
  roomId: string,
  creatorColo: string | null,
  creatorCity: string | null,
  creatorCountry: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rooms (id, created_at, creator_colo, creator_city, creator_country, status)
       VALUES (?, ?, ?, ?, ?, 'waiting')`
    )
    .bind(
      roomId,
      new Date().toISOString(),
      creatorColo,
      creatorCity,
      creatorCountry
    )
    .run();
}

/**
 * Update room status to playing
 */
export async function updateRoomPlaying(
  db: D1Database,
  roomId: string,
  player1Colo: string | null,
  player1City: string | null,
  player1Name: string | null,
  player2Colo: string | null,
  player2City: string | null,
  player2Name: string | null
): Promise<void> {
  await db
    .prepare(
      `UPDATE rooms 
       SET status = 'playing',
           player1_colo = ?,
           player1_city = ?,
           player1_name = ?,
           player2_colo = ?,
           player2_city = ?,
           player2_name = ?
       WHERE id = ?`
    )
    .bind(player1Colo, player1City, player1Name, player2Colo, player2City, player2Name, roomId)
    .run();
}

/**
 * Save game results
 */
export async function saveGameResults(
  db: D1Database,
  roomId: string,
  winnerSlot: number,
  score1: number,
  score2: number,
  totalRallies: number,
  longestRally: number,
  durationSeconds: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE rooms
       SET status = 'finished',
           finished_at = ?,
           winner_slot = ?,
           final_score = ?,
           total_rallies = ?,
           longest_rally = ?,
           game_duration_seconds = ?
       WHERE id = ?`
    )
    .bind(
      new Date().toISOString(),
      winnerSlot,
      `${score1}-${score2}`,
      totalRallies,
      longestRally,
      durationSeconds,
      roomId
    )
    .run();
}

/**
 * Get room by ID
 */
export async function getRoom(
  db: D1Database,
  roomId: string
): Promise<RoomRecord | null> {
  const result = await db
    .prepare('SELECT * FROM rooms WHERE id = ?')
    .bind(roomId)
    .first<RoomRecord>();
  
  return result;
}

/**
 * Get recent games (for homepage feed)
 */
export async function getRecentGames(
  db: D1Database,
  limit: number = 10
): Promise<RoomRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM rooms 
       WHERE status = 'finished'
       ORDER BY finished_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<RoomRecord>();
  
  return result.results || [];
}

/**
 * Get leaderboard
 */
export async function getLeaderboard(
  db: D1Database,
  limit: number = 20
): Promise<LeaderboardEntry[]> {
  const result = await db
    .prepare(
      `SELECT * FROM leaderboard
       ORDER BY wins DESC, games_played ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<LeaderboardEntry>();
  
  return result.results || [];
}

/**
 * Update player stats after game
 */
export async function updatePlayerStats(
  db: D1Database,
  playerId: string,
  won: boolean,
  longestRally: number
): Promise<void> {
  const now = new Date().toISOString();
  
  await db
    .prepare(
      `INSERT INTO leaderboard (player_id, wins, losses, longest_rally, games_played, last_played)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         wins = wins + ?,
         losses = losses + ?,
         longest_rally = MAX(longest_rally, ?),
         games_played = games_played + 1,
         last_played = ?`
    )
    .bind(
      playerId,
      won ? 1 : 0,
      won ? 0 : 1,
      longestRally,
      now,
      won ? 1 : 0,
      won ? 0 : 1,
      longestRally,
      now
    )
    .run();
}

/**
 * Get global stats
 */
export async function getGlobalStats(db: D1Database): Promise<{
  total_games: number;
  active_games: number;
  total_players: number;
}> {
  const gamesResult = await db
    .prepare(
      `SELECT 
        COUNT(*) as total_games,
        SUM(CASE WHEN status = 'playing' THEN 1 ELSE 0 END) as active_games
       FROM rooms`
    )
    .first<{ total_games: number; active_games: number }>();
  
  const playersResult = await db
    .prepare('SELECT COUNT(*) as total_players FROM leaderboard')
    .first<{ total_players: number }>();
  
  return {
    total_games: gamesResult?.total_games || 0,
    active_games: gamesResult?.active_games || 0,
    total_players: playersResult?.total_players || 0,
  };
}
