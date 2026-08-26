import { el, clear } from '../ui/dom.js';
import { call } from '../ipc.js';
import { artImg } from '../ui/art.js';
import { navigate } from '../router.js';
import { textInput, selectInput, field } from '../ui/forms.js';
import { getState } from '../store.js';
import { createNamedEntity } from './worlds.js';
import {
  detailHeader, tabbedSections, baseFieldsSection, profileField, displayArtSection, resolveEntityArt,
  documentsSection, assetsSection, relationshipsSection, usageSection, archiveControls,
} from './detail-common.js';
import { createAutosaver } from '../ui/autosave.js';
import { pickEntity } from '../ui/entity-picker.js';

export async function renderCharacters() {
  const readOnly = getState().library?.readOnly;
  const worlds = await call('entity.list', { type: 'world' });
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Canon'),
      el('h1', {}, 'Characters'),
    ),
  );

  const filter = { text: '', worldId: '', status: '', missingArt: false };
  const galleryHost = el('div', {});

  const render = async () => {
    clear(galleryHost);
    const characters = await call('entity.list', {
      type: 'character',
      worldId: filter.worldId || undefined,
      status: filter.status || undefined,
    });
    const q = filter.text.trim().toLowerCase();
    let visible = q ? characters.filter((c) => c.name.toLowerCase().includes(q)) : characters;
    if (filter.missingArt) visible = visible.filter((c) => !c.artUrl);
    await Promise.all(visible.map(async (character) => {
      const art = await resolveEntityArt(character, 'portrait_3x4', 'portrait');
      Object.assign(character, { artUrl: art.url, artAssetId: art.assetId, artRecipeId: art.recipeId });
    }));

    if (visible.length === 0) {
      galleryHost.append(el('p', { class: 'empty-state' },
        characters.length === 0 ? 'No characters yet.' : 'No characters match the current filters.'));
      return;
    }
    const gallery = el('div', { class: 'gallery portraits', role: 'list' });
    for (const character of visible) {
      gallery.append(el('div', {
        class: 'gallery-item', role: 'listitem', tabindex: '0', 'aria-label': character.name,
        onclick: () => navigate(`/character/${character.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/character/${character.id}`); },
      },
        artImg(character.artUrl, { alt: character.name, assetId: character.artAssetId, recipeId: character.artRecipeId }),
        el('div', { class: 'g-name' }, character.name),
        el('div', { class: 'g-sub' }, [character.worldName, character.status === 'archived' ? 'archived' : null].filter(Boolean).join(' · ') || ' '),
      ));
    }
    galleryHost.append(gallery);
  };

  const createFlow = async () => {
    let worldId = filter.worldId || null;
    if (!worldId) {
      const picked = await pickEntity({ title: 'Which world does this character belong to?', types: ['world'] });
      if (!picked) return;
      worldId = picked.id;
    }
    createNamedEntity('character', worldId, (created) => navigate(`/character/${created.id}`));
  };

  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'field grow' },
      el('span', { class: 'eyebrow' }, 'Filter'),
      textInput({ ariaLabel: 'Filter characters', onInput: (value) => { filter.text = value; render(); } }),
    ),
    el('div', { class: 'field' },
      el('span', { class: 'eyebrow' }, 'World'),
      selectInput({
        value: '',
        options: [{ value: '', label: 'All worlds' }, ...worlds.map((w) => ({ value: w.id, label: w.name }))],
        onChange: (value) => { filter.worldId = value; render(); },
        ariaLabel: 'Filter by world',
      }),
    ),
    el('div', { class: 'field' },
      el('span', { class: 'eyebrow' }, 'Status'),
      selectInput({
        value: '',
        options: [
          { value: '', label: 'Draft and canonical' },
          { value: 'draft', label: 'Draft only' },
          { value: 'canonical', label: 'Canonical only' },
          { value: 'archived', label: 'Archived' },
        ],
        onChange: (value) => { filter.status = value; render(); },
        ariaLabel: 'Filter by status',
      }),
    ),
    el('label', { style: { display: 'flex', gap: '0.4rem', alignItems: 'center' } },
      el('input', { type: 'checkbox', onchange: (e) => { filter.missingArt = e.target.checked; render(); } }),
      'Missing art',
    ),
    !readOnly ? el('button', { class: 'btn btn-primary', onclick: createFlow }, 'Create a character →') : null,
  );

  document.addEventListener('worldhub:new-item', (e) => {
    if (e.detail?.section === '/characters' && !readOnly) createFlow();
  }, { once: true });

  host.append(toolbar, galleryHost);
  await render();
  return host;
}

export async function renderCharacterDetail({ id }) {
  let entity = await call('entity.get', { id });
  const art = await resolveEntityArt(entity, 'tile_16x9', 'tile');
  Object.assign(entity, { artUrl: art.url, artAssetId: art.assetId, artRecipeId: art.recipeId });
  const host = el('div', {});
  host.append(detailHeader(entity, { eyebrow: entity.world ? `Character · ${entity.world.name}` : 'Character' }));

  const overview = () => {
    const container = el('div', { style: { maxWidth: '44rem' } });
    const { host: baseHost } = baseFieldsSection(entity, { onSaved: (updated) => { entity = updated; } });

    const aliasSaver = createAutosaver({
      save: async () => {
        entity = await call('entity.update', { id: entity.id, aliases: aliasValue().split(',').map((s) => s.trim()).filter(Boolean) });
      },
    });
    const aliasInput = textInput({
      value: entity.aliases.join(', '),
      placeholder: 'comma, separated, aliases',
      ariaLabel: 'Aliases',
      onInput: () => aliasSaver.markDirty(),
    });
    const aliasValue = () => aliasInput.value;

    container.append(
      baseHost,
      field('Aliases', aliasInput, { hint: 'Ordered other names, first is most important.' }),
      el('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, aliasSaver.stateEl),
      archiveControls(entity, { onChanged: () => navigate(`/character/${entity.id}`) }),
    );
    return container;
  };

  const profileTab = async () => {
    const container = el('div', { style: { maxWidth: '44rem' } });
    const patch = { profile: {} };
    const saver = createAutosaver({
      save: async () => {
        entity = await call('entity.update', { id: entity.id, profile: { ...patch.profile } });
        patch.profile = {};
      },
    });
    const change = (key) => (value) => {
      if (getState().library?.readOnly) return;
      patch.profile[key] = value;
      saver.markDirty();
    };
    const p = entity.profile;
    const artSection = await displayArtSection(entity, [
      { label: 'Portrait', role: 'character.portrait', profileKey: 'portraitAssetId', dbKey: 'portrait_asset_id' },
      { label: 'Tile', role: 'character.tile', profileKey: 'tileAssetId', dbKey: 'tile_asset_id' },
    ], (updated) => { entity = updated; navigate(`/character/${entity.id}`); });
    container.append(
      el('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, saver.stateEl),
      profileField('Role', 'role', p.role, change),
      profileField('Age', 'ageText', p.age_text, change, { hint: 'Written as text — "ageless", "about forty", "young for a dragon" are all valid.' }),
      profileField('Appearance, in short', 'appearance', p.appearance, change, { multiline: true }),
      profileField('Personality, in short', 'personality', p.personality, change, { multiline: true }),
      profileField('Biography, in short', 'biography', p.biography, change, { multiline: true }),
      profileField('Voice, in short', 'voice', p.voice, change, { multiline: true }),
      artSection,
      el('p', { class: 'section-note', style: { marginTop: '1rem' } },
        'These stay concise on purpose. Full biographies, studies, and stories live as linked documents.'),
    );
    return container;
  };

  host.append(tabbedSections([
    { label: 'Overview', render: overview },
    { label: 'Profile', render: profileTab },
    { label: 'Documents', render: () => documentsSection(entity) },
    { label: 'Assets', render: () => assetsSection(entity) },
    { label: 'Relationships', render: () => relationshipsSection(entity) },
    { label: 'Usage', render: () => usageSection(entity) },
  ]));
  return host;
}
