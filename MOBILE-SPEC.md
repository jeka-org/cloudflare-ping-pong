# Mobile-First Pong - UX Spec

## Current State (Problems)

### Game Page
1. **Canvas is fixed 800x600** - On a 375px phone, it scales down to ~350x263 via CSS max-width. Works but wastes vertical space and the game feels tiny.
2. **Touch controls are mouse-mapped** - touchmove on canvas moves paddle. This works but the finger covers the paddle. No visual feedback.
3. **No landscape prompt** - Pong is a horizontal game. Portrait mode gives a tiny landscape-ratio canvas with huge dead space above/below.
4. **Buttons too small** - START GAME button, emoji bar buttons, music toggle are desktop-sized.
5. **Player names overflow** - Two long generated names side-by-side can overflow on small screens.
6. **Game-over overlay** - Text sizing is fixed, may be too large or too small on mobile.
7. **No haptic feedback** - Mobile devices can vibrate on paddle hits, scoring.
8. **Lobby link is tiny** - "LOBBY" button in top-left corner is hard to tap.

### Homepage
9. **Dashboard tables** - Tables with city names overflow on 375px screens.
10. **Lobby room cards** - JOIN/SPECTATE buttons may be cramped.
11. **Stats counters** - Large font numbers may wrap.

## Proposed Changes

### Priority 1: Responsive Canvas
- **Detect orientation**: If portrait on mobile, show a "Rotate your phone 📱" overlay with animation
- **Canvas sizing**: On mobile, make canvas fill available width and calculate height from 4:3 ratio
- **Viewport meta**: Add `maximum-scale=1, user-scalable=no` to prevent accidental zoom during gameplay

### Priority 2: Touch Controls Redesign
- **Option A: Drag zones** - Left 30% of screen = your paddle zone. Touch anywhere in that zone and paddle follows finger Y. No need to touch the actual paddle. Right side is opponent's.
- **Option B: Tilt controls** - Use device accelerometer for paddle position. Tilt phone up/down to move paddle. Feels like air hockey.
- **Recommended: Option A** with a subtle guide line showing the touch zone. More reliable, works on all devices.
- **Visual feedback**: Show a faint touch indicator where your finger is (translucent circle)

### Priority 3: Mobile Layout Tweaks
- Player names: truncate with ellipsis on small screens, or stack vertically
- Buttons: minimum 48px tap target (already close)
- Game-over: scale text with viewport units (vw) instead of fixed rem
- Emoji bar: larger buttons on mobile, maybe 2 rows instead of 1
- Music toggle: larger tap target
- Lobby link: larger, maybe a floating action button style

### Priority 4: Landscape Lock
- When game starts, request `screen.orientation.lock('landscape')` (not all browsers support it)
- If not supported, show the rotate overlay in portrait

### Priority 5: Haptic Feedback
- `navigator.vibrate(15)` on paddle hit
- `navigator.vibrate(30)` on scoring
- `navigator.vibrate([50, 30, 50])` on game over
- Only if `navigator.vibrate` exists (not on desktop)

### Priority 6: Performance
- Mobile GPUs are weaker. The particle system and star field should check frame time and reduce particle count if dropping below 60fps.
- Or: detect mobile via touch support and reduce particle budget (e.g., 4 hit particles instead of 8, 20 stars instead of 30)

## Out of Scope (for now)
- PWA / installable app
- Offline play
- Controller support (gamepad API)
- Split-screen local multiplayer

## Implementation Notes
- All changes are client-side (GAME_HTML in index.ts + CSS)
- Touch zone approach needs to replace current mousemove/touchmove handler
- Orientation detection: `window.matchMedia('(orientation: portrait)')` 
- Canvas resize: listen to `resize` event, recalculate canvas dimensions
- Test at: 375x667 (iPhone SE), 390x844 (iPhone 14), 412x915 (Pixel 7)
