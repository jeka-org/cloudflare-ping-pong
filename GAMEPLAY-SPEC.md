# Gameplay Events Spec - Space Events System

## Overview
Random space events appear during gameplay, creating unpredictable moments that both players must adapt to. Events are server-authoritative (computed in game-room.ts physics loop) and broadcast to clients for visual rendering.

## Actors
- **Ball**: Affected by gravity wells, bounces off asteroids, speeds up during rally heat
- **Players**: Must adapt to changing conditions. Both players affected equally.
- **AI**: AI logic does NOT know about events. It just tracks ball position as normal. Events make AI beatable in new ways.
- **Spectators**: See all event visuals but don't interact

## Event System Architecture

### Server (game-room.ts)
- `activeEvents: GameEvent[]` array on the DO
- Event spawn check runs every 180 frames (~3 seconds at 60fps) during 'playing' phase
- Spawn chance: 15% per check (so roughly one event every ~20 seconds)
- Max 1 active event at a time (no stacking)
- Events have a `startFrame` and `durationFrames` field. Auto-removed when expired.
- Event state broadcast in every `state` message: `events: [{ type, x, y, radius, ... }]`

### Client (index.ts GAME_HTML)
- Reads `data.events` from state broadcasts
- Renders visual effects for each active event
- Pure visual, no physics on client

### Event Types

---

## Event 1: Gravity Well

### Gameplay
- A swirling vortex appears at a random position (x: 0.25-0.75, y: 0.2-0.8, avoiding paddle zones)
- Ball is pulled toward the well center with force inversely proportional to distance
- Force: `strength / max(distance, 0.05)` applied as velocity delta each tick
- Strength: 0.0003 (tunable, should curve the ball noticeably but not trap it)
- Duration: 300 frames (5 seconds)
- Ball cannot be captured (min distance clamp prevents orbit lock)

### Server State
```typescript
interface GravityWellEvent {
  type: 'gravity_well';
  x: number; // 0-1 normalized
  y: number; // 0-1 normalized  
  radius: 0.08; // visual radius
  strength: 0.0003;
  startFrame: number;
  durationFrames: 300;
}
```

### Physics (in gameTick, after ball update, before paddle collision check)
```
for each active gravity_well event:
  dx = event.x - ball.x
  dy = event.y - ball.y
  dist = sqrt(dx*dx + dy*dy)
  if dist < 0.3: // only affects ball within range
    force = event.strength / max(dist, 0.05)
    ball.vx += dx/dist * force
    ball.vy += dy/dist * force
    // clamp ball speed to MAX_BALL_SPEED * 1.5 (allow slight over-speed from gravity)
```

### Client Visual
- Swirling particle effect: 8-12 particles orbiting the center point
- Particles are warm orange/gold, orbiting in a spiral that tightens over time
- Subtle radial gradient glow at center (dark center, orange rim)
- Spawn animation: grows from 0 to full size over 15 frames
- Despawn: shrinks back to 0 over 15 frames
- When ball is nearby, draw faint "pull lines" from ball toward well

---

## Event 2: Asteroid

### Gameplay
- A solid rectangular obstacle drifts slowly across the field
- Enters from top or bottom, moves vertically at constant speed
- Ball bounces off it (like a wall, reverse the perpendicular velocity component)
- Size: 0.06 wide x 0.12 tall (normalized)
- Speed: 0.001 per frame (slow drift)
- Duration: until it exits the field (typically 400-600 frames depending on entry point)
- Entry: random x between 0.2-0.8, enters from y=0 or y=1

### Server State
```typescript
interface AsteroidEvent {
  type: 'asteroid';
  x: number; // center x, 0-1
  y: number; // center y, 0-1
  width: 0.06;
  height: 0.12;
  vy: number; // +0.001 or -0.001
  startFrame: number;
  durationFrames: 600; // max, removed earlier if exits field
}
```

### Physics (in gameTick, after wall bounce, before paddle collision)
```
for each active asteroid event:
  // Update asteroid position
  event.y += event.vy
  
  // Remove if off screen
  if event.y < -0.1 or event.y > 1.1: remove event
  
  // Check ball collision with asteroid rectangle
  if ball is inside asteroid bounds (with ball radius):
    // Determine which face was hit (top/bottom vs left/right)
    // Reverse appropriate velocity component
    // Push ball outside asteroid to prevent sticking
```

### Client Visual
- Rounded rectangle with rocky texture (dark gray with orange-lit edges, like a space rock catching ember light)
- Subtle rotation animation (CSS or canvas, slow spin)
- On ball collision: flash bright orange briefly, spawn a few rock debris particles
- Trail of faint dust particles behind it as it moves

---

## Event 3: Rally Heat

### Gameplay
- NOT a spawned event. Activates automatically based on rally length.
- After 4 consecutive hits (rallyHits >= 4), rally heat activates
- Effects scale with rally length:
  - 4-6 hits: ball speed multiplier 1.1x, subtle warm vignette
  - 7-9 hits: ball speed multiplier 1.2x, stronger vignette, ball trail gets longer/brighter
  - 10+ hits: ball speed multiplier 1.3x, screen edges glow orange, ball trail is on fire, paddle hit sparks are doubled
- Resets when rally ends (point scored)
- Speed multiplier applies ON TOP of the normal per-hit speed increase

### Server State
- No separate event object. Uses existing `rallyHits` counter.
- In `gameTick`, after paddle collision speed increase, apply rally heat multiplier:
  ```
  if rallyHits >= 4:
    heatLevel = min(floor((rallyHits - 4) / 3) + 1, 3) // 1, 2, or 3
    speedMultiplier = 1 + heatLevel * 0.1  // 1.1, 1.2, 1.3
    ball speed clamped to MAX_BALL_SPEED * speedMultiplier
  ```
- Broadcast `rallyHeat` level in state message: `rallyHeat: 0 | 1 | 2 | 3`

### Client Visual
- Heat level 1: ball outer glow grows 50%, warm vignette at screen edges (orange, 0.1 alpha)
- Heat level 2: ball trail particles doubled, vignette stronger (0.2 alpha), scores text pulses
- Heat level 3: ball trail is fiery (larger, brighter particles), screen edge glow pulses, hit sparks doubled in count, subtle screen heat distortion (canvas slight scale oscillation, very subtle)
- Transition: smooth fade between levels over 10 frames
- Reset: quick fade out (5 frames) when rally ends

---

## Spawn Rules

### When events spawn
- Only during 'playing' phase
- Check every 180 frames (3 seconds)
- 15% chance per check
- No event spawns if one is already active
- Rally heat is always active (passive system), doesn't count as an "active event"
- No events spawn during the first 120 frames of a round (let players settle in)

### Event selection
- Random weighted: gravity_well 40%, asteroid 60%
- (Rally heat is automatic, not randomly spawned)

### Position safety
- Gravity wells: x between 0.25-0.75, y between 0.2-0.8 (away from paddles and edges)
- Asteroids: x between 0.2-0.8, start from y=0 (moving down) or y=1 (moving up), random

---

## State Message Changes

Current state broadcast:
```javascript
{ type: 'state', ball, paddle1, paddle2, score1, score2, phase, spectatorCount }
```

New:
```javascript
{ type: 'state', ball, paddle1, paddle2, score1, score2, phase, spectatorCount, events: [...], rallyHeat: 0-3 }
```

`events` is an array of active event objects (usually 0 or 1 items).
`rallyHeat` is 0 when rally is under 4 hits, 1-3 based on formula above.

---

## Files to Modify

### Server
- `src/game-room.ts`: 
  - Add `activeEvents` array, `eventCheckCounter` to DO state
  - Add event spawn logic in `gameTick()`
  - Add gravity well physics in `gameTick()`
  - Add asteroid collision physics in `gameTick()`
  - Add rally heat speed multiplier in `gameTick()`
  - Add `events` and `rallyHeat` to state broadcast
  - Clear events on game end, round reset

### Client
- `src/index.ts` (GAME_HTML):
  - Read `data.events` and `data.rallyHeat` from state messages
  - Render gravity well (swirling particles + glow)
  - Render asteroid (rounded rect + debris)
  - Render rally heat (vignette + enhanced trails)
  - Gravity well pull lines when ball is near
  - Asteroid collision flash

### Physics
- `src/physics.ts`: DO NOT MODIFY (keep pure). All event physics go in game-room.ts directly.

---

## Edge Cases
1. Ball hits asteroid AND scores in same frame → score takes priority, ignore asteroid
2. Gravity well pulls ball into paddle → normal paddle collision still applies
3. Gravity well pulls ball off screen → normal scoring still applies
4. Asteroid blocks ball from reaching paddle → tough luck, creates interesting dynamics
5. Event expires while ball is inside asteroid → ball passes through, no collision
6. Rally heat + gravity well → ball can get very fast. ABSOLUTE max: MAX_BALL_SPEED * 1.5 enforced after ALL modifiers.
7. Game ends while event is active → events cleared in cleanup(), no stale state
8. Reconnection during event → new state broadcast includes events, client renders them immediately
9. **Events during pause (reconnection)** → events FREEZE. Don't tick event durations or move asteroids during 'paused' phase. Resume when game resumes.
10. **Events on point scored (round reset)** → events PERSIST across rounds. Don't clear on score. Only clear on game end. This makes events feel like environmental hazards, not round-specific.
11. **Events during 'scored' phase** (1 second pause between points) → events continue ticking (asteroid keeps drifting, gravity well keeps pulling). Ball is reset at center so gravity pull on reset ball creates interesting first-move dynamics.
12. **Asteroid corner collision** → Use simple AABB overlap check. If ball overlaps asteroid, determine primary axis of penetration (smallest overlap) and reverse that velocity component. Push ball out along that axis.
13. **Asteroid + gravity well simultaneously** → Can't happen. Max 1 active event rule. Rally heat is passive and always runs alongside events.
