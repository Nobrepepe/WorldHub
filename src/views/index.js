import { registerRoute } from '../router.js';
import { renderHome } from './home.js';
import { renderSearchPage } from './search.js';
import { renderWorlds, renderWorldDetail } from './worlds.js';
import { renderCharacters, renderCharacterDetail } from './characters.js';
import { renderEntries, renderEntryDetail } from './entries.js';
import { renderRelationships } from './relationships.js';
import { renderDocuments, renderDocumentDetail } from './documents.js';
import { renderAssets, renderAssetDetail } from './assets.js';
import { renderInbox } from './inbox.js';
import { renderContracts, renderContractDetail } from './contracts.js';
import { renderProductions, renderProductionDetail } from './productions.js';
import { renderPublishPreview, renderPublicationDetail } from './publications.js';

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
  registerRoute('/documents', renderDocuments);
  registerRoute('/document/:id', renderDocumentDetail);
  registerRoute('/assets', renderAssets);
  registerRoute('/asset/:id', renderAssetDetail);
  registerRoute('/inbox', renderInbox);
  registerRoute('/contracts', renderContracts);
  registerRoute('/contract/:id', renderContractDetail);
  registerRoute('/productions', renderProductions);
  registerRoute('/production/:id', renderProductionDetail);
  registerRoute('/production/:id/publish', renderPublishPreview);
  registerRoute('/publication/:id', renderPublicationDetail);
}
