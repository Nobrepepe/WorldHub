import { el } from './dom.js';
import { field } from './forms.js';
import { pickEntity } from './entity-picker.js';
import { pickAsset } from './asset-picker.js';

/**
 * Renders an input for one contract field definition. Calls onChange
 * with the new value. Contract data is interpreted, never executed.
 */
export function fieldInput(def, value, onChange, { readOnly = false } = {}) {
  const wrap = (input) => field(def.label + (def.required ? '' : ' (optional)'), input, { hint: def.hint });

  switch (def.type) {
    case 'shortText':
      return wrap(el('input', {
        type: 'text', value: value ?? '', 'aria-label': def.label, readOnly,
        maxLength: def.maxLength, onchange: (e) => onChange(e.target.value || null),
      }));
    case 'multilineText': {
      const area = el('textarea', { rows: 3, 'aria-label': def.label, readOnly, onchange: (e) => onChange(e.target.value || null) });
      area.value = value ?? '';
      return wrap(area);
    }
    case 'markdown': {
      const area = el('textarea', {
        rows: 6, 'aria-label': def.label, readOnly, class: 'editor-surface',
        style: { fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' },
        onchange: (e) => onChange(e.target.value || null),
      });
      area.value = value ?? '';
      return wrap(area);
    }
    case 'integer':
      return wrap(el('input', {
        type: 'number', step: '1', value: value ?? '', min: def.min, max: def.max, 'aria-label': def.label, readOnly,
        onchange: (e) => onChange(e.target.value === '' ? null : Math.trunc(Number(e.target.value))),
      }));
    case 'number':
      return wrap(el('input', {
        type: 'number', step: def.step ?? 'any', value: value ?? '', min: def.min, max: def.max, 'aria-label': def.label, readOnly,
        onchange: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)),
      }));
    case 'boolean': {
      const box = el('input', {
        type: 'checkbox', checked: value === true, 'aria-label': def.label, disabled: readOnly,
        onchange: (e) => onChange(e.target.checked),
      });
      return el('div', { class: 'field' },
        el('label', { style: { display: 'flex', gap: '0.5rem', alignItems: 'center' } }, box, def.label),
        def.hint ? el('span', { class: 'field-hint' }, def.hint) : null,
      );
    }
    case 'enum': {
      const select = el('select', { 'aria-label': def.label, disabled: readOnly, onchange: (e) => onChange(e.target.value || null) },
        el('option', { value: '' }, '—'),
        ...(def.options ?? []).map((option) => el('option', { value: option.value, selected: option.value === value }, option.label)),
      );
      return wrap(select);
    }
    case 'color':
      return wrap(el('input', {
        type: 'color', value: value ?? '#e9a94f', 'aria-label': def.label, disabled: readOnly,
        style: { width: '4rem', padding: '0' },
        onchange: (e) => onChange(e.target.value),
      }));
    case 'entityRef': {
      const button = el('button', { class: 'btn', type: 'button', disabled: readOnly }, value ? 'Change the record…' : 'Choose a record…');
      const nameEl = el('span', { class: 'meta-line' }, value ? `chosen: ${value.slice(0, 8)}…` : 'none chosen');
      hydrateRefLabel(nameEl, 'entity', value);
      button.addEventListener('click', async () => {
        const picked = await pickEntity({ title: `Choose: ${def.label}`, types: def.entityTypes ?? null });
        if (picked) { onChange(picked.id); nameEl.textContent = picked.name; }
      });
      return wrap(el('div', { style: { display: 'flex', gap: '1rem', alignItems: 'baseline' } }, button, nameEl));
    }
    case 'assetRef': {
      const button = el('button', { class: 'btn', type: 'button', disabled: readOnly }, value ? 'Change the asset…' : 'Choose an asset…');
      const nameEl = el('span', { class: 'meta-line' }, 'none chosen');
      hydrateRefLabel(nameEl, 'asset', value);
      button.addEventListener('click', async () => {
        const picked = await pickAsset({ title: `Choose: ${def.label}`, kinds: def.assetKinds ?? null, roles: def.assetRoles ?? null });
        if (picked) { onChange(picked.id); nameEl.textContent = picked.title; }
      });
      return wrap(el('div', { style: { display: 'flex', gap: '1rem', alignItems: 'baseline' } }, button, nameEl));
    }
    case 'list':
      return listInput(def, Array.isArray(value) ? value : [], onChange, { readOnly });
    default:
      return wrap(el('p', { class: 'state-bad' }, `Unknown field type "${def.type}".`));
  }
}

async function hydrateRefLabel(nameEl, kind, id) {
  if (!id) return;
  try {
    const { call } = await import('../ipc.js');
    if (kind === 'entity') {
      const entity = await call('entity.get', { id });
      nameEl.textContent = entity.name;
    } else {
      const asset = await call('asset.get', { id });
      nameEl.textContent = asset.title;
    }
  } catch {
    nameEl.textContent = 'missing record';
    nameEl.className = 'state-bad';
  }
}

/** Ordered list field with accessible move actions and drag handles. */
function listInput(def, values, onChange, { readOnly }) {
  const items = [...values];
  const host = el('div', { class: 'field' },
    el('span', { class: 'eyebrow' }, def.label + (def.required ? '' : ' (optional)')),
  );
  const listEl = el('div', {});
  host.append(listEl);
  if (def.hint) host.append(el('span', { class: 'field-hint' }, def.hint));

  const commit = () => onChange(items.length > 0 ? [...items] : null);

  const render = () => {
    listEl.replaceChildren();
    items.forEach((item, index) => {
      const row = el('div', {
        class: 'row', draggable: !readOnly,
        ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(index)); },
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => {
          e.preventDefault();
          const from = Number(e.dataTransfer.getData('text/plain'));
          if (Number.isInteger(from) && from !== index) {
            const [moved] = items.splice(from, 1);
            items.splice(index, 0, moved);
            commit(); render();
          }
        },
      });
      const body = el('div', { class: 'row-main' });
      if (def.fields) {
        for (const sub of def.fields) {
          body.append(fieldInput(sub, item?.[sub.id], (subValue) => {
            items[index] = { ...(items[index] ?? {}), [sub.id]: subValue };
            commit();
          }, { readOnly }));
        }
      } else if (def.item) {
        body.append(fieldInput({ ...def.item, label: `${def.item.label} ${index + 1}` }, item, (subValue) => {
          items[index] = subValue;
          commit();
        }, { readOnly }));
      }
      row.append(body);
      if (!readOnly) {
        row.append(el('div', { class: 'row-side' },
          el('button', { class: 'btn', type: 'button', 'aria-label': `Move item ${index + 1} up`, disabled: index === 0, onclick: () => { [items[index - 1], items[index]] = [items[index], items[index - 1]]; commit(); render(); } }, '↑'),
          el('button', { class: 'btn', type: 'button', 'aria-label': `Move item ${index + 1} down`, disabled: index === items.length - 1, onclick: () => { [items[index + 1], items[index]] = [items[index], items[index + 1]]; commit(); render(); } }, '↓'),
          el('button', { class: 'btn btn-danger', type: 'button', 'aria-label': `Remove item ${index + 1}`, onclick: () => { items.splice(index, 1); commit(); render(); } }, '×'),
        ));
      }
      listEl.append(row);
    });
    if (!readOnly && (def.maxItems === undefined || items.length < def.maxItems)) {
      listEl.append(el('p', { style: { marginTop: '0.4rem' } },
        el('button', {
          class: 'btn', type: 'button',
          onclick: () => { items.push(def.fields ? {} : null); render(); },
        }, `Add to ${def.label.toLowerCase()} →`),
      ));
    }
  };
  render();
  return host;
}
