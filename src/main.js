/**
 * The renderer entry point.
 *
 * It exists so that starting the application is something a page does, not
 * something importing a module does: `app.js` exports helpers that four view
 * modules need, and while it booted on import, reading the route table meant
 * booting the shell.
 */
import { start } from './app.js';

start();
