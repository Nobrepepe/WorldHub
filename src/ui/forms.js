import { el } from './dom.js';

/** Labeled field: eyebrow label above a transparent underlined input. */
export function field(label, input, { hint, error } = {}) {
  return el('div', { class: 'field' },
    el('span', { class: 'eyebrow' }, label),
    input,
    hint ? el('span', { class: 'field-hint' }, hint) : null,
    error ? el('span', { class: 'field-error' }, error) : null,
  );
}

export function textInput({ value = '', placeholder = '', onInput, ariaLabel }) {
  return el('input', {
    type: 'text',
    value,
    placeholder,
    'aria-label': ariaLabel,
    oninput: onInput ? (e) => onInput(e.target.value) : undefined,
  });
}

export function textArea({ value = '', placeholder = '', rows = 3, onInput, ariaLabel }) {
  const area = el('textarea', {
    placeholder,
    rows,
    'aria-label': ariaLabel,
    oninput: onInput ? (e) => onInput(e.target.value) : undefined,
  });
  area.value = value;
  return area;
}

export function selectInput({ value, options, onChange, ariaLabel }) {
  const select = el('select', {
    'aria-label': ariaLabel,
    onchange: onChange ? (e) => onChange(e.target.value) : undefined,
  });
  for (const option of options) {
    select.append(el('option', { value: option.value, selected: option.value === value }, option.label));
  }
  return select;
}

/** Comma-separated tag editor bound to a save callback. */
export function tagsInput({ tags, onSave }) {
  const input = textInput({
    value: tags.map((t) => t.name).join(', '),
    placeholder: 'comma, separated, tags',
    ariaLabel: 'Tags',
  });
  input.addEventListener('change', () => {
    const names = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    onSave(names);
  });
  return input;
}
