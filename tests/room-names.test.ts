import { describe, it, expect } from 'vitest';
import { generateRoomName } from '../src/room-names';

describe('room name generator', () => {
  it('generates adjective-noun format', () => {
    const name = generateRoomName();
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]+$/);
  });

  it('generates unique names', () => {
    const names = new Set(Array.from({ length: 100 }, () => generateRoomName()));
    expect(names.size).toBeGreaterThan(90); // at least 90% unique
  });

  it('generates names with valid characters', () => {
    for (let i = 0; i < 20; i++) {
      const name = generateRoomName();
      expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]+$/);
      expect(name.length).toBeGreaterThan(3);
    }
  });
});
