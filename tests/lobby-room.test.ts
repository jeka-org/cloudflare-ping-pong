import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// LobbyRoom uses DO SQLite which has a known isolation bug in vitest-pool-workers v0.5
// with new_sqlite_classes. Full DO integration tests require wrangler dev --local.
// These tests validate the lobby via Worker HTTP routes instead.

describe('Lobby integration via Worker', () => {
  it('GET /api/lobby returns valid room list structure', async () => {
    const resp = await SELF.fetch('https://pong.jeka.org/api/lobby');
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    expect(data).toHaveProperty('rooms');
    expect(Array.isArray(data.rooms)).toBe(true);
    // Each room (if any) should have required fields
    for (const room of data.rooms) {
      expect(room).toHaveProperty('roomId');
      expect(room).toHaveProperty('status');
      expect(room).toHaveProperty('player1Name');
      expect(room).toHaveProperty('score');
      expect(room).toHaveProperty('spectatorCount');
    }
  });
});
