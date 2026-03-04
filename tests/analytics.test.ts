import { describe, it, expect } from 'vitest';
import {
  queryHourlyActivity,
  queryGeographicMatchups,
  queryColoActivity,
  queryTimeSeries,
  insertGameEvent,
} from '../src/analytics';

describe('analytics query builders', () => {
  it('builds hourly activity query without NOW()', () => {
    const query = queryHourlyActivity('2026-03-01T00:00:00Z');
    expect(query.sql).not.toContain('NOW()');
    expect(query.sql).not.toContain('CURRENT_TIMESTAMP');
    expect(query.sql).toContain('$1');
    expect(query.params[0]).toBe('2026-03-01T00:00:00Z');
  });

  it('builds geographic matchup query', () => {
    const query = queryGeographicMatchups(10);
    expect(query.sql).toContain('GROUP BY');
    expect(query.sql).toContain('JOIN');
    expect(query.params).toContain(10);
  });

  it('builds colo activity query', () => {
    const query = queryColoActivity(20);
    expect(query.sql).toContain('colo');
    expect(query.sql).toContain('GROUP BY');
    expect(query.params).toContain(20);
  });

  it('builds time series query', () => {
    const query = queryTimeSeries(24);
    expect(query.sql).toContain('date_trunc');
    expect(query.sql).toContain('minute');
    expect(query.params.length).toBe(1);
  });

  it('builds insert game event query', () => {
    const query = insertGameEvent(
      'test-room',
      'player_joined',
      1,
      'SFO',
      'San Francisco',
      'US',
      37.7749,
      -122.4194,
      { test: 'data' }
    );
    expect(query.sql).toContain('INSERT INTO game_events');
    expect(query.params[0]).toBe('test-room');
    expect(query.params[1]).toBe('player_joined');
    expect(query.params[2]).toBe(1);
    expect(query.params[8]).toContain('test');
  });

  it('handles null values in insert', () => {
    const query = insertGameEvent(
      'test-room',
      'room_created',
      null,
      null,
      null,
      null,
      null,
      null
    );
    expect(query.params[2]).toBeNull();
    expect(query.params[3]).toBeNull();
  });
});
