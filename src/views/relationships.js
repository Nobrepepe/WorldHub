import { el, clear } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { field, textInput, textArea, selectInput } from '../ui/forms.js';
import { openOverlay, confirmOverlay } from '../ui/overlay.js';
import { pickEntity } from '../ui/entity-picker.js';
import { showToast } from '../ui/toast.js';
import { getState } from '../store.js';

/**
 * Relationship browser and editor. Relationships are directed records;
 * the UI can present them from either side but the direction is kept.
 */

export async function renderRelationships() {
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Canon'),
      el('h1', {}, 'Relationships'),
      el('p', { class: 'page-lede' }, 'Directed connections between records, with labels read from either side.'),
    ),
  );

  const filters = { relType: '', entityName: '' };
  const listHost = el('div', {});

  const render = async () => {
    clear(listHost);
    const relationships = await call('relationship.list', {});
    let visible = relationships;
    if (filters.relType) visible = visible.filter((rel) => rel.relType === filters.relType);
    if (filters.entityName) {
      const q = filters.entityName.toLowerCase();
      visible = visible.filter((rel) => rel.sourceName.toLowerCase().includes(q) || rel.targetName.toLowerCase().includes(q));
    }
    if (visible.length === 0) {
      listHost.append(el('p', { class: 'empty-state' },
        relationships.length === 0
          ? 'Nothing is related yet — open a world or character and relate it to another record.'
          : 'No relationships match the current filters.'));
      return;
    }
    const list = el('ul', { class: 'row-list' });
    for (const rel of visible) {
      list.append(relationshipRow(rel, { onChanged: render }));
    }
    listHost.append(list);
  };

  const types = await call('relationship.types');
  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'field grow' },
      el('span', { class: 'eyebrow' }, 'Filter by name'),
      textInput({ ariaLabel: 'Filter by record name', onInput: (value) => { filters.entityName = value; render(); } }),
    ),
    el('div', { class: 'field' },
      el('span', { class: 'eyebrow' }, 'Type'),
      selectInput({
        value: '',
        options: [{ value: '', label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))],
        onChange: (value) => { filters.relType = value; render(); },
        ariaLabel: 'Filter by relationship type',
      }),
    ),
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const created = await openRelationshipEditor({});
        if (created) render();
      },
    }, 'Relate two records →'),
  );

  host.append(toolbar, listHost);
  await render();
  return host;
}

/** One relationship row with edit/delete controls. */
export function relationshipRow(rel, { perspectiveId = null, onChanged } = {}) {
  const readOnly = getState().library?.readOnly;
  const fromPerspective = perspectiveId && rel.targetId === perspectiveId;
  const label = fromPerspective ? (rel.inverseLabel || `${rel.label || rel.relType} (of)`) : (rel.label || rel.relType);
  const otherName = fromPerspective ? rel.sourceName : rel.targetName;
  const selfName = fromPerspective ? rel.targetName : rel.sourceName;

  return el('li', { class: 'row', tabindex: '0' },
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, `${selfName} — ${label} — ${otherName}`),
      el('div', { class: 'row-sub' }, [rel.relType, rel.description].filter(Boolean).join(' · ')),
    ),
    !readOnly ? el('div', { class: 'row-side' },
      el('button', {
        class: 'btn',
        'aria-label': `Edit relationship ${label}`,
        onclick: async (e) => {
          e.stopPropagation();
          const changed = await openRelationshipEditor({ existing: rel });
          if (changed) onChanged?.();
        },
      }, 'Edit'),
      ' ',
      el('button', {
        class: 'btn btn-danger',
        'aria-label': `Remove relationship ${label}`,
        onclick: async (e) => {
          e.stopPropagation();
          const confirmed = await confirmOverlay({
            title: 'Remove this relationship?',
            body: `${rel.sourceName} — ${rel.label || rel.relType} — ${rel.targetName} will be removed. The records themselves are not touched.`,
            confirmLabel: 'Remove the relationship',
            danger: true,
          });
          if (confirmed) {
            await callSafe('relationship.delete', { id: rel.id });
            onChanged?.();
          }
        },
      }, 'Remove'),
    ) : null,
  );
}

/**
 * Relationship editor overlay. With `existing`, edits it; otherwise
 * creates a new one, optionally pre-filled with a source entity.
 */
export function openRelationshipEditor({ existing = null, sourceId = null, sourceName = null }) {
  const { promise } = openOverlay((close) => {
    const draft = existing
      ? { ...existing }
      : { sourceId, sourceName, targetId: null, targetName: null, relType: '', label: '', inverseLabel: '', description: '' };

    const sourceBtn = el('button', { class: 'btn', type: 'button' }, draft.sourceName ?? 'Choose a record…');
    const targetBtn = el('button', { class: 'btn', type: 'button' }, draft.targetName ?? 'Choose a record…');
    sourceBtn.addEventListener('click', async () => {
      const picked = await pickEntity({ title: 'Who is this relationship from?', excludeIds: [draft.targetId].filter(Boolean) });
      if (picked) { draft.sourceId = picked.id; draft.sourceName = picked.name; sourceBtn.textContent = picked.name; }
    });
    targetBtn.addEventListener('click', async () => {
      const picked = await pickEntity({ title: 'Who is this relationship to?', excludeIds: [draft.sourceId].filter(Boolean) });
      if (picked) { draft.targetId = picked.id; draft.targetName = picked.name; targetBtn.textContent = picked.name; }
    });

    const typeInput = textInput({ value: draft.relType, placeholder: 'mentor, sibling, rival, member…', onInput: (value) => { draft.relType = value; }, ariaLabel: 'Relationship type' });
    const labelInput = textInput({ value: draft.label, placeholder: 'mentor of', onInput: (value) => { draft.label = value; }, ariaLabel: 'Forward label' });
    const inverseInput = textInput({ value: draft.inverseLabel, placeholder: 'student of', onInput: (value) => { draft.inverseLabel = value; }, ariaLabel: 'Inverse label' });
    const descInput = textArea({ value: draft.description, rows: 2, onInput: (value) => { draft.description = value; }, ariaLabel: 'Description' });

    return el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!draft.relType.trim()) { showToast('Give the relationship a type.', 'error'); return; }
        try {
          if (existing) {
            await call('relationship.update', {
              id: existing.id,
              relType: draft.relType,
              label: draft.label,
              inverseLabel: draft.inverseLabel,
              description: draft.description,
            });
          } else {
            if (!draft.sourceId || !draft.targetId) { showToast('Choose both records first.', 'error'); return; }
            await call('relationship.create', {
              sourceId: draft.sourceId,
              targetId: draft.targetId,
              relType: draft.relType.trim(),
              label: draft.label,
              inverseLabel: draft.inverseLabel,
              description: draft.description,
            });
          }
          close(true);
        } catch (err) {
          showToast(err.message, 'error');
        }
      },
    },
      el('h2', {}, existing ? 'Edit relationship' : 'Relate two records'),
      existing
        ? el('p', { class: 'dim' }, `${existing.sourceName} → ${existing.targetName}`)
        : el('div', {},
          field('From', sourceBtn),
          field('To', targetBtn),
        ),
      field('Type', typeInput, { hint: 'A short reusable word for this kind of connection.' }),
      field('Label, read forward', labelInput),
      field('Label, read from the other side', inverseInput),
      field('Description', descInput),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save the relationship →' : 'Create the relationship →'),
        el('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
      ),
    );
  }, { label: existing ? 'Edit relationship' : 'Create relationship' });
  return promise;
}
