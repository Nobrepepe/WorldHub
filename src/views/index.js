import { registerRoute } from '../router.js';
import { renderHome } from './home.js';

/** Route registration for every view. Views are added per domain. */
export function registerAllViews() {
  registerRoute('/home', renderHome);
}
