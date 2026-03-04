// Analytics query builders for Hyperdrive + Postgres
// Important: Queries must avoid NOW() and CURRENT_TIMESTAMP for cache compatibility

export interface AnalyticsQuery {
  sql: string;
  params: any[];
}

/**
 * Query hourly activity for a specific date range
 * Uses parameterized date instead of NOW() for Hyperdrive cache compatibility
 */
export function queryHourlyActivity(startDate: string): AnalyticsQuery {
  return {
    sql: `
      SELECT
        date_trunc('hour', timestamp) AS hour,
        COUNT(DISTINCT room_id) AS games,
        COUNT(DISTINCT city) AS cities,
        COUNT(*) FILTER (WHERE event_type = 'point_scored') AS total_points
      FROM game_events
      WHERE timestamp > $1::timestamptz
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 168
    `,
    params: [startDate],
  };
}

/**
 * Get geographic matchup statistics
 */
export function queryGeographicMatchups(limit: number = 10): AnalyticsQuery {
  return {
    sql: `
      SELECT
        p1.city AS city1,
        p1.country AS country1,
        p2.city AS city2,
        p2.country AS country2,
        COUNT(*) AS games,
        AVG(
          CASE 
            WHEN p1.latitude IS NOT NULL AND p2.latitude IS NOT NULL
            THEN ST_Distance(
              ST_MakePoint(p1.longitude, p1.latitude)::geography,
              ST_MakePoint(p2.longitude, p2.latitude)::geography
            ) / 1000.0
            ELSE NULL
          END
        ) AS avg_distance_km
      FROM game_events p1
      JOIN game_events p2 ON p1.room_id = p2.room_id AND p1.player_slot = 1 AND p2.player_slot = 2
      WHERE p1.event_type = 'player_joined' AND p2.event_type = 'player_joined'
      GROUP BY 1, 2, 3, 4
      ORDER BY games DESC
      LIMIT $1
    `,
    params: [limit],
  };
}

/**
 * Get colo activity statistics
 */
export function queryColoActivity(limit: number = 20): AnalyticsQuery {
  return {
    sql: `
      SELECT
        colo,
        COUNT(DISTINCT room_id) AS games,
        COUNT(*) AS total_events,
        COUNT(DISTINCT city) AS unique_cities
      FROM game_events
      WHERE event_type IN ('room_created', 'player_joined')
      GROUP BY colo
      ORDER BY games DESC
      LIMIT $1
    `,
    params: [limit],
  };
}

/**
 * Log a game event to Postgres
 */
export function insertGameEvent(
  roomId: string,
  eventType: string,
  playerSlot: number | null,
  colo: string | null,
  city: string | null,
  country: string | null,
  latitude: number | null,
  longitude: number | null,
  metadata: Record<string, any> = {}
): AnalyticsQuery {
  return {
    sql: `
      INSERT INTO game_events (
        room_id, event_type, player_slot, colo, city, country,
        latitude, longitude, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    params: [
      roomId,
      eventType,
      playerSlot,
      colo,
      city,
      country,
      latitude,
      longitude,
      JSON.stringify(metadata),
    ],
  };
}

/**
 * Get time-series activity data for dashboard
 */
export function queryTimeSeries(hoursBack: number = 24): AnalyticsQuery {
  const startTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  
  return {
    sql: `
      SELECT
        date_trunc('minute', timestamp) AS minute,
        COUNT(*) FILTER (WHERE event_type = 'room_created') AS rooms_created,
        COUNT(*) FILTER (WHERE event_type = 'player_joined') AS players_joined,
        COUNT(*) FILTER (WHERE event_type = 'point_scored') AS points_scored
      FROM game_events
      WHERE timestamp > $1::timestamptz
      GROUP BY 1
      ORDER BY 1
    `,
    params: [startTime],
  };
}

/**
 * Execute a query via Hyperdrive
 */
export async function executeAnalyticsQuery<T = any>(
  hyperdrive: Hyperdrive,
  query: AnalyticsQuery
): Promise<T[]> {
  try {
    const db = hyperdrive.connectionString;
    // Note: In production, you'd use a Postgres client library
    // For now, this is a placeholder showing the pattern
    // Actual implementation would use node-postgres or similar
    
    // This is a simplified example - real implementation needs a proper Postgres client
    console.log('Would execute query:', query.sql, 'with params:', query.params);
    return [];
  } catch (err) {
    console.error('Error executing analytics query:', err);
    throw err;
  }
}

/**
 * Log game event (fire-and-forget - don't block on this)
 */
export function logGameEvent(
  hyperdrive: Hyperdrive,
  roomId: string,
  eventType: string,
  playerSlot: number | null = null,
  colo: string | null = null,
  city: string | null = null,
  country: string | null = null,
  metadata: Record<string, any> = {}
) {
  // In production, this would execute the insert asynchronously
  const query = insertGameEvent(
    roomId,
    eventType,
    playerSlot,
    colo,
    city,
    country,
    null, // latitude - would come from request.cf
    null, // longitude - would come from request.cf
    metadata
  );
  
  console.log('Would log event:', query);
}
