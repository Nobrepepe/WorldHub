/**
 * Central place where every IPC command module is registered.
 * Each module calls register() from ./registry.js at import time.
 */
import './commands/app-commands.js';
import './commands/library-commands.js';
import './commands/entity-commands.js';
import './commands/document-commands.js';
import './commands/asset-commands.js';
import './commands/inbox-commands.js';
import './commands/production-commands.js';

export function registerAllCommands() {
  // Importing the modules above performs registration; this function
  // exists so main.js expresses intent explicitly.
}
