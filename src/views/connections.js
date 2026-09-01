import { el, clear } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { field, textArea, selectInput, textInput } from '../ui/forms.js';
import { openOverlay, confirmOverlay } from '../ui/overlay.js';
import { pickEntity } from '../ui/entity-picker.js';
import { showToast } from '../ui/toast.js';
import { getState } from '../store.js';

/**
 * Connections: canonical facts between records, typed by a reusable kind.
 *
 * The kind carries the labels and decides which way the fact runs, so
 * nothing here asks an author for a direction or for a word to call it.
 */

export async function renderConnections() {
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Canon'),
      el('h1', {}, 'Connections'),
      el('p', { class: 'page-lede' }, 'Every canonical fact joining two records, read from either side.'),
    ),
  );

  const filters = { kindId: '', entityName: '' };
  const listHost = el('div', {});

  const render = async () => {
    clear(listHost);
    const connections = await call('connection.list', {
      kindId: filters.kindId || undefined,
      nameQuery: filters.entityName.trim() || undefined,
    });
    if (connections.length === 0) {
      listHost.append(el('p', { class: 'empty-state' },
        filters.kindId || filters.entityName
          ? 'Nothing matches the current filters.'
          : 'Nothing is connected yet — open a record and connect it to another.'));
      return;
    }
    const list = el('ul', { class: 'row-list' });
    for (const connection of connections) {
      list.append(connectionRow(connection, { onChanged: render }));
    }
    listHost.append(list);
  };

  const kinds = await call('connection.kinds', {});
  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'field grow' },
      el('span', { class: 'eyebrow' }, 'Filter by name'),
      textInput({ ariaLabel: 'Filter by record name', onInput: (value) => { filters.entityName = value; render(); } }),
    ),
    el('div', { class: 'field' },
      el('span', { class: 'eyebrow' }, 'Kind'),
      selectInput({
        value: '',
        options: [{ value: '', label: 'All kinds' }, ...kinds.map((kind) => ({
          value: kind.id,
          label: `${kind.forwardLabel}${kind.legacy ? ' (older)' : ''}`,
        }))],
        onChange: (value) => { filters.kindId = value; render(); },
        ariaLabel: 'Filter by kind of connection',
      }),
    ),
  );

  host.append(toolbar, listHost);
  await render();
  return host;
}

/** One connection, stated as the sentence its kind makes of it. */
export function connectionRow(connection, { onChanged } = {}) {
  const readOnly = getState().library?.readOnly;
  return el('li', { class: 'row', tabindex: '0' },
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, connection.sentence),
      el('div', { class: 'row-sub' },
        [connection.label, connection.description].filter(Boolean).join(' · ')),
    ),
    !readOnly ? el('div', { class: 'row-side' },
      el('button', {
        class: 'btn btn-danger',
        'aria-label': `Remove the connection between ${connection.sourceName} and ${connection.targetName}`,
        onclick: async (e) => {
          e.stopPropagation();
          const confirmed = await confirmOverlay({
            title: 'Remove this connection?',
            body: connection.sentence,
            guarantee: 'Only the connection goes. Both records are left exactly as they are.',
            confirmLabel: 'Remove the connection',
            danger: true,
          });
          if (confirmed) {
            await callSafe('connection.delete', { id: connection.id });
            onChanged?.();
          }
        },
      }, 'Remove'),
    ) : null,
  );
}

/**
 * Connect one record to another.
 *
 * The record you started from is fixed, the kinds offered are only those its
 * type can hold, and the picker only offers records the chosen kind accepts —
 * so an impossible connection is never presented, let alone saved.
 */
export function openConnectionEditor({ entity, presetKinds = null }) {
  const { promise } = openOverlay((close) => {
    const draft = { kind: null, counterpartId: null, counterpartName: null, description: '', orientation: 'forward' };

    const sentence = el('p', { class: 'dim', style: { minHeight: '1.4rem' } }, 'Choose a kind of connection.');
    const counterpartBtn = el('button', { class: 'btn', type: 'button', disabled: true }, 'Choose a kind first…');
    const swapBtn = el('button', { class: 'btn', type: 'button', hidden: true }, 'The other way round');

    const restate = () => {
      if (!draft.kind) { sentence.textContent = 'Choose a kind of connection.'; return; }
      if (!draft.counterpartId) { sentence.textContent = `Choose which record ${entity.name} connects to.`; return; }
      const [a, b] = draft.orientation === 'inverse'
        ? [draft.counterpartName, entity.name]
        : [entity.name, draft.counterpartName];
      const template = draft.kind.sentence || `{source} — ${draft.kind.forwardLabel} — {target}`;
      sentence.textContent = template.replaceAll('{source}', a).replaceAll('{target}', b);
    };

    const kindSelect = selectInput({
      value: '',
      ariaLabel: 'Kind of connection',
      options: [{ value: '', label: 'Choose…' }],
      onChange: (value) => {
        draft.kind = kinds.find((kind) => kind.id === value) ?? null;
        draft.counterpartId = null;
        draft.counterpartName = null;
        draft.orientation = 'forward';
        counterpartBtn.textContent = draft.kind
          ? `Choose a ${draft.kind.counterpartTypes.join(' or ')}…`
          : 'Choose a kind first…';
        counterpartBtn.disabled = !draft.kind;
        swapBtn.hidden = true;
        restate();
      },
    });

    let kinds = [];
    call('connection.kindsForType', { entityType: entity.type, includeLegacy: true }).then((available) => {
      kinds = presetKinds ? available.filter((kind) => presetKinds.includes(kind.id)) : available;
      const byCategory = new Map();
      for (const kind of kinds) {
        if (!byCategory.has(kind.category)) byCategory.set(kind.category, []);
        byCategory.get(kind.category).push(kind);
      }
      kindSelect.replaceChildren(el('option', { value: '' }, 'Choose…'));
      for (const [category, group] of byCategory) {
        const optgroup = el('optgroup', { label: category });
        for (const kind of group) optgroup.append(el('option', { value: kind.id }, kind.label));
        kindSelect.append(optgroup);
      }
    });

    counterpartBtn.addEventListener('click', async () => {
      const picked = await pickEntity({
        title: `Connect ${entity.name} to…`,
        types: draft.kind.counterpartTypes,
        excludeIds: [entity.id],
      });
      if (!picked) return;
      draft.counterpartId = picked.id;
      draft.counterpartName = picked.name;
      counterpartBtn.textContent = picked.name;
      // Both orders are legal only when the kind joins two records of the
      // same type; that is the one case worth offering a swap for.
      swapBtn.hidden = !draft.kind.pairs.some((pair) =>
        pair.sourceType === picked.type && pair.targetType === entity.type)
        || !draft.kind.pairs.some((pair) => pair.sourceType === entity.type && pair.targetType === picked.type)
        || draft.kind.symmetric;
      restate();
    });
    swapBtn.addEventListener('click', () => {
      draft.orientation = draft.orientation === 'inverse' ? 'forward' : 'inverse';
      restate();
    });

    return el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!draft.kind) { showToast('Choose a kind of connection.', 'error'); return; }
        if (!draft.counterpartId) { showToast('Choose the record to connect to.', 'error'); return; }
        try {
          await call('connection.create', {
            kindId: draft.kind.id,
            entityId: entity.id,
            counterpartId: draft.counterpartId,
            description: draft.description,
            orientation: draft.orientation,
          });
          close(true);
        } catch (err) {
          showToast(err.message, 'error');
        }
      },
    },
      el('h2', {}, `Connect ${entity.name}`),
      field('Kind of connection', kindSelect),
      field('To', el('div', {}, counterpartBtn, ' ', swapBtn)),
      field('Note', textArea({
        value: '', rows: 2, ariaLabel: 'Note',
        onInput: (value) => { draft.description = value; },
      }), { hint: 'Optional. A concise line — anything longer belongs in a document.' }),
      el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Reads as'), sentence),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save the connection →'),
        el('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
      ),
    );
  }, { label: 'Connect two records' });
  return promise;
}
