import { el } from '../ui.js';
import { ROLE_META } from '../constants.js';

/** Only use with a public role or inside the private identity card. Unknown roles have no image. */
export function roleArt(role, { className = '', full = false } = {}) {
  if (!Object.hasOwn(ROLE_META, role)) return null;
  return el('img', {
    class: 'role-art ' + className,
    src: `/images/roles/${role}${full ? '' : '-thumb'}.jpg`,
    alt: '', 'aria-hidden': 'true', width: full ? 768 : 192, height: full ? 768 : 192,
    decoding: 'async', draggable: false,
  });
}

// Phase names are public to the entire room; this never depends on the current player's role.
export const PHASE_ART = {
  nightGuard: 'guard', nightWolves: 'wolf', nightWitch: 'witch', nightSeer: 'seer', hunterShoot: 'hunter',
};
