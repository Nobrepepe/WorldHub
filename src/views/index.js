import { registerRoute } from '../router.js';
import { renderHome } from './home.js';
import { renderSearchPage } from './search.js';
import { renderWorlds, renderWorldDetail } from './worlds.js';
import { renderCharacters, renderCharacterDetail } from './characters.js';
import { renderEntries, renderEntryDetail } from './entries.js';
import { renderRelationships } from './relationships.js';

/** Route registration for every view. Views are added per domain. */
export function registerAllViews() {
  registerRoute('/home', renderHome);
  registerRoute('/search', renderSearchPage);
  registerRoute('/worlds', renderWorlds);
  registerRoute('/world/:id', renderWorldDetail);
  registerRoute('/characters', renderCharacters);
  registerRoute('/character/:id', renderCharacterDetail);
  registerRoute('/entries', renderEntries);
  registerRoute('/entry/:id', renderEntryDetail);
  registerRoute('/relationships', renderRelationships);
}
