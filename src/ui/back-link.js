import { el } from './dom.js';
import { backDestination, goBack, currentPath } from '../router.js';

/**
 * The way out of a detail screen, named after the room it returns to:
 * "← Worlds", "← Aetheria" — a destination, never the word "Back".
 *
 * It is a real link, so the destination is announced and the keyboard
 * reaches it in reading order, but the click travels through the router
 * so a half-written field is saved before the screen is left.
 */
export function backLink() {
  const target = backDestination(currentPath());
  return el('a', {
    class: 'back-link',
    href: `#${target.path}`,
    'aria-label': `Back to ${target.title}`,
    onclick: (event) => {
      event.preventDefault();
      goBack().catch(console.error);
    },
  },
    el('span', { class: 'back-mark', 'aria-hidden': 'true' }, '←'),
    el('span', { class: 'back-where' }, target.title),
  );
}
