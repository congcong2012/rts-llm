/**
 * Keyboard map (docs/ROADMAP.md 阶段 2 任务 7).
 *
 * The mapping itself is a pure function so it can be tested without a browser;
 * the scene owns the actual `keydown` plumbing.
 *
 *   WASD / arrows  pan the camera
 *   Space          centre on the own base
 *   Esc            clear the selection
 *   G              gather the nearest crystal with the selection
 *   H              hold position
 *   X              stop (MVP: the same as hold — there is no stop action)
 *   Q / E          zoom out / in (Shift amplifies)
 *   Tab            cycle to the next own idle unit
 */

export type HotkeyIntent =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'center-base' }
  | { kind: 'clear-selection' }
  | { kind: 'gather' }
  | { kind: 'hold' }
  | { kind: 'stop' }
  | { kind: 'zoom'; factor: number }
  | { kind: 'cycle-idle' }
  | null;

/** Map a `KeyboardEvent.code` (layout independent) to an intent. */
export function intentForCode(code: string, shiftKey = false): HotkeyIntent {
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      return { kind: 'pan', dx: 0, dy: -1 };
    case 'KeyS':
    case 'ArrowDown':
      return { kind: 'pan', dx: 0, dy: 1 };
    case 'KeyA':
    case 'ArrowLeft':
      return { kind: 'pan', dx: -1, dy: 0 };
    case 'KeyD':
    case 'ArrowRight':
      return { kind: 'pan', dx: 1, dy: 0 };
    case 'Space':
      return { kind: 'center-base' };
    case 'Escape':
      return { kind: 'clear-selection' };
    case 'KeyG':
      return { kind: 'gather' };
    case 'KeyH':
      return { kind: 'hold' };
    case 'KeyX':
      // 'S' is taken by the camera; 'X' is the stop key.
      return { kind: 'stop' };
    case 'KeyQ':
      return { kind: 'zoom', factor: shiftKey ? 0.7 : 0.85 };
    case 'KeyE':
      return { kind: 'zoom', factor: shiftKey ? 1.4 : 1.18 };
    case 'Tab':
      return { kind: 'cycle-idle' };
    default:
      return null;
  }
}

/** Camera pan speed in world pixels per second at zoom 1. */
export const PAN_SPEED_PX_PER_SEC = 900;
/** Zoom limits (acceptance B6). */
export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 2.0;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return zoom < ZOOM_MIN ? ZOOM_MIN : zoom > ZOOM_MAX ? ZOOM_MAX : zoom;
}
