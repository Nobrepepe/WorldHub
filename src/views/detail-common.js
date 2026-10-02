import { el, clear, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { field, textInput, textArea, selectInput, tagsInput } from '../ui/forms.js';
import { createAutosaver } from '../ui/autosave.js';
import { artImg, loadRenditionWhenVisible } from '../ui/art.js';
import { navigate } from '../router.js';
import { confirmOverlay } from '../ui/overlay.js';
import { showToast } from '../ui/toast.js';
import { getState } from '../store.js';
import { openConnectionDrawer } from './connections.js';
import { backLink } from '../ui/back-link.js';
import { groupAssetsByRole, aspectForRecipe, ratioLabel, tileColumnRem, previewRecipeForRole } from '../ui/asset-roles.js';

/**
 * Shared machinery for world, character, and entry detail screens:
 * header, tabbed sections, autosaved profile forms, and the Usage view.
 */

export function detailHeader(entity, { eyebrow }) {
  const head = el('header', { class: 'page-head' });
  if (entity.artUrl) {
    /* The art owns the top of the window. The way back rides on it
       rather than pushing it down, carried by a scrim of its own so the
       label stays legible over a bright composition without a box. */
    head.append(el('div', { class: 'hero detail-hero' },
      backLink(),
      artImg(entity.artUrl, { alt: entity.name, className: 'hero-art art-bleed', assetId: entity.artAssetId, recipeId: entity.artRecipeId }),
      el('div', { class: 'hero-veil' }),
      el('div', { class: 'hero-glow' }),
    ));
  } else {
    head.append(backLink());
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
    // A slot previews at its role's own shape unless it names another,
    // so the convention lives in one place and cannot drift per screen.
    const recipeId = slot.recipeId ?? previewRecipeForRole(slot.role);
    const candidates = await call('asset.list', { entityId: entity.id, role: slot.role, kind: 'image', status: 'active', recipeId });
    const selectedId = entity.profile[slot.dbKey] ?? '';
    const selected = candidates.find((asset) => asset.id === selectedId);
    const preview = el('div', { style: { marginTop: '0.5rem', maxWidth: slot.previewWidth ?? '18rem' } });
    if (selected) {
      const rendition = await callSafe('rendition.generate', { versionId: selected.currentVersionId, recipeId });
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

/**
 * Fold state for role folders, kept for the session so switching tabs or
 * walking away to an asset and back does not reopen what was put away.
 * Keyed by record and role, because a folder is only closed for the
 * record it was closed on.
 */
const collapsedRoleFolders = new Set();

/**
 * Assets linked to this entity, in a folder per semantic role.
 *
 * Everything in one grid stops being browsable once a record carries a
 * few dozen images, and one house crop misrepresents most of them. Each
 * folder previews its art at the shape that role is published at.
 */
export async function assetsSection(entity) {
  const host = el('div', { class: 'section' });
  const [assets, recipes] = await Promise.all([
    callSafe('asset.list', { entityId: entity.id }).then((value) => value ?? []),
    callSafe('recipe.list').then((value) => value ?? []),
  ]);
  if (assets.length === 0) {
    host.append(el('p', { class: 'empty-state' }, 'No artwork or files are associated yet. File imports from the Inbox, or import directly on the Assets screen.'));
    return host;
  }
  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const folders = groupAssetsByRole(assets);
  for (const folder of folders) {
    host.append(roleFolder(entity, folder, recipeById.get(folder.recipeId)));
  }
  return host;
}

/** One role's folder: a folding head, and a gallery cut to that shape. */
function roleFolder(entity, folder, recipe) {
  const foldKey = `${entity.id}:${folder.role}`;
  const section = el('div', { class: 'section role-folder' });
  const body = el('div', {});
  const mark = el('span', { class: 'fold-mark' }, '▾');
  const shape = ratioLabel(recipe);
  const count = folder.assets.length;

  let loaded = false;
  const fill = async () => {
    if (loaded) return;
    loaded = true;
    // Refetched under this one role so each preview arrives already cut
    // to the role's recipe rather than flashing through the house crop.
    const scoped = folder.role
      ? await callSafe('asset.list', { entityId: entity.id, role: folder.role, recipeId: folder.recipeId })
      : null;
    clear(body);
    body.append(roleGallery(scoped ?? folder.assets, folder.recipeId, recipe));
  };

  const fold = (collapsed) => {
    if (collapsed) collapsedRoleFolders.add(foldKey);
    else collapsedRoleFolders.delete(foldKey);
    body.hidden = collapsed;
    mark.textContent = collapsed ? '▸' : '▾';
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (!collapsed) fill();
  };
  const header = el('button', {
    class: 'btn fold-head', type: 'button', 'aria-expanded': 'true',
    onclick: () => fold(!collapsedRoleFolders.has(foldKey)),
  },
    mark,
    el('span', { class: 'eyebrow' }, folder.label),
    el('span', { class: 'quiet' }, [`${count} ${count === 1 ? 'item' : 'items'}`, shape].filter(Boolean).join(' · ')),
  );

  section.append(header, body);
  fold(collapsedRoleFolders.has(foldKey));
  return section;
}

function roleGallery(assets, recipeId, recipe) {
  const gallery = el('div', { class: 'gallery role-gallery', role: 'list' });
  gallery.style.setProperty('--tile-aspect', aspectForRecipe(recipe));
  gallery.style.setProperty('--tile-min', `${tileColumnRem(recipe)}rem`);
  for (const asset of assets) {
    const art = asset.kind === 'image'
      ? artImg(asset.thumbUrl, { alt: asset.title })
      : el('div', { class: 'no-art' }, asset.kind.toUpperCase());
    const tile = el('div', {
      class: 'gallery-item',
      role: 'listitem',
      tabindex: '0',
      'aria-label': asset.title,
      onclick: () => navigate(`/asset/${asset.id}`),
      onkeydown: (e) => { if (e.key === 'Enter') navigate(`/asset/${asset.id}`); },
    },
      art,
      el('div', { class: 'g-name' }, asset.title),
      el('div', { class: 'g-sub' }, otherRolesLine(asset)),
    );
    gallery.append(tile);
    if (asset.kind === 'image' && !getState().library?.readOnly) {
      loadRenditionWhenVisible(tile, art, { versionId: asset.currentVersionId, recipeId });
    }
  }
  return gallery;
}

/**
 * Inside a role folder the folder already names the role, so the caption
 * spends its line on what the folder cannot say: the kind, and any other
 * role this same art also serves.
 */
function otherRolesLine(asset) {
  const own = new Set(asset.entityRoles ?? []);
  const elsewhere = (asset.roles ?? []).filter((role) => !own.has(role));
  const extra = [...own].slice(1).concat(elsewhere);
  return [asset.kind, ...extra].join(' · ');
}

/**
 * One record's connections, written from its own side.
 *
 * Every section, its heading, the label each row wears and the action that
 * adds to it come from the kinds themselves — so a group opens on its
 * Members and offers to add one, and a character opens on its People, with
 * no screen holding a list of headings per entity type.
 */
export async function connectionsSection(entity) {
  const host = el('div', { class: 'section' });
  const readOnly = getState().library?.readOnly;

  const render = async () => {
    clear(host);
    const [sections, offered] = await Promise.all([
      call('connection.forEntity', { id: entity.id }),
      call('connection.kindsForType', { entityType: entity.type, includeLegacy: true }),
    ]);

    if (sections.length === 0) {
      host.append(el('p', { class: 'empty-state' }, emptyStateFor(entity.type)));
    }

    for (const section of sections) {
      const block = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, section.name));
      const list = el('ul', { class: 'row-list' });
      for (const item of section.items) list.append(connectionItemRow(entity, item, render, readOnly));
      block.append(list);

      /* The offer belongs where the reader already is: under Members, the
         thing to add is a member. Which kinds those are is read from the
         same definitions that named the heading. */
      const sectionKinds = offered.filter((kind) => kind.section === section.name);
      if (!readOnly && sectionKinds.length > 0) {
        block.append(el('p', { style: { marginTop: '0.5rem' } },
          el('button', {
            class: 'btn',
            onclick: async () => {
              const added = await openConnectionDrawer({
                entity, presetKinds: sectionKinds.map((kind) => kind.id),
              });
              if (added) render();
            },
          }, addLabel(section, sectionKinds)),
        ));
      }
      host.append(block);
    }

    if (!readOnly) {
      host.append(el('p', { style: { marginTop: '1.2rem' } },
        el('button', {
          class: 'btn',
          onclick: async () => {
            if (await openConnectionDrawer({ entity })) render();
          },
        }, 'Connect to another record →'),
      ));
    }
  };
  await render();
  return host;
}

function connectionItemRow(entity, item, render, readOnly) {
  const href = hrefForEntity(item.otherType, item.otherId);
  return el('li', {
    class: 'row', tabindex: '0',
    onclick: () => navigate(href),
    onkeydown: (e) => { if (e.key === 'Enter') navigate(href); },
  },
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, item.otherName),
      el('div', { class: 'row-sub' },
        [item.label, item.legacy ? 'carried over' : null, item.description].filter(Boolean).join(' · ')),
    ),
    !readOnly ? el('div', { class: 'row-side' },
      el('button', {
        class: 'btn',
        'aria-label': `Edit the connection to ${item.otherName}`,
        onclick: async (e) => {
          e.stopPropagation();
          if (await openConnectionDrawer({ entity, existing: item })) render();
        },
      }, 'Edit'),
      ' ',
      el('button', {
        class: 'btn btn-danger',
        'aria-label': `Remove the connection to ${item.otherName}`,
        onclick: async (e) => {
          e.stopPropagation();
          const confirmed = await confirmOverlay({
            title: 'Remove this connection?',
            body: item.sentence,
            guarantee: 'Only the connection goes. Both records are left exactly as they are.',
            confirmLabel: 'Remove the connection',
            danger: true,
          });
          if (confirmed) {
            await callSafe('connection.delete', { id: item.id });
            render();
          }
        },
      }, 'Remove'),
    ) : null,
  );
}

/** "Add a member →" when the heading means one thing, "Add to …" when several. */
function addLabel(section, kinds) {
  if (kinds.length === 1) {
    const noun = kinds[0].label.toLowerCase();
    return `Add ${'aeiou'.includes(noun[0]) ? 'an' : 'a'} ${noun} →`;
  }
  return `Add to ${section.name.toLowerCase()} →`;
}

function hrefForEntity(type, id) {
  if (type === 'world') return `/world/${id}`;
  if (type === 'character') return `/character/${id}`;
  return `/entry/${id}`;
}

/** What this kind of record is usually connected to, said in its own terms. */
function emptyStateFor(type) {
  const guidance = {
    world: 'Nothing is connected yet. A world holds its records through their own world field; connections are for the facts between them.',
    character: 'Nothing is connected yet — name the people this character knows, the groups they belong to, and where they live.',
    group: 'Nothing is connected yet. A group is mostly its members: add the people who belong to it and whoever leads it.',
    location: 'Nothing is connected yet — add who lives here, which groups operate here, and what this place contains.',
    species: 'Nothing is connected yet — add the characters who belong to this species and where it comes from.',
    object: 'Nothing is connected yet — add who owns, wields or made this, and where it is kept.',
    event: 'Nothing is connected yet — add who took part, where it happened, and which objects mattered.',
    lore: 'Nothing is connected yet — name the records this lore is about.',
  };
  return guidance[type] ?? 'Nothing is connected yet.';
}

/** A computed one-line reading of what a record's connections amount to. */
export async function connectionSummaryLine(entity) {
  const summary = await callSafe('connection.summary', { id: entity.id });
  if (!summary || summary.total === 0) return null;
  return el('p', { class: 'meta-line' }, summary.line);
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
    block('Connections', usage.connections, (connection) =>
      linkRow(`${connection.sourceName} — ${connection.label} — ${connection.targetName}`, connection.kindId, '/connections')),
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
        const affected = usage.documents.length + usage.connections.length + usage.assets.length + usage.productions.length + usage.children.length;
        const confirmed = await confirmOverlay({
          title: `Archive ${entity.name}?`,
          body: affected === 0
            ? 'Nothing references this record.'
            : `This record is referenced by ${usage.documents.length} document(s), ${usage.connections.length} connection(s), ${usage.assets.length} asset link(s), ${usage.productions.length} production(s), and ${usage.children.length} member record(s). They keep their links.`,
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
