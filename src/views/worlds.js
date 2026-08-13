import { el, clear } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { artImg } from '../ui/art.js';
import { navigate } from '../router.js';
import { openOverlay } from '../ui/overlay.js';
import { showToast } from '../ui/toast.js';
import { textInput } from '../ui/forms.js';
import { getState } from '../store.js';
import {
  detailHeader, tabbedSections, baseFieldsSection, profileField,
  documentsSection, assetsSection, relationshipsSection, usageSection, archiveControls,
} from './detail-common.js';
import { createAutosaver } from '../ui/autosave.js';

export async function renderWorlds() {
  const readOnly = getState().library?.readOnly;
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Canon'),
      el('h1', {}, 'Worlds'),
    ),
  );

  const filter = { text: '', showArchived: false };
  const galleryHost = el('div', {});

  const render = async () => {
    clear(galleryHost);
    const worlds = await call('entity.list', {
      type: 'world',
      status: filter.showArchived ? 'archived' : undefined,
    });
    const q = filter.text.trim().toLowerCase();
    const visible = q ? worlds.filter((world) => world.name.toLowerCase().includes(q)) : worlds;

    if (visible.length === 0) {
      galleryHost.append(el('p', { class: 'empty-state' },
        worlds.length === 0
          ? 'No worlds yet — a world is the first record everything else belongs to.'
          : 'No worlds match the filter.'));
      return;
    }
    const gallery = el('div', { class: 'gallery', role: 'list' });
    for (const world of visible) {
      gallery.append(el('div', {
        class: 'gallery-item',
        role: 'listitem',
        tabindex: '0',
        'aria-label': world.name,
        onclick: () => navigate(`/world/${world.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/world/${world.id}`); },
      },
        artImg(world.artUrl, { alt: world.name }),
        el('div', { class: 'g-name' }, world.name),
        el('div', { class: 'g-sub' }, world.status === 'archived' ? 'archived' : world.summary || ' '),
      ));
    }
    galleryHost.append(gallery);
  };

  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'field grow' },
      el('span', { class: 'eyebrow' }, 'Filter'),
      textInput({ ariaLabel: 'Filter worlds', onInput: (value) => { filter.text = value; render(); } }),
    ),
    el('label', { style: { display: 'flex', gap: '0.4rem', alignItems: 'center' } },
      el('input', { type: 'checkbox', onchange: (e) => { filter.showArchived = e.target.checked; render(); } }),
      'Show archived',
    ),
    !readOnly ? el('button', { class: 'btn btn-primary', onclick: () => createWorldFlow() }, 'Create a world →') : null,
  );

  const createWorldFlow = () => {
    openOverlay((close) => {
      const nameInput = el('input', { type: 'text', placeholder: 'Name the world', 'aria-label': 'World name' });
      return el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          const name = nameInput.value.trim();
          if (!name) return;
          try {
            const world = await call('entity.create', { type: 'world', name });
            close();
            navigate(`/world/${world.id}`);
          } catch (err) { showToast(err.message, 'error'); }
        },
      },
        el('h2', {}, 'Create a world'),
        el('p', { class: 'dim' }, 'Only a name is needed to begin. Everything else grows on its detail screen.'),
        el('div', { class: 'field', style: { marginTop: '1rem' } }, nameInput),
        el('div', { class: 'overlay-actions' },
          el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create the world →'),
          el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        ),
      );
    }, { label: 'Create a world' });
  };

  const newListener = (e) => { if (e.detail?.section === '/worlds' && !readOnly) createWorldFlow(); };
  document.addEventListener('worldhub:new-item', newListener, { once: true });

  host.append(toolbar, galleryHost);
  await render();
  return host;
}

export async function renderWorldDetail({ id }) {
  let entity = await call('entity.get', { id });
  const host = el('div', { class: 'main-inner wide' });
  const head = detailHeader(entity, { eyebrow: 'World' });
  host.append(head);

  const overview = () => {
    const container = el('div', { style: { maxWidth: '44rem' } });
    const { host: baseHost } = baseFieldsSection(entity, { onSaved: (updated) => { entity = updated; } });

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
    container.append(
      baseHost,
      el('hr', { class: 'rule' }),
      el('div', { class: 'section' },
        el('span', { class: 'eyebrow' }, 'World profile'),
        el('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, saver.stateEl),
        profileField('Tagline', 'tagline', p.tagline, change),
        profileField('Genre', 'genre', p.genre, change),
        profileField('Tone', 'tone', p.tone, change),
        profileField('Setting, in short', 'settingDescription', p.setting_description, change, { multiline: true }),
        profileField('Visual direction', 'visualDirection', p.visual_direction, change, { multiline: true }),
      ),
      archiveControls(entity, { onChanged: () => navigate(`/world/${entity.id}`) }),
    );
    return container;
  };

  host.append(tabbedSections([
    { label: 'Overview', render: overview },
    { label: 'Characters', render: () => membersSection(entity, 'character') },
    { label: 'Entries', render: () => membersSection(entity, 'entry') },
    { label: 'Documents', render: () => documentsSection(entity) },
    { label: 'Assets', render: () => assetsSection(entity) },
    { label: 'Relationships', render: () => relationshipsSection(entity) },
    { label: 'Usage', render: () => usageSection(entity) },
  ]));
  return host;
}

/** Characters or entries living in this world. */
async function membersSection(world, kind) {
  const types = kind === 'character' ? ['character'] : ['location', 'group', 'species', 'object', 'event', 'lore'];
  const members = await call('entity.list', { types, worldId: world.id });
  const host = el('div', { class: 'section' });
  const readOnly = getState().library?.readOnly;

  if (members.length === 0) {
    host.append(el('p', { class: 'empty-state' },
      kind === 'character'
        ? `No characters live in ${world.name} yet.`
        : `No entries describe ${world.name} yet — locations, groups, species, objects, events, and lore all belong here.`));
  } else if (kind === 'character') {
    const gallery = el('div', { class: 'gallery portraits' });
    for (const member of members) {
      gallery.append(el('div', {
        class: 'gallery-item', tabindex: '0', 'aria-label': member.name,
        onclick: () => navigate(`/character/${member.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/character/${member.id}`); },
      },
        artImg(member.artUrl, { alt: member.name }),
        el('div', { class: 'g-name' }, member.name),
        el('div', { class: 'g-sub' }, member.summary || member.status),
      ));
    }
    host.append(gallery);
  } else {
    const list = el('ul', { class: 'row-list' });
    for (const member of members) {
      list.append(el('li', {
        class: 'row', tabindex: '0',
        onclick: () => navigate(`/entry/${member.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/entry/${member.id}`); },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, member.name),
          el('div', { class: 'row-sub' }, `${member.type}${member.summary ? ` · ${member.summary}` : ''}`),
        ),
      ));
    }
    host.append(list);
  }

  if (!readOnly) {
    host.append(el('p', { style: { marginTop: '0.8rem' } },
      el('button', {
        class: 'btn',
        onclick: () => {
          if (kind === 'character') createNamedEntity('character', world.id, (created) => navigate(`/character/${created.id}`));
          else createEntryFlow(world.id, (created) => navigate(`/entry/${created.id}`));
        },
      }, kind === 'character' ? 'Create a character here →' : 'Create an entry here →'),
    ));
  }
  return host;
}

export function createNamedEntity(type, worldId, onCreated) {
  openOverlay((close) => {
    const nameInput = el('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Name' });
    return el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return;
        try {
          const created = await call('entity.create', { type, name, worldId: worldId ?? undefined });
          close();
          onCreated(created);
        } catch (err) { showToast(err.message, 'error'); }
      },
    },
      el('h2', {}, `Create a ${type}`),
      el('div', { class: 'field', style: { marginTop: '1rem' } }, nameInput),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit' }, `Create the ${type} →`),
        el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      ),
    );
  }, { label: `Create a ${type}` });
}

export function createEntryFlow(worldId, onCreated) {
  openOverlay((close) => {
    const nameInput = el('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Name' });
    const typeSelect = el('select', { 'aria-label': 'Entry type' });
    for (const t of ['location', 'group', 'species', 'object', 'event', 'lore']) {
      typeSelect.append(el('option', { value: t }, t));
    }
    return el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return;
        try {
          const created = await call('entity.create', { type: typeSelect.value, name, worldId: worldId ?? undefined });
          close();
          onCreated(created);
        } catch (err) { showToast(err.message, 'error'); }
      },
    },
      el('h2', {}, 'Create an entry'),
      el('div', { class: 'field', style: { marginTop: '1rem' } }, el('span', { class: 'eyebrow' }, 'Kind'), typeSelect),
      el('div', { class: 'field' }, el('span', { class: 'eyebrow' }, 'Name'), nameInput),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create the entry →'),
        el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      ),
    );
  }, { label: 'Create an entry' });
}
