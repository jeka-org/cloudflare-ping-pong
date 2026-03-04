-- Postgres Schema for Global Pong Analytics
-- Accessed via Hyperdrive for rich analytics queries
-- Simplified version without PostGIS (can add later for geo features)

-- Game events table - raw event stream
CREATE TABLE IF NOT EXISTS game_events (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  player_slot INTEGER,
  colo TEXT,
  city TEXT,
  country TEXT,
  latitude FLOAT,
  longitude FLOAT,
  metadata JSONB
);

-- Indexes for common analytics queries
CREATE INDEX IF NOT EXISTS idx_game_events_room ON game_events(room_id);
CREATE INDEX IF NOT EXISTS idx_game_events_type ON game_events(event_type);
CREATE INDEX IF NOT EXISTS idx_game_events_timestamp ON game_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_game_events_colo ON game_events(colo);
CREATE INDEX IF NOT EXISTS idx_game_events_city ON game_events(city);

-- Materialized view for hourly activity (Hyperdrive-cacheable)
CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_activity AS
SELECT
  date_trunc('hour', timestamp) AS hour,
  COUNT(DISTINCT room_id) AS games,
  COUNT(DISTINCT city) AS cities,
  COUNT(*) FILTER (WHERE event_type = 'point_scored') AS total_points,
  COUNT(*) FILTER (WHERE event_type = 'room_created') AS rooms_created,
  COUNT(*) FILTER (WHERE event_type = 'player_joined') AS players_joined
FROM game_events
GROUP BY 1
ORDER BY 1 DESC;

-- Index on materialized view
CREATE INDEX IF NOT EXISTS idx_hourly_activity_hour ON hourly_activity(hour DESC);

-- View for geographic matchup analysis (simplified without PostGIS distance calculation)
CREATE OR REPLACE VIEW geographic_matchups AS
SELECT
  p1.city AS city1,
  p1.country AS country1,
  p1.colo AS colo1,
  p2.city AS city2,
  p2.country AS country2,
  p2.colo AS colo2,
  COUNT(*) AS games,
  -- Simple latitude/longitude difference (not accurate distance, but works for demo)
  CASE 
    WHEN p1.latitude IS NOT NULL AND p2.latitude IS NOT NULL
    THEN SQRT(
      POWER((p1.latitude - p2.latitude) * 111.0, 2) + 
      POWER((p1.longitude - p2.longitude) * 111.0 * COS(RADIANS(p1.latitude)), 2)
    )
    ELSE NULL
  END AS distance_km
FROM game_events p1
JOIN game_events p2 ON 
  p1.room_id = p2.room_id AND 
  p1.player_slot = 1 AND 
  p2.player_slot = 2 AND
  p1.event_type = 'player_joined' AND 
  p2.event_type = 'player_joined'
GROUP BY 
  p1.city, p1.country, p1.colo, p1.latitude, p1.longitude,
  p2.city, p2.country, p2.colo, p2.latitude, p2.longitude;

-- Function to refresh materialized view (call from a Cron Trigger Worker)
CREATE OR REPLACE FUNCTION refresh_hourly_activity()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY hourly_activity;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions to pong_user
GRANT SELECT, INSERT ON game_events TO pong_user;
GRANT SELECT ON hourly_activity TO pong_user;
GRANT SELECT ON geographic_matchups TO pong_user;
GRANT USAGE ON SEQUENCE game_events_id_seq TO pong_user;
