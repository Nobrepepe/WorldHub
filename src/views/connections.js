import { el, clear } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { field, textArea, textInput, selectInput } from '../ui/forms.js';
import { openDrawer, confirmOverlay } from '../ui/overlay.js';
import { pickEntity } from '../ui/entity-picker.js';
import { showToast } from '../ui/toast.js';
import { getState } from '../store.js';

/**
 * Connections: canonical facts joining two records, each typed by a
 * reusable kind.
 *
 * The kind carries the labels and decides which way the fact runs, so
 * nothing here asks an author for a direction or for a word to call it.
 * This screen is the exception that proves it — an audit view, and the one
 * place source and target are shown at all.
 */

const ENTITY_TYPES = ['world', 'character', 'location', 'group', 'species', 'object', 'event', 'lore'];

/* ---------------- the drawer ---------------- */

/**
 * Connect one record to another, without ever naming a direction.
 *
 * The record you started from is fixed and stays visible beside the drawer.
 * Only categories that record's type can hold are offered, only kinds within
 * them, and the picker only offers records the chosen kind accepts — so an
 * impossible connection is never presented, let alone refused after the fact.
 */
export function openConnectionDrawer({ entity, presetKinds = null, existing = null }) {
  const { promise } = openDrawer((close) => {
    const draft = {
      kind: null,
      counterpartId: existing?.otherId ?? null,
      counterpartName: existing?.otherName ?? null,
      counterpartType: existing?.otherType ?? null,
      description: existing?.description ?? '',
      orientation: 'forward',
    };

    const factLine = el('p', { class: 'fact-line pending' }, 'Choose what kind of fact this is.');
    const categoryHost = el('div', { class: 'kind-choices' });
    const kindHost = el('div', { class: 'kind-choices' });
    const kindField = el('div', { class: 'field', hidden: true },
      el('span', { class: 'eyebrow' }, 'Which'), kindHost);
    const counterpartBtn = el('button', { class: 'btn', type: 'button', disabled: true }, 'Choose a kind first…');
    const swapBtn = el('button', { class: 'btn', type: 'button', hidden: true }, 'The other way round');
    /* Nothing can be saved until the sentence reads, so the action says so
       from the moment the drawer opens rather than from the first choice. */
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'submit', disabled: true },
      'Save the connection →');

    /* The whole point of the drawer: an author confirms a sentence, and the
       storage direction is worked out from the kind behind it. */
    const restate = () => {
      const ready = Boolean(draft.kind && draft.counterpartId);
      factLine.classList.toggle('pending', !ready);
      saveBtn.disabled = !ready;
      if (!draft.kind) { factLine.textContent = 'Choose what kind of fact this is.'; return; }
      if (!draft.counterpartId) {
        factLine.textContent = `Choose which record ${entity.name} is connected to.`;
        return;
      }
      /* The sentence has to be the one that will be stored, so it is
         oriented by exactly the rule the service applies — a preview that
         read the other way round would be worse than no preview, because an
         author would confirm it. */
      const facing = orient(draft.kind, entity.type, draft.counterpartType);
      const useInverse = facing.ambiguous ? draft.orientation === 'inverse' : !facing.forward;
      const [source, target] = useInverse
        ? [draft.counterpartName, entity.name]
        : [entity.name, draft.counterpartName];
      const template = draft.kind.sentence || `{source} — ${draft.kind.forwardLabel} — {target}`;
      factLine.textContent = template.replaceAll('{source}', source).replaceAll('{target}', target);
    };

    let kinds = [];

    const chooseKind = (kind) => {
      draft.kind = kind;
      draft.orientation = 'forward';
      for (const button of kindHost.children) {
        button.setAttribute('aria-pressed', button.dataset.kindId === kind.id ? 'true' : 'false');
      }
      const stillValid = draft.counterpartType && kind.counterpartTypes.includes(draft.counterpartType);
      if (!stillValid) {
        draft.counterpartId = null;
        draft.counterpartName = null;
        draft.counterpartType = null;
      }
      counterpartBtn.disabled = false;
      counterpartBtn.textContent = draft.counterpartName ?? `Choose ${aOrAn(kind.counterpartTypes)}…`;
      swapBtn.hidden = !ambiguous(kind, entity.type, draft.counterpartType);
      restate();
    };

    const showKinds = (category) => {
      clear(kindHost);
      const available = kinds.filter((kind) => kind.category === category);
      for (const kind of available) {
        kindHost.append(el('button', {
          class: 'kind-choice', type: 'button', 'aria-pressed': 'false',
          'data-kind-id': kind.id,
          onclick: () => chooseKind(kind),
        },
          kind.label,
          el('span', { class: 'kind-note' }, kind.counterpartTypes.join(' or ')),
        ));
      }
      kindField.hidden = available.length === 0;
      if (available.length === 1) chooseKind(available[0]);
    };

    counterpartBtn.addEventListener('click', async () => {
      const picked = await pickEntity({
        title: `Connect ${entity.name} to…`,
        types: draft.kind.counterpartTypes,
        excludeIds: [entity.id],
        preferWorldId: entity.worldId ?? (entity.type === 'world' ? entity.id : null),
      });
      if (!picked) return;
      draft.counterpartId = picked.id;
      draft.counterpartName = picked.name;
      draft.counterpartType = picked.type;
      counterpartBtn.textContent = picked.name;
      swapBtn.hidden = !ambiguous(draft.kind, entity.type, picked.type);
      restate();
    });
    swapBtn.addEventListener('click', () => {
      draft.orientation = draft.orientation === 'inverse' ? 'forward' : 'inverse';
      restate();
    });

    /* Categories and kinds arrive already turned to face this record: what a
       character calls an Affiliation, a group calls its Members, and both
       readings come from the one definition. */
    const loadKinds = async (selectKindId = null) => {
      /* Kinds an upgrade carried over are not offered for a fact filed from
         scratch — nobody should choose one deliberately. They are offered
         when the caller has already named them: editing a connection filed
         under one, or adding to a section built out of them. */
      const includeLegacy = Boolean(existing) || Boolean(presetKinds);
      const [available, categories] = await Promise.all([
        call('connection.kindsForType', { entityType: entity.type, includeLegacy }),
        call('connection.categories'),
      ]);
      kinds = presetKinds ? available.filter((kind) => presetKinds.includes(kind.id)) : available;
      const present = categories.filter((category) => kinds.some((kind) => kind.category === category.id));
      clear(categoryHost);
      for (const category of present) {
        categoryHost.append(el('button', {
          class: 'kind-choice', type: 'button', 'aria-pressed': 'false',
          'data-category-id': category.id,
          onclick: (e) => {
            for (const button of categoryHost.children) button.setAttribute('aria-pressed', 'false');
            e.currentTarget.setAttribute('aria-pressed', 'true');
            showKinds(category.id);
          },
        }, category.label));
      }
      const openOn = kinds.find((kind) => kind.id === (selectKindId ?? existing?.kindId));
      if (openOn) {
        for (const button of categoryHost.children) {
          button.setAttribute('aria-pressed', button.dataset.categoryId === openOn.category ? 'true' : 'false');
        }
        showKinds(openOn.category);
        chooseKind(openOn);
      } else if (present.length === 1) {
        categoryHost.firstChild.setAttribute('aria-pressed', 'true');
        showKinds(present[0].id);
      }
    };
    loadKinds();

    return el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!draft.kind || !draft.counterpartId) return;
        try {
          if (existing) {
            await call('connection.update', {
              id: existing.id,
              kindId: draft.kind.id,
              viewerId: entity.id,
              counterpartId: draft.counterpartId,
              orientation: draft.orientation,
              description: draft.description,
            });
          } else {
            await call('connection.create', {
              kindId: draft.kind.id,
              entityId: entity.id,
              counterpartId: draft.counterpartId,
              description: draft.description,
              orientation: draft.orientation,
            });
          }
          close(true);
        } catch (err) {
          showToast(err.message, 'error');
        }
      },
    },
      el('h2', {}, existing ? 'Edit this connection' : `Connect ${entity.name}`),
      el('div', { class: 'field' }, el('span', { class: 'eyebrow' }, 'What kind of fact'), categoryHost),
      kindField,
      field('To', el('div', {}, counterpartBtn, ' ', swapBtn)),
      field('Note', textArea({
        value: draft.description, rows: 2, ariaLabel: 'Note',
        onInput: (value) => { draft.description = value; },
      }), { hint: 'Optional, and short. Anything longer belongs in a linked document.' }),
      el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Reads as'), factLine),
      el('div', { class: 'overlay-actions' },
        saveBtn,
        el('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
      ),
      /* A vocabulary this setting needs and the built-ins do not have is
         defined here and used immediately, rather than by leaving the record
         being connected to go and find a settings screen. */
      presetKinds ? null : el('p', { class: 'section-note', style: { marginTop: '1.4rem' } },
        'Kinds of connection are reusable, and defined once. ',
        el('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            const created = await openKindDrawer();
            if (created) await loadKinds(created.id);
          },
        }, 'Define a new kind →'),
      ),
    );
  }, { label: existing ? 'Edit connection' : `Connect ${entity.name}` });
  return promise;
}

/**
 * Which way the kind says this fact runs — the same question the service
 * asks, asked here so the drawer can show the answer instead of discovering
 * it after the author has committed to a sentence.
 */
function orient(kind, entityType, counterpartType) {
  const forward = kind.pairs.some((pair) => pair.sourceType === entityType && pair.targetType === counterpartType);
  const inverse = kind.pairs.some((pair) => pair.sourceType === counterpartType && pair.targetType === entityType);
  return { forward, inverse, ambiguous: forward && inverse };
}

/** Only a kind that could run either way is worth offering a swap for. */
function ambiguous(kind, entityType, counterpartType) {
  if (!kind || !counterpartType || kind.symmetric) return false;
  return orient(kind, entityType, counterpartType).ambiguous;
}

function aOrAn(types) {
  const word = types.join(' or ');
  return `${'aeiou'.includes(word[0]) ? 'an' : 'a'} ${word}`;
}

/* ---------------- the audit screen ---------------- */

export async function renderConnections() {
  const readOnly = getState().library?.readOnly;
  const [worlds, kinds, categories] = await Promise.all([
    call('entity.list', { type: 'world' }),
    call('connection.kinds', {}),
    call('connection.categories'),
  ]);

  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Canon'),
      el('h1', {}, 'Connections'),
      el('p', { class: 'page-lede' },
        'Every canonical fact joining two records. Records are connected from their own pages; this is where the whole graph can be read, filtered, and tidied.'),
    ),
  );

  const filters = {
    nameQuery: '', worldId: '', category: '', kindId: '',
    sourceType: '', targetType: '', status: '', definitions: '',
  };
  const listHost = el('div', {});
  const countLine = el('p', { class: 'meta-line' }, '');

  const render = async () => {
    clear(listHost);
    const connections = await call('connection.list', {
      nameQuery: filters.nameQuery.trim() || undefined,
      worldId: filters.worldId || undefined,
      category: filters.category || undefined,
      kindId: filters.kindId || undefined,
      sourceType: filters.sourceType || undefined,
      targetType: filters.targetType || undefined,
      status: filters.status || undefined,
      legacyOnly: filters.definitions === 'legacy',
      customOnly: filters.definitions === 'custom',
    });
    countLine.textContent = connections.length === 1
      ? '1 connection' : `${connections.length} connections`;
    if (connections.length === 0) {
      listHost.append(el('p', { class: 'empty-state' },
        Object.values(filters).some(Boolean)
          ? 'Nothing matches the current filters.'
          : 'Nothing is connected yet — open a character, a group or a place and connect it to another record.'));
      return;
    }
    const list = el('ul', { class: 'row-list' });
    for (const connection of connections) list.append(connectionRow(connection, { onChanged: render }));
    listHost.append(list);
  };

  const filterSelect = (label, key, options) => el('div', { class: 'field' },
    el('span', { class: 'eyebrow' }, label),
    selectInput({
      value: '', options, ariaLabel: label,
      onChange: (value) => { filters[key] = value; render(); },
    }),
  );

  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'field grow' },
      el('span', { class: 'eyebrow' }, 'Record name'),
      textInput({ ariaLabel: 'Filter by record name', onInput: (value) => { filters.nameQuery = value; render(); } }),
    ),
    filterSelect('World', 'worldId', [
      { value: '', label: 'Every world' },
      ...worlds.map((world) => ({ value: world.id, label: world.name })),
    ]),
    filterSelect('Category', 'category', [
      { value: '', label: 'Every category' },
      ...categories.map((category) => ({ value: category.id, label: category.label })),
    ]),
    filterSelect('Kind', 'kindId', [
      { value: '', label: 'Every kind' },
      ...kinds.map((kind) => ({ value: kind.id, label: `${kind.forwardLabel}${kind.legacy ? ' (older)' : ''}` })),
    ]),
    filterSelect('From', 'sourceType', [
      { value: '', label: 'Any kind of record' },
      ...ENTITY_TYPES.map((type) => ({ value: type, label: type })),
    ]),
    filterSelect('To', 'targetType', [
      { value: '', label: 'Any kind of record' },
      ...ENTITY_TYPES.map((type) => ({ value: type, label: type })),
    ]),
    filterSelect('Lifecycle', 'status', [
      { value: '', label: 'Draft and canonical' },
      { value: 'draft', label: 'Draft only' },
      { value: 'canonical', label: 'Canonical only' },
      { value: 'archived', label: 'Archived' },
    ]),
    filterSelect('Definitions', 'definitions', [
      { value: '', label: 'All definitions' },
      { value: 'custom', label: 'Kinds you defined' },
      { value: 'legacy', label: 'Kinds carried over' },
    ]),
  );

  host.append(toolbar, countLine, listHost);
  await render();
  if (!readOnly) host.append(await kindMaintenance(render));
  return host;
}

/**
 * One connection, stated as the sentence its kind makes of it. This screen
 * shows which record is the source because that is what an audit is for;
 * nowhere else does.
 */
export function connectionRow(connection, { onChanged } = {}) {
  const readOnly = getState().library?.readOnly;
  const notes = [
    connection.label,
    connection.legacy ? 'carried over from an older library' : null,
    connection.status !== 'canonical' ? connection.status : null,
    connection.description,
  ].filter(Boolean);

  return el('li', { class: 'row', tabindex: '0' },
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, connection.sentence),
      el('div', { class: 'row-sub' }, notes.join(' · ')),
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

/* ---------------- kinds: normalising what an upgrade carried over ---------------- */

/**
 * Upgrading a library minted one kind per distinct free-text type, because
 * guessing which of them meant the same thing would have been a destructive
 * guess. This is where somebody who knows says so — and where a kind this
 * setting needs and the vocabulary does not have gets defined once.
 */
async function kindMaintenance(onChanged) {
  const host = el('div', { class: 'section' },
    el('span', { class: 'eyebrow' }, 'Kinds of connection'));
  const body = el('div', {});

  const render = async () => {
    clear(body);
    const [usage, kinds] = await Promise.all([call('connection.kindUsage'), call('connection.kinds', {})]);
    const carried = usage.filter((kind) => kind.legacy);
    const custom = usage.filter((kind) => !kind.legacy && !kind.builtin);

    if (carried.length > 0) {
      body.append(el('p', { class: 'section-note' },
        `${carried.length} kind(s) were carried over from before connections were typed. Each keeps the wording it was filed under. Merging two that mean the same thing moves every record and deletes nothing.`));
      const list = el('ul', { class: 'row-list' });
      for (const kind of carried) list.append(kindRow(kind, kinds, render, onChanged));
      body.append(list);
    }
    if (custom.length > 0) {
      body.append(el('span', { class: 'eyebrow', style: { display: 'block', marginTop: '1rem' } }, 'Yours'));
      const list = el('ul', { class: 'row-list' });
      for (const kind of custom) list.append(kindRow(kind, kinds, render, onChanged));
      body.append(list);
    }
    if (carried.length === 0 && custom.length === 0) {
      body.append(el('p', { class: 'section-note' },
        'Every connection uses a built-in kind. Define one of your own when this setting needs a fact the built-in vocabulary cannot state.'));
    }
    body.append(el('p', { style: { marginTop: '0.8rem' } },
      el('button', {
        class: 'btn',
        onclick: async () => { if (await openKindDrawer()) { await render(); onChanged?.(); } },
      }, 'Define a kind of connection →'),
    ));
  };

  await render();
  host.append(body);
  return host;
}

function kindRow(kind, allKinds, rerender, onChanged) {
  const notes = [
    kind.category,
    `${kind.uses} connection(s)`,
    kind.overrides > 0 ? `${kind.overrides} with their own wording` : null,
  ].filter(Boolean);

  const targets = allKinds.filter((candidate) => candidate.id !== kind.id);
  const mergeSelect = selectInput({
    value: '',
    ariaLabel: `Merge ${kind.label} into another kind`,
    options: [{ value: '', label: 'Merge into…' },
      ...targets.map((candidate) => ({ value: candidate.id, label: candidate.forwardLabel }))],
    onChange: async (toId) => {
      if (!toId) return;
      const into = targets.find((candidate) => candidate.id === toId);
      const confirmed = await confirmOverlay({
        title: `Merge “${kind.label}” into “${into.forwardLabel}”?`,
        body: `${kind.uses} connection(s) move to “${into.forwardLabel}” and take its wording. “${kind.label}” is then removed.`,
        guarantee: 'No connection is deleted, and any record that carried its own wording keeps it.',
        confirmLabel: 'Merge them',
      });
      mergeSelect.value = '';
      if (!confirmed) return;
      const result = await callSafe('connection.kindMerge', { fromId: kind.id, toId });
      if (result) {
        showToast(`${result.merged} connection(s) moved to “${into.forwardLabel}”.`, 'good');
        await rerender();
        onChanged?.();
      }
    },
  });

  return el('li', { class: 'row kind-row' },
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, kind.label),
      el('div', { class: 'row-sub' }, notes.join(' · ')),
    ),
    el('div', { class: 'row-side' },
      mergeSelect,
      kind.uses === 0 ? el('button', {
        class: 'btn btn-danger',
        'aria-label': `Remove the kind ${kind.label}`,
        onclick: async () => {
          const removed = await callSafe('connection.kindDelete', { id: kind.id });
          if (removed) { showToast(`“${kind.label}” was removed.`, 'good'); await rerender(); }
        },
      }, 'Remove') : null,
    ),
  );
}

/** Define a kind once — labels, the records it joins, and which way it reads. */
function openKindDrawer() {
  const { promise } = openDrawer((close) => {
    const draft = {
      category: 'affiliation', forwardLabel: '', inverseLabel: '',
      forwardSection: '', inverseSection: '', sentence: '', symmetric: false,
      sourceType: 'character', targetType: 'group',
    };
    const preview = el('p', { class: 'fact-line pending' }, 'Name the kind of fact this states.');
    const restate = () => {
      const ready = Boolean(draft.forwardLabel.trim());
      preview.classList.toggle('pending', !ready);
      if (!ready) { preview.textContent = 'Name the kind of fact this states.'; return; }
      const template = draft.sentence || `{source} — ${draft.forwardLabel} — {target}`;
      preview.textContent = template
        .replaceAll('{source}', `A ${draft.sourceType}`)
        .replaceAll('{target}', `a ${draft.targetType}`);
    };
    const change = (key) => (value) => { draft[key] = value; restate(); };

    const categorySelect = selectInput({
      value: draft.category, ariaLabel: 'Category',
      options: [], onChange: change('category'),
    });
    call('connection.categories').then((categories) => {
      categorySelect.replaceChildren(...categories
        .filter((category) => category.id !== 'legacy')
        .map((category) => el('option', { value: category.id }, category.label)));
      categorySelect.value = draft.category;
    });

    const typeOptions = ENTITY_TYPES.map((type) => ({ value: type, label: type }));

    return el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const created = await callSafe('connection.kindCreate', {
          category: draft.category,
          forwardLabel: draft.forwardLabel,
          inverseLabel: draft.inverseLabel || draft.forwardLabel,
          forwardSection: draft.forwardSection,
          inverseSection: draft.inverseSection,
          sentence: draft.sentence,
          symmetric: draft.symmetric,
          pairs: [{ sourceType: draft.sourceType, targetType: draft.targetType }],
        });
        if (created) { showToast(`“${created.forwardLabel}” can now be reused.`, 'good'); close(created); }
      },
    },
      el('h2', {}, 'Define a kind of connection'),
      el('p', { class: 'section-note' },
        'Defined once and reused. Every connection filed under it takes these words, so none of them are ever typed again.'),
      field('Category', categorySelect),
      field('Joins', el('div', { class: 'form-grid' },
        selectInput({ value: draft.sourceType, options: typeOptions, ariaLabel: 'From this kind of record', onChange: change('sourceType') }),
        selectInput({ value: draft.targetType, options: typeOptions, ariaLabel: 'To this kind of record', onChange: change('targetType') }),
      ), { hint: 'Only these two kinds of record can be joined by it.' }),
      field('Read from the first', textInput({
        value: '', placeholder: 'Sworn to', ariaLabel: 'Label on the first record',
        onInput: change('forwardLabel'),
      })),
      field('Read from the second', textInput({
        value: '', placeholder: 'Sworn sword', ariaLabel: 'Label on the second record',
        onInput: change('inverseLabel'),
      }), { hint: 'Leave blank when the fact reads the same from both sides.' }),
      field('Heading on the second', textInput({
        value: '', placeholder: 'Sworn swords', ariaLabel: 'Heading on the second record',
        onInput: change('inverseSection'),
      }), { hint: 'Optional. The category name is used when this is blank.' }),
      field('Stated as', textInput({
        value: '', placeholder: '{source} is sworn to {target}.', ariaLabel: 'Sentence',
        onInput: change('sentence'),
      }), { hint: 'Optional. Write {source} and {target} where the names belong.' }),
      el('label', { style: { display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.6rem 0' } },
        el('input', {
          type: 'checkbox',
          onchange: (e) => { draft.symmetric = e.target.checked; restate(); },
        }),
        'It reads the same from both sides',
      ),
      el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Reads as'), preview),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Define this kind →'),
        el('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
      ),
    );
  }, { label: 'Define a kind of connection' });
  return promise;
}
