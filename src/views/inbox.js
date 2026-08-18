import { el, clear, formatBytes } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { textInput, selectInput, field } from '../ui/forms.js';
import { getState } from '../store.js';
import { artImg } from '../ui/art.js';
import { openOverlay, confirmOverlay } from '../ui/overlay.js';
import { pickEntity } from '../ui/entity-picker.js';
import { showToast } from '../ui/toast.js';
import { refreshCounts } from '../app.js';

/**
 * Inbox: fast triage for many imported files. Sources are never
 * changed; folder names never become canon automatically.
 */

/**
 * A name the library already holds. Neither an error nor a status —
 * usually it means "this is newer art for that asset", which is offered
 * as its own route when the item is filed.
 */
function nameMatchNote(match) {
  return el('div', { class: 'row-sub' },
    'Same name as ',
    el('a', {
      href: `#/asset/${match.assetId}`,
      'aria-label': `Open the existing asset ${match.title}`,
      onclick: (e) => e.stopPropagation(),
    }, `“${match.title}”`),
    match.status === 'archived' ? ' — archived' : '',
    match.total > 1 ? ` · ${match.total} assets share this name` : '',
  );
}
export async function renderInbox() {
  const readOnly = getState().library?.readOnly;
  const host = el('div', { class: 'main-inner wide' },
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Library'),
      el('h1', {}, 'Inbox'),
      el('p', { class: 'page-lede' }, 'Imported material waiting to be filed. The source folders were not changed.'),
    ),
  );

  const filter = { batchId: '', status: 'unreviewed', kind: '', text: '', nameMatch: false };
  const selection = new Set();
  const listHost = el('div', {});
  const selectionBar = el('div', { class: 'toolbar', style: { minHeight: '1.8rem' } });

  let items = [];

  const render = async () => {
    clear(listHost);
    items = await call('inbox.list', {
      batchId: filter.batchId || undefined,
      status: filter.status || undefined,
      kind: filter.kind || undefined,
      text: filter.text || undefined,
      nameMatch: filter.nameMatch || undefined,
    });
    selection.clear();
    renderSelectionBar();

    if (items.length === 0) {
      listHost.append(el('p', { class: 'empty-state' },
        filter.status === 'unreviewed'
          ? 'Nothing has been filed yet — bring the first folder into the Inbox.'
          : 'Nothing matches the current filters.'));
      return;
    }
    const list = el('ul', { class: 'row-list' });
    for (const item of items) {
      list.append(inboxRow(item));
    }
    listHost.append(list);
  };

  const inboxRow = (item) => {
    const checkbox = el('input', {
      type: 'checkbox',
      dataset: { itemId: item.id },
      'aria-label': `Select ${item.filename}`,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        if (e.target.checked) selection.add(item.id);
        else selection.delete(item.id);
        renderSelectionBar();
      },
    });
    const row = el('li', {
      class: 'row', tabindex: '0',
      onclick: () => { checkbox.checked = !checkbox.checked; checkbox.dispatchEvent(new Event('change')); },
      onkeydown: (e) => { if (e.key === ' ') { e.preventDefault(); checkbox.click(); } },
    },
      checkbox,
      item.kind === 'image' && item.previewUrl
        ? artImg(item.previewUrl, { alt: item.filename, className: 'row-thumb', noArtClass: 'row-thumb no-art' })
        : el('div', { class: 'row-thumb no-art' }, item.kind.slice(0, 3).toUpperCase()),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title' }, item.filename),
        el('div', { class: 'row-sub' },
          [item.sourceRelPath, formatBytes(item.size), item.batchLabel].filter(Boolean).join(' · ')),
        item.status === 'error' ? el('div', { class: 'row-sub state-bad' }, item.errorMessage) : null,
        item.nameMatch ? nameMatchNote(item.nameMatch) : null,
      ),
      el('div', { class: 'row-side' },
        item.status === 'unreviewed' ? '' : item.status,
      ),
      !readOnly && ['unreviewed', 'duplicate', 'ignored'].includes(item.status) ? el('div', { class: 'row-side' },
        el('button', {
          class: 'btn', 'aria-label': `File ${item.filename}`,
          onclick: (e) => { e.stopPropagation(); fileFlow([item]); },
        }, 'File →'),
      ) : null,
    );
    return row;
  };

  const renderSelectionBar = () => {
    clear(selectionBar);
    if (readOnly) return;
    const allSelected = items.length > 0 && items.every((item) => selection.has(item.id));
    selectionBar.append(el('button', {
      class: 'btn',
      disabled: items.length === 0,
      onclick: () => {
        if (allSelected) selection.clear();
        else for (const item of items) selection.add(item.id);
        for (const checkbox of listHost.querySelectorAll('input[type="checkbox"][data-item-id]')) {
          checkbox.checked = selection.has(checkbox.dataset.itemId);
        }
        renderSelectionBar();
      },
    }, allSelected ? 'Clear selection' : 'Select all'));
    if (selection.size === 0) {
      selectionBar.append(el('span', { class: 'section-note' }, 'Select rows to file several at once.'));
      return;
    }
    const chosen = items.filter((i) => selection.has(i.id));
    selectionBar.append(
      el('span', { class: 'meta-line' }, `${chosen.length} selected`),
      el('button', { class: 'btn btn-primary', onclick: () => fileFlow(chosen) }, 'File the selection →'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          const result = await callSafe('inbox.setStatuses', { ids: chosen.map((item) => item.id), status: 'ignored' });
          if (result) { render(); refreshCounts(); }
        },
      }, 'Ignore'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          const result = await callSafe('inbox.setStatuses', { ids: chosen.map((item) => item.id), status: 'duplicate' });
          if (result) { render(); refreshCounts(); }
        },
      }, 'Mark duplicate'),
    );
  };

  /** Filing flow for one or many items. */
  const fileFlow = async (chosen) => {
    const fileable = chosen.filter((i) => ['unreviewed', 'duplicate', 'ignored'].includes(i.status));
    if (fileable.length === 0) { showToast('Nothing in the selection can be filed.'); return; }
    const suggestions = fileable.length === 1 ? await call('inbox.suggest', { id: fileable[0].id }) : [];
    const roles = await call('asset.roles');
    const hasMedia = fileable.some((i) => i.kind !== 'markdown');
    const hasMarkdown = fileable.some((i) => i.kind === 'markdown');
    let excerpt = '';
    if (fileable.length === 1 && fileable[0].kind === 'markdown') {
      excerpt = (await call('inbox.excerpt', { id: fileable[0].id })).excerpt;
    }

    openOverlay((close) => {
      let target = null; // { id, name } or null
      const targetBtn = el('button', { class: 'btn', type: 'button' }, 'No record — file loose');
      const chooseTarget = (picked) => {
        target = picked;
        targetBtn.textContent = picked ? picked.name : 'No record — file loose';
      };
      targetBtn.addEventListener('click', async () => {
        const picked = await pickEntity({ title: 'Assign to which record?', worldCharacterFilter: true });
        if (picked) chooseTarget(picked);
      });

      const roleSelect = el('select', { 'aria-label': 'Semantic role' },
        el('option', { value: '' }, 'no role yet'),
        ...roles.map((role) => el('option', { value: role }, role)));
      const tagsField = textInput({ placeholder: 'comma, separated, tags', ariaLabel: 'Tags' });

      const suggestionsBlock = suggestions.length > 0
        ? el('div', { class: 'section', style: { margin: '0.8rem 0' } },
          el('span', { class: 'eyebrow' }, 'Suggested matches'),
          ...suggestions.map((s) => el('p', { style: { margin: '0.2rem 0' } },
            el('button', { class: 'btn', type: 'button', onclick: () => chooseTarget({ id: s.entityId, name: s.name }) },
              `${s.name} — ${s.why} →`),
          )),
          el('p', { class: 'section-note' }, 'Suggestions only — nothing is merged without your say.'),
        )
        : null;

      const createNewBlock = el('p', { style: { margin: '0.4rem 0' } },
        el('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            const kindPick = await pickNewEntityKind();
            if (!kindPick) return;
            const name = fileable[0] ? fileable[0].filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') : 'New record';
            const confirmed = await confirmOverlay({
              title: `Create a new ${kindPick} named “${name}”?`,
              body: 'The record starts as a draft; you can rename it at any time.',
              confirmLabel: `Create the ${kindPick}`,
            });
            if (!confirmed) return;
            const created = await callSafe('entity.create', { type: kindPick, name });
            if (created) chooseTarget({ id: created.id, name: created.name });
          },
        }, 'Create a new record from this item →'),
      );

      /**
       * One item carrying a name the library already uses is nearly always
       * newer art for that asset, not a second asset. Filing it as a version
       * keeps the crops, links, and published packages pointing at one thing.
       */
      const match = fileable.length === 1 && fileable[0].kind !== 'markdown' ? fileable[0].nameMatch : null;
      const newVersionBlock = match
        ? el('div', { class: 'section', style: { margin: '0.8rem 0' } },
          el('span', { class: 'eyebrow' }, 'Already in the library'),
          el('p', { class: 'section-note' },
            `An asset is already titled “${match.title}”${match.status === 'archived' ? ' (archived)' : ''}. Filing this as a new version keeps its associations, crops, and history — earlier bytes are never overwritten.`),
          el('p', { style: { marginTop: '0.5rem' } },
            el('button', {
              class: 'btn', type: 'button',
              onclick: async () => {
                const result = await callSafe('inbox.fileAsNewVersion', { id: fileable[0].id, assetId: match.assetId });
                if (result) {
                  showToast(`Filed as version ${result.asset.versions.length} of “${match.title}”.`, 'good');
                  close();
                  render();
                  refreshCounts();
                }
              },
            }, `File as a new version of “${match.title}” →`)),
        )
        : null;

      return el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          const tags = tagsField.value.split(',').map((s) => s.trim()).filter(Boolean);
          let filed = 0;
          for (const item of fileable) {
            try {
              if (item.kind === 'markdown') {
                await call('inbox.fileDocument', { id: item.id, entityIds: target ? [target.id] : [] });
              } else {
                await call('inbox.fileAsset', {
                  id: item.id,
                  entityId: target?.id ?? null,
                  role: target && roleSelect.value ? roleSelect.value : null,
                  tags,
                });
              }
              filed++;
            } catch (err) {
              showToast(`${item.filename}: ${err.message}`, 'error');
            }
          }
          if (filed > 0) showToast(`${filed} item(s) filed.`, 'good');
          close();
          render();
          refreshCounts();
        },
      },
        el('h2', {}, fileable.length === 1 ? `File “${fileable[0].filename}”` : `File ${fileable.length} items`),
        excerpt ? el('div', { class: 'editor-surface', style: { margin: '0.8rem 0', maxHeight: '10rem', overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.85rem' } }, excerpt) : null,
        newVersionBlock,
        suggestionsBlock,
        field('Assign to', targetBtn, { hint: 'Media becomes a managed asset; Markdown becomes a linked document.' }),
        createNewBlock,
        hasMedia ? field('Semantic role', roleSelect, { hint: 'Applied when a record is assigned.' }) : null,
        hasMedia ? field('Tags', tagsField) : null,
        hasMarkdown && hasMedia ? el('p', { class: 'section-note' }, 'Markdown items in the selection become documents; the role and tags apply to media only.') : null,
        el('div', { class: 'overlay-actions' },
          el('button', { class: 'btn btn-primary', type: 'submit' }, 'File →'),
          el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        ),
      );
    }, { label: 'File items', wide: true });
  };

  const pickNewEntityKind = () => {
    const { promise } = openOverlay((close) => el('div', {},
      el('h2', {}, 'What kind of record?'),
      el('div', { class: 'overlay-actions', style: { flexWrap: 'wrap' } },
        ...['world', 'character', 'location', 'group', 'species', 'object', 'event', 'lore'].map((type) =>
          el('button', { class: 'btn', onclick: () => close(type) }, type)),
        el('button', { class: 'btn', onclick: () => close(undefined) }, 'Cancel'),
      ),
    ), { label: 'Choose a kind' });
    return promise;
  };

  /* toolbar */
  const batches = await call('inbox.batches');
  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'field grow' },
      el('span', { class: 'eyebrow' }, 'Search files and paths'),
      textInput({ ariaLabel: 'Search inbox', onInput: (value) => { filter.text = value; render(); } }),
    ),
    el('div', { class: 'field' },
      el('span', { class: 'eyebrow' }, 'Batch'),
      selectInput({
        value: '', ariaLabel: 'Filter by batch',
        options: [{ value: '', label: 'All batches' }, ...batches.map((b) => ({ value: b.id, label: `${b.label} (${b.item_count})` }))],
        onChange: (value) => { filter.batchId = value; render(); },
      }),
    ),
    el('div', { class: 'field' },
      el('span', { class: 'eyebrow' }, 'Status'),
      selectInput({
        value: 'unreviewed', ariaLabel: 'Filter by status',
        options: [
          { value: 'unreviewed', label: 'Unreviewed' },
          { value: 'filed', label: 'Filed' },
          { value: 'duplicate', label: 'Duplicates' },
          { value: 'ignored', label: 'Ignored' },
          { value: 'error', label: 'Errors' },
          { value: '', label: 'Everything' },
        ],
        onChange: (value) => { filter.status = value; render(); },
      }),
    ),
    el('div', { class: 'field' },
      el('span', { class: 'eyebrow' }, 'Type'),
      selectInput({
        value: '', ariaLabel: 'Filter by type',
        options: [
          { value: '', label: 'All types' },
          { value: 'image', label: 'Images' },
          { value: 'audio', label: 'Audio' },
          { value: 'markdown', label: 'Markdown' },
          { value: 'attachment', label: 'Attachments' },
        ],
        onChange: (value) => { filter.kind = value; render(); },
      }),
    ),
    el('label', { style: { display: 'flex', gap: '0.4rem', alignItems: 'center' } },
      el('input', {
        type: 'checkbox',
        'aria-label': 'Only items whose name an asset already uses',
        onchange: (e) => { filter.nameMatch = e.target.checked; render(); },
      }),
      'Name already in the library',
    ),
  );

  const actions = el('div', { class: 'toolbar' },
    !readOnly ? el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const result = await callSafe('inbox.pickImportDirectory');
        if (result) afterImport(result);
      },
    }, 'Bring a folder into the Inbox →') : null,
    !readOnly ? el('button', {
      class: 'btn',
      onclick: async () => {
        const result = await callSafe('inbox.pickImportFiles');
        if (result) afterImport(result);
      },
    }, 'Bring files in →') : null,
    !readOnly ? el('button', {
      class: 'btn',
      onclick: async () => {
        const undone = await callSafe('inbox.undoLast');
        if (undone) { showToast(`The filing of “${undone.filename}” was undone.`, 'good'); render(); refreshCounts(); }
      },
    }, 'Undo the last filing') : null,
    !readOnly ? el('button', {
      class: 'btn',
      onclick: async () => {
        const confirmed = await confirmOverlay({
          title: 'Clear staged copies of filed items?',
          body: 'Only items whose canonical records still resolve are cleared. Anything doubtful is kept.',
          confirmLabel: 'Clear verified staging copies',
        });
        if (!confirmed) return;
        const result = await callSafe('inbox.clearFiled');
        if (result) {
          showToast(`${result.cleared} staging cop${result.cleared === 1 ? 'y' : 'ies'} cleared${result.kept.length ? `; ${result.kept.length} kept for review` : ''}.`, 'good');
          render();
        }
      },
    }, 'Clear filed staging copies') : null,
  );

  const afterImport = (result) => {
    if (!result.batchId) { showToast('Nothing importable was found.'); return; }
    showToast(`${result.imported} new, ${result.duplicates} duplicate, ${result.errors} failed. The source folder was not changed.`, 'good');
    render();
    refreshCounts();
  };

  host.append(actions, toolbar, selectionBar, listHost);
  await render();
  return host;
}
