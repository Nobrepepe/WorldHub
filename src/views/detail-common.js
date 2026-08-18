import { el, clear, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { field, textInput, textArea, selectInput, tagsInput } from '../ui/forms.js';
import { createAutosaver } from '../ui/autosave.js';
import { artImg } from '../ui/art.js';
import { navigate } from '../router.js';
import { confirmOverlay } from '../ui/overlay.js';
import { showToast } from '../ui/toast.js';
import { getState } from '../store.js';
import { openRelationshipEditor, relationshipRow } from './relationships.js';

/**
 * Shared machinery for world, character, and entry detail screens:
 * header, tabbed sections, autosaved profile forms, and the Usage view.
 */

export function detailHeader(entity, { eyebrow }) {
  const head = el('header', { class: 'page-head' });
  if (entity.artUrl) {
    head.append(el('div', { class: 'hero detail-hero' },
      artImg(entity.artUrl, { alt: entity.name, className: 'hero-art art-bleed', assetId: entity.artAssetId, recipeId: entity.artRecipeId }),
      el('div', { class: 'hero-glow' }),
    ));
  }
  head.append(
    el('span', { class: 'eyebrow' }, eyebrow),
    el('h1', {}, entity.name),
    el('p', { class: 'meta-line' },
      statusSentence(entity),
    ),
  );
  return head;
}

export async function resolveEntityArt(entity, recipeId, slot) {
  const art = await callSafe('entity.preferredArt', { id: entity.id, recipeId, slot });
  return art ?? { assetId: null, versionId: null, recipeId, url: null };
}

export async function displayArtSection(entity, slots, onChanged) {
  const host = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Display art'));
  const readOnly = getState().library?.readOnly;
  for (const slot of slots) {
    const candidates = await call('asset.list', { entityId: entity.id, role: slot.role, kind: 'image', status: 'active' });
    const selectedId = entity.profile[slot.dbKey] ?? '';
    const selected = candidates.find((asset) => asset.id === selectedId);
    const preview = el('div', { style: { marginTop: '0.5rem', maxWidth: slot.previewWidth ?? '18rem' } });
    if (selected) {
      const rendition = await callSafe('rendition.generate', { versionId: selected.currentVersionId, recipeId: slot.recipeId });
      preview.append(artImg(rendition?.url ?? selected.thumbUrl, { alt: `${entity.name} ${slot.label}` }));
    } else if (selectedId) {
      preview.append(el('p', { class: 'state-bad' }, 'The selected asset is archived or no longer associated under the required role. Choose a replacement or clear this selection.'));
    } else {
      preview.append(el('p', { class: 'section-note' }, candidates.length ? 'No preferred asset selected; the first compatible association is used as a fallback.' : 'Associate an active image under this role to make it available.'));
    }
    const select = selectInput({
      value: selectedId,
      ariaLabel: slot.label,
      options: [
        { value: '', label: 'No explicit selection' },
        ...candidates.map((asset) => ({ value: asset.id, label: asset.title })),
      ],
      onChange: async (assetId) => {
        if (readOnly) return;
        const updated = await call('entity.update', { id: entity.id, profile: { [slot.profileKey]: assetId || null } });
        onChanged?.(updated);
      },
    });
    select.disabled = readOnly;
    host.append(field(slot.label, el('div', {}, select, preview), { hint: `Only active images associated as ${slot.role} are shown.` }));
  }
  return host;
}

export function statusSentence(entity) {
  const parts = [];
  if (entity.status === 'draft') parts.push('Draft');
  else if (entity.status === 'canonical') parts.push('Canonical');
  else if (entity.status === 'archived') parts.push('Archived');
  parts.push(`revision ${entity.revision}`);
  if (entity.updatedAt) parts.push(`updated ${formatDate(entity.updatedAt)}`);
  return parts.join(' · ');
}

export function tabbedSections(tabs, initial = 0) {
  const tabBar = el('div', { class: 'tabs', role: 'tablist' });
  const body = el('div', {});
  let current = -1;

  const activate = async (index) => {
    if (index === current) return;
    current = index;
    [...tabBar.children].forEach((node, i) => {
      node.classList.toggle('active', i === index);
      node.setAttribute('aria-selected', i === index ? 'true' : 'false');
    });
    clear(body);
    const content = await tabs[index].render();
    clear(body);
    body.append(content);
  };

  tabs.forEach((tab, index) => {
    tabBar.append(el('button', {
      class: 'tab',
      role: 'tab',
      'aria-selected': 'false',
      onclick: () => activate(index),
    }, tab.label));
  });
  activate(initial);
  return el('div', {}, tabBar, body);
}

/** Autosaved base fields shared by every entity type. */
export function baseFieldsSection(entity, { onSaved } = {}) {
  const patch = {};
  const saver = createAutosaver({
    save: async () => {
      const updated = await call('entity.update', { id: entity.id, ...patch });
      Object.keys(patch).forEach((key) => delete patch[key]);
      onSaved?.(updated);
    },
  });
  const readOnly = getState().library?.readOnly;
  const change = (key) => (value) => {
    if (readOnly) return;
    patch[key] = value;
    saver.markDirty();
  };

  const host = el('div', {},
    el('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, saver.stateEl),
    field('Name', textInput({ value: entity.name, onInput: change('name'), ariaLabel: 'Name' })),
    field('Summary', textArea({ value: entity.summary, rows: 3, onInput: change('summary'), ariaLabel: 'Summary' }),
      { hint: 'A concise line or two for browsing and reuse. Long material belongs in a linked document.' }),
    field('Lifecycle', selectInput({
      value: entity.status,
      options: [
        { value: 'draft', label: 'Draft — still forming' },
        { value: 'canonical', label: 'Canonical — settled truth' },
      ],
      onChange: change('status'),
      ariaLabel: 'Lifecycle status',
    })),
    field('Slug', textInput({ value: entity.slug, onInput: change('slug'), ariaLabel: 'Slug' }),
      { hint: 'Stable handle used in links and folders. Renaming the record does not change it.' }),
    field('Tags', tagsInput({
      tags: entity.tags ?? [],
      onSave: async (names) => {
        await callSafe('tag.setForSubject', { subjectType: 'entity', subjectId: entity.id, tags: names });
      },
    })),
  );
  return { host, saver };
}

export function profileField(label, key, value, change, { multiline = false, hint } = {}) {
  const input = multiline
    ? textArea({ value: value ?? '', rows: 3, onInput: change(key), ariaLabel: label })
    : textInput({ value: value ?? '', onInput: change(key), ariaLabel: label });
  return field(label, input, { hint });
}

/** Documents linked to this entity. */
export async function documentsSection(entity) {
  const usage = await call('entity.usage', { id: entity.id });
  const host = el('div', { class: 'section' });
  if (usage.documents.length === 0) {
    host.append(el('p', { class: 'empty-state' }, 'No documents yet — long-form writing linked here will appear in this list.'));
  } else {
    const list = el('ul', { class: 'row-list' });
    for (const doc of usage.documents) {
      list.append(el('li', {
        class: 'row',
        tabindex: '0',
        onclick: () => navigate(`/document/${doc.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/document/${doc.id}`); },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, doc.title),
          el('div', { class: 'row-sub' }, doc.status),
        ),
      ));
    }
    host.append(list);
  }
  host.append(el('p', { style: { marginTop: '0.8rem' } },
    el('button', {
      class: 'btn',
      onclick: async () => {
        const created = await callSafe('document.create', { title: `${entity.name} — notes`, entityIds: [entity.id] });
        if (created) navigate(`/document/${created.id}`);
      },
    }, 'Write a new document →'),
  ));
  return host;
}

/** Assets linked to this entity. */
export async function assetsSection(entity) {
  const assets = await callSafe('asset.list', { entityId: entity.id }) ?? [];
  const host = el('div', { class: 'section' });
  if (assets.length === 0) {
    host.append(el('p', { class: 'empty-state' }, 'No artwork or files are associated yet. File imports from the Inbox, or import directly on the Assets screen.'));
    return host;
  }
  const gallery = el('div', { class: 'gallery portraits' });
  for (const asset of assets) {
    gallery.append(el('div', {
      class: 'gallery-item',
      tabindex: '0',
      role: 'link',
      'aria-label': asset.title,
      onclick: () => navigate(`/asset/${asset.id}`),
      onkeydown: (e) => { if (e.key === 'Enter') navigate(`/asset/${asset.id}`); },
    },
      artImg(asset.thumbUrl, { alt: asset.title }),
      el('div', { class: 'g-name' }, asset.title),
      el('div', { class: 'g-sub' }, [asset.kind, ...(asset.roles ?? [])].join(' · ')),
    ));
  }
  host.append(gallery);
  return host;
}

/** Relationship list + editor for one entity. */
export async function relationshipsSection(entity) {
  const host = el('div', { class: 'section' });
  const render = async () => {
    clear(host);
    const relationships = await call('relationship.list', { entityId: entity.id });
    if (relationships.length === 0) {
      host.append(el('p', { class: 'empty-state' }, 'No relationships yet.'));
    } else {
      const list = el('ul', { class: 'row-list' });
      for (const rel of relationships) {
        list.append(relationshipRow(rel, { perspectiveId: entity.id, onChanged: render }));
      }
      host.append(list);
    }
    host.append(el('p', { style: { marginTop: '0.8rem' } },
      el('button', {
        class: 'btn',
        onclick: async () => {
          const created = await openRelationshipEditor({ sourceId: entity.id, sourceName: entity.name });
          if (created) render();
        },
      }, 'Relate to another record →'),
    ));
  };
  await render();
  return host;
}

/** Usage: everything that references this entity. */
export async function usageSection(entity) {
  const usage = await call('entity.usage', { id: entity.id });
  const host = el('div', { class: 'section' });

  const block = (label, rows, renderRow) => {
    const section = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, label));
    if (rows.length === 0) {
      section.append(el('p', { class: 'section-note' }, 'None.'));
    } else {
      const list = el('ul', { class: 'row-list' });
      rows.forEach((row) => list.append(renderRow(row)));
      section.append(list);
    }
    return section;
  };

  host.append(
    block('Documents', usage.documents, (doc) => linkRow(doc.title, doc.status, `/document/${doc.id}`)),
    block('Relationships', usage.relationships, (rel) =>
      linkRow(`${rel.source_name} — ${rel.label || rel.rel_type} — ${rel.target_name}`, rel.rel_type, '/relationships')),
    block('Assets', usage.assets, (asset) => linkRow(asset.title, asset.role, `/asset/${asset.id}`)),
    block('Productions', usage.productions, (production) => linkRow(production.name, production.status, `/production/${production.id}`)),
  );
  if (usage.children.length > 0) {
    host.append(block('Belongs to this world', usage.children, (child) =>
      linkRow(child.name, child.type, child.type === 'character' ? `/character/${child.id}` : `/entry/${child.id}`)));
  }
  return host;
}

function linkRow(title, sub, href) {
  return el('li', {
    class: 'row',
    tabindex: '0',
    onclick: () => navigate(href),
    onkeydown: (e) => { if (e.key === 'Enter') navigate(href); },
  },
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, title),
      el('div', { class: 'row-sub' }, sub ?? ''),
    ),
  );
}

/** Archive / restore controls with a usage preview before archiving. */
export function archiveControls(entity, { onChanged }) {
  const host = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Care'));
  if (entity.status !== 'archived') {
    host.append(el('button', {
      class: 'btn btn-danger',
      onclick: async () => {
        const usage = await call('entity.usage', { id: entity.id });
        const affected = usage.documents.length + usage.relationships.length + usage.assets.length + usage.productions.length + usage.children.length;
        const confirmed = await confirmOverlay({
          title: `Archive ${entity.name}?`,
          body: affected === 0
            ? 'Nothing references this record.'
            : `This record is referenced by ${usage.documents.length} document(s), ${usage.relationships.length} relationship(s), ${usage.assets.length} asset link(s), ${usage.productions.length} production(s), and ${usage.children.length} member record(s). They keep their links.`,
          guarantee: 'Nothing is deleted. Archived records stay in old publications and can be restored at any time.',
          confirmLabel: 'Archive this record',
          danger: true,
        });
        if (confirmed) {
          const updated = await callSafe('entity.archive', { id: entity.id });
          if (updated) { showToast(`${entity.name} was archived.`, 'good'); onChanged?.(updated); }
        }
      },
    }, 'Archive this record'));
  } else {
    host.append(
      el('p', { class: 'section-note' }, 'This record is archived. It stays visible in old publications.'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const updated = await callSafe('entity.restore', { id: entity.id });
          if (updated) { showToast(`${entity.name} was restored to draft.`, 'good'); onChanged?.(updated); }
        },
      }, 'Restore to draft →'),
    );
  }
  return host;
}
