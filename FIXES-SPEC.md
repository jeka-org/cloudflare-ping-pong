# Global Pong - Fix Spec v2 (18 Issues + Review Fixes)

## Actors
- **Player 1**: Human, always first to connect, occupies slot 1 via WebSocket
- **Player 2**: Human OR AI. Human occupies slot 2 via WebSocket. AI occupies slot 2 server-side with NO WebSocket connection. AI cannot disconnect.
- **Spectator**: Any connection after both slots are filled. Has WebSocket but no paddle control. Can send emoji reactions.
- **Lobby viewer**: Homepage visitor connected to lobby WebSocket. Not in any game.

## State Machine (ALL rooms follow this)

```
HUMAN GAMES:         waiting → ready → countdown → playing → finished
                                                           → disconnected (grace expired)
                                                           → abandoned (no score + disconnect)
                     waiting → expired (10-min alarm, no player 2)

AI GAMES:            playing → finished
                     playing → disconnected (player 1 leaves)
                     playing → abandoned (no score + player 1 leaves)
```

**Valid lobby statuses:** waiting | ready | playing | finished
**Valid D1 statuses:** waiting | playing | finished | expired | disconnected | abandoned

**Transitions:**
| From | To | Trigger |
|------|----|---------|
| waiting | ready | Player 2 connects (human games only) |
| waiting | expired | 10-min alarm fires, still waiting |
| ready | countdown | Either player clicks START |
| countdown | playing | Countdown reaches 0 |
| playing | finished | Score reaches 5 |
| playing | paused | Player disconnects (15s grace) |
| paused | playing | Player reconnects |
| paused | disconnected | Grace timer expires, has score |
| paused | abandoned | Grace timer expires, no score |

**AI games skip waiting/ready/countdown from the lobby's perspective.** They register as 'playing' immediately.

## Game-End Paths (each MUST unregister from lobby + clean D1)
1. Normal win (score reaches 5) → status 'finished', save results + leaderboard
2. Grace timer expires, has score → status 'disconnected', save results, winner = remaining player
3. Grace timer expires, no score → status 'abandoned', don't save results
4. Both players disconnect → status 'abandoned', immediate end, no grace
5. Waiting room expires (10-min alarm) → status 'expired', no results to save
6. AI game, player 1 disconnects, has score → status 'disconnected', AI wins
7. AI game, player 1 disconnects, no score → status 'abandoned'

**Every path calls:** `notifyLobbyUnregister()` + D1 status update + `stopGameLoop()` + clear heartbeat interval.

---

## Fix 1: Win condition (CRITICAL)
- **Change:** Game ends at first to 5 points (not 3)
- **Code:** `game-room.ts` change `>= 3` to `>= 5`
- **Comment:** Remove "best of 5" comment, replace with "first to 5"

## Fix 2: Lobby heartbeat (CRITICAL)
- **Change:** GameRoom sends heartbeat to lobby every 30s
- **When:** Start on first player connect (not just game start). Clear in `stopGameLoop()` AND on game end (all 7 paths above).
- **Code:** `setInterval(() => this.callLobby('/heartbeat', { roomId: this.roomId }), 30000)`. Store as `this.heartbeatInterval`.
- **During pause (Fix 3):** Keep sending heartbeats so lobby doesn't prune. Lobby status stays 'playing' during pause (lobby doesn't need to know about pause; it's a 15s window max).
- **Cleanup:** `clearInterval(this.heartbeatInterval)` in a new `cleanup()` method called by all game-end paths.

## Fix 3: Reconnection support (CRITICAL)
- **Change:** Player disconnect gives 15-second grace period before ending game
- **Flow:**
  1. Player WebSocket closes → set `disconnectedSlot = player.slot`, start 15s timer
  2. Broadcast `{ type: 'player_disconnected', slot, timeout: 15, name: originalName }` to ALL current connections
  3. Game loop pauses (freeze ball position, stop physics, keep broadcasting frozen state)
  4. Other player sees overlay: "Opponent disconnected. Reconnecting... 15s"
  5. Spectators see same overlay
  6. New connection during grace period: if `disconnectedSlot` matches an empty slot, assign to that slot
  7. Timer expires with no reconnect → end game per game-end paths above
- **Slot name preservation:** Reconnecting player inherits the ORIGINAL slot name, not their new generated name. This is critical for leaderboard integrity (Fix 7).
- **Both players disconnect:** If both slots become empty, end game immediately. No grace period.
- **AI games:** Only Player 1 can disconnect. AI never disconnects. Grace period works the same.
- **New connections during pause:** Any new connection (spectator or reconnecting player) receives current pause state on connect:
  ```
  { type: 'game_paused', disconnectedSlot, remainingSeconds, score1, score2 }
  ```
- **Client pause UI:** Semi-transparent overlay on canvas. Shows countdown timer. "Waiting for [PlayerName] to reconnect... 12s". Game canvas visible but grayed out underneath.
- **Resume:** On reconnect, broadcast `{ type: 'player_reconnected', slot, name }`. Clear overlay. Resume physics after 3-2-1 countdown.

## Fix 4: AI lobby status (MEDIUM)
- **Change:** AI games register with lobby as 'playing', not 'waiting'
- **Code:** Move `notifyLobbyRegister()` to AFTER `startCountdown()` is called. In the register payload, explicitly set `status: 'playing'` and `player2Name: 'AI 🤖'`.
- **AI games never use 'waiting' or 'ready' status.** The lifecycle is: register as 'playing' → play → unregister.

## Fix 5: Room existence check (MEDIUM)
- **Change:** Before serving game HTML for `/r/:roomId`, check D1 for room existence
- **Flow:**
  1. `GET /r/:roomId` → query D1: `SELECT status FROM rooms WHERE id = ?`
  2. If no row OR status = 'expired' → serve error page: "This room has expired or doesn't exist. [Back to lobby]"
  3. If status in ('finished', 'disconnected', 'abandoned') → serve error page: "This game has ended. [Back to lobby]"
  4. Otherwise → serve game HTML as normal
- **Belt and suspenders:** The DO's `fetch()` handler should ALSO reject WebSocket upgrades if the game is in a terminal state (finished/disconnected/abandoned). Send `{ type: 'room_closed', reason }` and close the WebSocket. This handles the race between D1 check and WebSocket connect.

## Fix 6: Disconnect game results (MEDIUM)
- **Three cases (explicit):**
  1. **No score + disconnect:** Don't call `saveGameResults()`. Set D1 status to 'abandoned'. Don't update leaderboard.
  2. **Has score + disconnect:** Call `saveGameResults()`. Winner = player who DIDN'T disconnect. Set D1 status to 'disconnected'. Update leaderboard.
  3. **Normal game end:** Call `saveGameResults()`. Winner = player who reached 5. Set D1 status to 'finished'. Update leaderboard.
- **Track disconnect:** Add `private endReason: 'completed' | 'disconnected' | 'abandoned' | null = null` to GameRoom.
- **AI disconnect:** If Player 1 disconnects from AI game, AI is the "remaining player" and wins (if score exists).

## Fix 7: Leaderboard population (MEDIUM)
- **Change:** Call `updatePlayerStats()` after saving game results
- **When:** Only on 'completed' and 'disconnected' end reasons. Not on 'abandoned'.
- **Player ID:** Use player name as ID. Known limitation: not unique across sessions. Document this.
- **AI exclusion:** Do NOT create leaderboard entries for 'AI 🤖'. Only update the human player's stats in AI games.

## Fix 8: Lobby status types (MEDIUM)
- **Change:** Add 'ready' to RoomInfo status union type
- **Code:** `lobby-room.ts`: `status: 'waiting' | 'ready' | 'playing' | 'finished'`
- **Lobby UI:** 'ready' rooms show under "WAITING" category with "JOIN" button (joiner becomes spectator, which is correct).
- **Transitions:** See state machine above.

## Fix 9: Spectator emoji reactions - FULL IMPLEMENTATION (MEDIUM)
- **Who can send:** Spectators only. Players are busy playing.
- **Who can see:** Everyone (players + spectators).
- **Server validation:** Whitelist: 🔥 👏 😱 💀 😂 👀 ❤️ 🏓. Reject anything else. Rate limit: max 1 per 2 seconds per WebSocket connection.
- **Client send UI:** Floating emoji bar at bottom of screen, only visible when `myRole === 'spectator'`. 8 buttons in a row. Disabled for 2s after sending (visual cooldown).
- **Client receive:** New `case 'reaction'` in message handler. Emoji floats up from bottom-center of canvas area, fades out over 1.5s. Sender name shown small next to emoji. Max 5 simultaneous floating emojis (older ones removed).
- **Rate limit reset on reconnect:** Accepted. Minor exploit, not worth overengineering.

## Fix 10: Room name collision (LOW)
- **Change:** Check D1 before creating room. Retry with new name if collision.
- **After 5 failures:** Return JSON error `{ error: "Server busy, please try again" }` with 503 status.

## Fix 11: Stale D1 cleanup (LOW)
- **Change:** Clean abandoned rooms from D1
- **Trigger:** Run on `/api/stats` AND `/api/lobby` queries.
- **Threshold:** 15 minutes (not 1 hour). Aligns closer to Fix 16's 10-minute DO expiry + buffer.
- **Query:** `UPDATE rooms SET status = 'expired' WHERE status = 'waiting' AND created_at < datetime('now', '-15 minutes')`
- **Fix 16 also cleans D1:** When Fix 16's alarm expires a waiting room, it should also update the D1 row to 'expired'.

## Fix 12: Double saveGameResults (LOW)
- **Change:** Add `private resultsSaved = false;` to GameRoom. Check at top of `saveGameResults()`, return early if true. Set true before the save (not after).

## Fix 13: AI spectator explanation (LOW)
- **Change:** When a spectator joins an AI game, send context
- **Code:** After role assignment and initial state broadcast:
  ```
  this.send(server, { type: 'spectator_info', message: 'Watching AI game' });
  ```
- **Client:** Display in status area. Don't overwrite other status messages.

## Fix 14: SPECTATING badge persistence
- **Change:** Persistent badge, not the fading status text
- **Remove:** `setTimeout(() => { statusEl.style.opacity = '0'; }, 2000);` for spectators
- **Add:** Dedicated `<div id="spectatorBadge">SPECTATING</div>` element. CSS:
  ```
  position: absolute; top: 12px; left: 12px; 
  background: rgba(139,92,246,0.7); color: white;
  padding: 4px 12px; border-radius: 4px; font-size: 0.75rem;
  z-index: 10; pointer-events: none;
  ```
- **Visibility:** `display: block` when spectator, `display: none` otherwise.

## Fix 15: Lobby visual hierarchy - REDESIGN
- **New HTML layout order:**
  1. `<h1>` title + subtitle
  2. CREATE ROOM + PLAY VS AI buttons (hero)
  3. **ACTIVE GAMES section** (immediately after buttons, before everything else)
  4. Stats counters (compact row, smaller)
  5. Recent Games
  6. Live Dashboard

- **Lobby styling:**
  - Border: 2px solid with orange glow (`box-shadow: 0 0 20px rgba(249,115,22,0.3)`)
  - Background: slightly brighter than other sections
  - Room cards: 50% more padding than current. Player names at 1.1rem. Score at 1.3rem bold.
  - JOIN button: full-width gold, 48px height
  - SPECTATE button: purple outline, same dimensions
  
- **Empty state (most common):**
  ```html
  <div class="lobby-empty">
    <p>No active games right now</p>
    <div class="lobby-empty-actions">
      <button class="btn-join">CREATE ROOM</button>
      <button class="btn-spectate">PLAY VS AI 🤖</button>
    </div>
  </div>
  ```
  Buttons trigger same actions as hero buttons.

- **Animations:** CSS transitions only. `opacity 0→1` and `max-height 0→auto` for rooms appearing. 300ms ease. Debounce lobby updates: batch updates within 200ms window before re-rendering.

## Fix 16: Waiting room expiry (LOW)
- **Change:** 10-minute alarm for waiting rooms
- **Set alarm:** On first player connect when entering 'waiting' phase.
- **Alarm handler logic:**
  ```
  if (phase === 'waiting') → close connections, unregister lobby, update D1 to 'expired'
  else if (phase in ['playing', 'paused', 'countdown', 'ready']) → reschedule alarm for 30 min
  else → no-op (room already ended)
  ```
- **Cancel on game start?** No, just reschedule. Simpler and handles all cases.

## Fix 17: Frontend message handlers
- **Add these cases to ws.onmessage switch:**
  - `'reaction'` → floating emoji animation (Fix 9)
  - `'player_disconnected'` → pause overlay with countdown (Fix 3)
  - `'player_reconnected'` → clear overlay, show "Player reconnected!" (Fix 3)
  - `'game_paused'` → same as player_disconnected but for late-joining spectators (Fix 3)
  - `'spectator_info'` → display in status area (Fix 13)
  - `'room_closed'` → show error, link to lobby (Fix 5)

## Fix 18: D1 active_games count
- **Change:** `SUM(CASE WHEN status IN ('waiting', 'playing', 'ready') THEN 1 ELSE 0 END) as active_games`

---

## Files to modify
1. `src/game-room.ts` - Fixes 1, 2, 3, 4, 6, 7, 9 (server), 12, 13, 16
2. `src/lobby-room.ts` - Fix 8
3. `src/index.ts` - Fixes 5, 9 (client), 10, 11, 14, 15, 17, 18
4. `src/d1-queries.ts` - Fixes 6, 7, 11, 18

## Deployment
After all changes: `npx tsc --noEmit` then `wrangler deploy`

## Known Limitations (documented, not fixing now)
- Player names as leaderboard IDs are not unique. Two "Swift Fox" entries from different sessions merge.
- No auth system. Reconnection is slot-based, not identity-based. Anyone can "reconnect" to an open slot.
- Emoji rate limit resets on reconnect (trivial exploit, low impact).
