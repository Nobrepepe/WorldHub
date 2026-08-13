/**
 * Central place where every IPC command module is registered.
 * Each module calls register() from ./registry.js at import time.
 */
import './commands/app-commands.js';
import './commands/library-commands.js';

export function registerAllCommands() {
  // Importing the modules above performs registration; this function
  // exists so main.js expresses intent explicitly.
}
