-- D1 Schema for Global Pong
-- Stores room metadata, game results, and leaderboard

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  creator_colo TEXT,
  creator_city TEXT,
  creator_country TEXT,
  status TEXT DEFAULT 'waiting',
  finished_at TEXT,
  player1_colo TEXT,
  player2_colo TEXT,
  player1_city TEXT,
  player2_city TEXT,
  winner_slot INTEGER,
  final_score TEXT,
  total_rallies INTEGER,
  longest_rally INTEGER,
  game_duration_seconds REAL
);

CREATE TABLE IF NOT EXISTS leaderboard (
  player_id TEXT PRIMARY KEY,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  longest_rally INTEGER DEFAULT 0,
  games_played INTEGER DEFAULT 0,
  last_played TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_rooms_created ON rooms(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_finished ON rooms(finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_wins ON leaderboard(wins DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_games ON leaderboard(games_played DESC);
