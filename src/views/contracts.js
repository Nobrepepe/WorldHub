import { el, clear, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { navigate } from '../router.js';
import { field, textInput, textArea, selectInput } from '../ui/forms.js';
import { getState } from '../store.js';
import { openOverlay, confirmOverlay } from '../ui/overlay.js';
import { showToast } from '../ui/toast.js';
import { tabbedSections } from './detail-common.js';

const FIELD_TYPES = ['shortText', 'multilineText', 'markdown', 'integer', 'number', 'boolean', 'enum', 'color', 'entityRef', 'assetRef', 'list'];
const ENTITY_TYPES = ['world', 'character', 'location', 'group', 'species', 'object', 'event', 'lore'];

const EMPTY_CONTRACT = {
  format: 'world-hub-application-contract',
  contractVersion: 1,
  appType: 'my-app.content',
  name: 'New contract',
  description: '',
  supportedProtocolVersions: [1],
  productionFields: [],
  entitySelections: [],
  assetSets: [],
  documents: { mode: 'linked' },
  requiredRecipes: [],
};

export async function renderContracts() {
  const readOnly = getState().library?.readOnly;
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Distribution'),
      el('h1', {}, 'Application contracts'),
      el('p', { class: 'page-lede' }, 'Declarative descriptions of what a consuming application needs. Contracts are data — World Hub never runs their code, because they have none.'),
    ),
  );

  const listHost = el('div', {});
  const render = async () => {
    clear(listHost);
    const contracts = await call('contract.list', { includeArchived: true });
    if (contracts.length === 0) {
      listHost.append(el('p', { class: 'empty-state' }, 'No contracts yet.'));
      return;
    }
    const list = el('ul', { class: 'row-list' });
    for (const contract of contracts) {
      list.append(el('li', {
        class: 'row', tabindex: '0',
        onclick: () => navigate(`/contract/${contract.contractId}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/contract/${contract.contractId}`); },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, contract.name),
          el('div', { class: 'row-sub' },
            [contract.appType, `version ${contract.version}`, `${contract.productions} production(s)`, contract.status === 'archived' ? 'archived' : null]
              .filter(Boolean).join(' · ')),
        ),
        el('div', { class: 'row-side' }, formatDate(contract.createdAt)),
      ));
    }
    listHost.append(list);
  };

  host.append(
    el('div', { class: 'toolbar' },
      !readOnly ? el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const created = await callSafe('contract.create', { contract: { ...EMPTY_CONTRACT } });
          if (created) navigate(`/contract/${created.contractId}`);
        },
      }, 'Create a contract →') : null,
    ),
    listHost,
  );
  await render();
  return host;
}

export async function renderContractDetail({ id }) {
  let view = await call('contract.get', { contractId: id });
  const readOnly = getState().library?.readOnly || view.status === 'archived';
  const host = el('div', { class: 'main-inner wide' });

  host.append(el('header', { class: 'page-head' },
    el('span', { class: 'eyebrow' }, `Contract · ${view.appType}`),
    el('h1', {}, view.name),
    el('p', { class: 'meta-line' },
      `Version ${view.version} of ${view.versions.length} · ${view.status}${view.status === 'archived' ? ' — read-only' : ''}`),
  ));

  /** Working copy edited by the guided editor; saved as a new version. */
  let draft = structuredClone(view.contract);

  const saveDraft = async () => {
    const validation = await call('contract.validate', { contract: draft });
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      showToast(`Not saved — ${errors[0].message}`, 'error');
      return false;
    }
    const updated = await callSafe('contract.update', { contractId: id, contract: draft });
    if (updated) {
      showToast(`Saved as version ${updated.version}. Earlier versions and their publications are unchanged.`, 'good');
      navigate(`/contract/${id}`);
      return true;
    }
    return false;
  };

  const guidedTab = () => {
    const container = el('div', { style: { maxWidth: '48rem' } });
    container.append(
      field('Name', textInput({ value: draft.name, onInput: (value) => { draft.name = value; }, ariaLabel: 'Contract name' })),
      field('Application type', textInput({ value: draft.appType, onInput: (value) => { draft.appType = value; }, ariaLabel: 'Application type' }),
        { hint: 'A stable lowercase identifier such as sticker-album.collection.' }),
      field('Description', textArea({ value: draft.description ?? '', rows: 2, onInput: (value) => { draft.description = value; }, ariaLabel: 'Description' })),
      field('Documents', selectInput({
        value: draft.documents?.mode ?? 'linked',
        options: [
          { value: 'linked', label: 'Include documents linked to selected records' },
          { value: 'none', label: 'Do not include documents' },
          { value: 'selected', label: 'Only documents chosen in the production' },
        ],
        onChange: (value) => { draft.documents = { mode: value }; },
        ariaLabel: 'Document mode',
      })),
      fieldListEditor('Production fields', draft.productionFields ??= [], readOnly),
      selectionListEditor(draft, readOnly),
      el('hr', { class: 'rule' }),
      !readOnly ? el('button', { class: 'btn btn-primary', onclick: saveDraft }, 'Save as a new version →') : null,
    );
    return container;
  };

  const rawTab = () => {
    const container = el('div', {});
    const area = el('textarea', { class: 'json-editor', 'aria-label': 'Contract JSON', readOnly, spellcheck: 'false' });
    area.value = JSON.stringify(draft, null, 2);
    const issuesHost = el('div', { style: { marginTop: '0.8rem' } });

    const parse = () => {
      try {
        return { parsed: JSON.parse(area.value) };
      } catch (err) {
        return { error: `The JSON does not parse: ${err.message}` };
      }
    };
    const showIssues = (issues) => {
      clear(issuesHost);
      if (issues.length === 0) {
        issuesHost.append(el('p', { class: 'state-good' }, 'The contract is valid.'));
        return;
      }
      for (const issue of issues) {
        issuesHost.append(el('div', { class: `issue ${issue.severity}` },
          el('span', { class: 'issue-sev' }, issue.severity),
          ' ',
          el('span', { class: 'issue-text' }, issue.message),
        ));
      }
    };

    container.append(
      area,
      el('div', { class: 'toolbar', style: { marginTop: '0.8rem' } },
        el('button', {
          class: 'btn',
          onclick: async () => {
            const { parsed, error } = parse();
            if (error) { showIssues([{ severity: 'error', message: error }]); return; }
            const result = await call('contract.validate', { contract: parsed });
            showIssues(result.issues);
          },
        }, 'Validate'),
        el('button', {
          class: 'btn',
          onclick: () => {
            const { parsed, error } = parse();
            if (error) { showIssues([{ severity: 'error', message: error }]); return; }
            area.value = JSON.stringify(parsed, null, 2);
          },
        }, 'Format'),
        !readOnly ? el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const { parsed, error } = parse();
            if (error) { showIssues([{ severity: 'error', message: error }]); return; }
            draft = parsed;
            await saveDraft();
          },
        }, 'Save as a new version →') : null,
      ),
      issuesHost,
    );
    return container;
  };

  const versionsTab = () => {
    const container = el('div', {});
    const list = el('ul', { class: 'row-list' });
    for (const version of view.versions) {
      list.append(el('li', {
        class: 'row', tabindex: '0',
        onclick: async () => {
          const old = await call('contract.get', { contractId: id, version: version.version });
          openOverlay((close) => el('div', {},
            el('h2', {}, `${old.name} — version ${old.version}`),
            el('pre', { class: 'editor-surface', style: { maxHeight: '55vh', overflow: 'auto', fontSize: '0.8rem' } },
              JSON.stringify(old.contract, null, 2)),
            el('div', { class: 'overlay-actions' },
              el('button', { class: 'btn', onclick: () => close() }, 'Close'),
            ),
          ), { label: 'Contract version', wide: true });
        },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, `Version ${version.version}${version.version === view.version ? ' — latest' : ''}`),
          el('div', { class: 'row-sub' }, formatDate(version.created_at)),
        ),
      ));
    }
    container.append(
      el('p', { class: 'section-note', style: { marginBottom: '0.8rem' } },
        'Published snapshots keep the contract version they used, even after later edits.'),
      list,
    );
    return container;
  };

  host.append(tabbedSections([
    { label: 'Guided editor', render: guidedTab },
    { label: 'Raw JSON', render: rawTab },
    { label: 'Versions', render: versionsTab },
  ]));

  /* care actions */
  if (!getState().library?.readOnly) {
    host.append(el('div', { class: 'section' },
      el('span', { class: 'eyebrow' }, 'Care'),
      el('div', { class: 'overlay-actions' },
        el('button', {
          class: 'btn',
          onclick: async () => {
            const copy = await callSafe('contract.duplicate', { contractId: id });
            if (copy) navigate(`/contract/${copy.contractId}`);
          },
        }, 'Duplicate this contract →'),
        view.status === 'active' ? el('button', {
          class: 'btn btn-danger',
          onclick: async () => {
            const confirmed = await confirmOverlay({
              title: `Archive “${view.name}”?`,
              body: 'Existing productions and publications keep working; new productions cannot use an archived contract.',
              confirmLabel: 'Archive this contract', danger: true,
            });
            if (confirmed) { await callSafe('contract.setStatus', { contractId: id, status: 'archived' }); navigate('/contracts'); }
          },
        }, 'Archive') : el('button', {
          class: 'btn btn-primary',
          onclick: async () => { await callSafe('contract.setStatus', { contractId: id, status: 'active' }); navigate(`/contract/${id}`); },
        }, 'Restore →'),
      ),
    ));
  }
  return host;
}

/* ---------------- guided sub-editors ---------------- */

function fieldListEditor(title, fields, readOnly) {
  const section = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, title));
  const listEl = el('div', {});
  section.append(listEl);

  const render = () => {
    listEl.replaceChildren();
    if (fields.length === 0) listEl.append(el('p', { class: 'section-note' }, 'None declared.'));
    fields.forEach((fieldDef, index) => {
      listEl.append(el('div', { class: 'row' },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, `${fieldDef.label} `, el('span', { class: 'quiet' }, `(${fieldDef.id} · ${fieldDef.type}${fieldDef.required ? ' · required' : ''})`)),
        ),
        !readOnly ? el('div', { class: 'row-side' },
          el('button', { class: 'btn', 'aria-label': `Edit field ${fieldDef.label}`, onclick: async () => { const edited = await editFieldDef(fieldDef); if (edited) { fields[index] = edited; render(); } } }, 'Edit'),
          el('button', { class: 'btn', 'aria-label': `Move field ${fieldDef.label} up`, disabled: index === 0, onclick: () => { [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]]; render(); } }, '↑'),
          el('button', { class: 'btn', 'aria-label': `Move field ${fieldDef.label} down`, disabled: index === fields.length - 1, onclick: () => { [fields[index + 1], fields[index]] = [fields[index], fields[index + 1]]; render(); } }, '↓'),
          el('button', { class: 'btn btn-danger', 'aria-label': `Remove field ${fieldDef.label}`, onclick: () => { fields.splice(index, 1); render(); } }, '×'),
        ) : null,
      ));
    });
    if (!readOnly) {
      listEl.append(el('p', { style: { marginTop: '0.5rem' } },
        el('button', {
          class: 'btn',
          onclick: async () => {
            const created = await editFieldDef({ id: `field_${fields.length + 1}`, label: 'New field', type: 'shortText' });
            if (created) { fields.push(created); render(); }
          },
        }, 'Declare a field →'),
      ));
    }
  };
  render();
  return section;
}

function editFieldDef(fieldDef) {
  const { promise } = openOverlay((close) => {
    const draft = structuredClone(fieldDef);
    const extra = el('div', {});
    const renderExtra = () => {
      clear(extra);
      if (draft.type === 'enum') {
        extra.append(field('Options (value=label, one per line)', (() => {
          const area = el('textarea', { rows: 4, 'aria-label': 'Enum options', onchange: (e) => {
            draft.options = e.target.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
              const [value, label] = line.split('=');
              return { value: value.trim(), label: (label ?? value).trim() };
            });
          } });
          area.value = (draft.options ?? []).map((option) => `${option.value}=${option.label}`).join('\n');
          return area;
        })()));
      } else if (draft.type === 'entityRef') {
        extra.append(field('Allowed record types (comma separated)', textInput({
          value: (draft.entityTypes ?? []).join(', '),
          onInput: (value) => { draft.entityTypes = value.split(',').map((s) => s.trim()).filter((s) => ENTITY_TYPES.includes(s)); },
          ariaLabel: 'Entity types',
        }), { hint: ENTITY_TYPES.join(', ') }));
      } else if (draft.type === 'integer' || draft.type === 'number') {
        extra.append(
          field('Minimum', textInput({ value: draft.min ?? '', onInput: (value) => { draft.min = value === '' ? undefined : Number(value); }, ariaLabel: 'Minimum' })),
          field('Maximum', textInput({ value: draft.max ?? '', onInput: (value) => { draft.max = value === '' ? undefined : Number(value); }, ariaLabel: 'Maximum' })),
        );
      } else if (draft.type === 'shortText' || draft.type === 'multilineText' || draft.type === 'markdown') {
        extra.append(field('Maximum length', textInput({ value: draft.maxLength ?? '', onInput: (value) => { draft.maxLength = value === '' ? undefined : Math.trunc(Number(value)); }, ariaLabel: 'Maximum length' })));
      }
    };
    renderExtra();
    return el('form', {
      onsubmit: (e) => { e.preventDefault(); close(draft); },
    },
      el('h2', {}, 'Field'),
      field('Identifier', textInput({ value: draft.id, onInput: (value) => { draft.id = value; }, ariaLabel: 'Field id' }),
        { hint: 'Lowercase letters, numbers, dashes, underscores.' }),
      field('Label', textInput({ value: draft.label, onInput: (value) => { draft.label = value; }, ariaLabel: 'Field label' })),
      field('Type', selectInput({
        value: draft.type,
        options: FIELD_TYPES.map((type) => ({ value: type, label: type })),
        onChange: (value) => { draft.type = value; renderExtra(); },
        ariaLabel: 'Field type',
      })),
      el('label', { style: { display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.8rem' } },
        el('input', { type: 'checkbox', checked: !!draft.required, onchange: (e) => { draft.required = e.target.checked; } }),
        'Required',
      ),
      field('Hint', textInput({ value: draft.hint ?? '', onInput: (value) => { draft.hint = value || undefined; }, ariaLabel: 'Hint' })),
      extra,
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Keep this field →'),
        el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
      ),
    );
  }, { label: 'Edit field' });
  return promise;
}

function selectionListEditor(draft, readOnly) {
  const selections = draft.entitySelections ??= [];
  const section = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Entity selections'));
  const listEl = el('div', {});
  section.append(listEl);

  const render = () => {
    listEl.replaceChildren();
    if (selections.length === 0) listEl.append(el('p', { class: 'section-note' }, 'None declared.'));
    selections.forEach((selection, index) => {
      const counts = selection.exact !== undefined ? `exactly ${selection.exact}` : `${selection.min ?? 0}–${selection.max ?? '∞'}`;
      listEl.append(el('div', { class: 'row' },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, selection.label, ' ', el('span', { class: 'quiet' }, `(${selection.id})`)),
          el('div', { class: 'row-sub' },
            `${selection.entityTypes.join('/')} · ${counts} · ${selection.fields?.length ?? 0} field(s) · ${selection.assetSets?.length ?? 0} asset set(s)`),
        ),
        !readOnly ? el('div', { class: 'row-side' },
          el('button', { class: 'btn', 'aria-label': `Edit selection ${selection.label}`, onclick: async () => { const edited = await editSelection(selection); if (edited) { selections[index] = edited; render(); } } }, 'Edit'),
          el('button', { class: 'btn btn-danger', 'aria-label': `Remove selection ${selection.label}`, onclick: () => { selections.splice(index, 1); render(); } }, '×'),
        ) : null,
      ));
    });
    if (!readOnly) {
      listEl.append(el('p', { style: { marginTop: '0.5rem' } },
        el('button', {
          class: 'btn',
          onclick: async () => {
            const created = await editSelection({ id: `selection_${selections.length + 1}`, label: 'New selection', entityTypes: ['character'], min: 1 });
            if (created) { selections.push(created); render(); }
          },
        }, 'Declare a selection →'),
      ));
    }
  };
  render();
  return section;
}

function editSelection(selection) {
  const { promise } = openOverlay((close) => {
    const draft = structuredClone(selection);
    draft.fields ??= [];
    draft.assetSets ??= [];
    const assetSetsHost = el('div', {});
    const renderAssetSets = () => {
      clear(assetSetsHost);
      draft.assetSets.forEach((set, index) => {
        assetSetsHost.append(el('div', { class: 'row' },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' }, set.label, ' ', el('span', { class: 'quiet' }, `(${set.id})`)),
            el('div', { class: 'row-sub' }, `roles ${set.roles?.join(', ') || 'any'} · recipes ${set.recipes?.join(', ') || 'none'} · ${set.exact !== undefined ? `exactly ${set.exact}` : `${set.min ?? 0}–${set.max ?? '∞'}`}`),
          ),
          el('div', { class: 'row-side' },
            el('button', { class: 'btn', 'aria-label': `Edit asset set ${set.label}`, onclick: async () => { const edited = await editAssetSet(set); if (edited) { draft.assetSets[index] = edited; renderAssetSets(); } } }, 'Edit'),
            el('button', { class: 'btn btn-danger', 'aria-label': `Remove asset set ${set.label}`, onclick: () => { draft.assetSets.splice(index, 1); renderAssetSets(); } }, '×'),
          ),
        ));
      });
      assetSetsHost.append(el('p', {},
        el('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            const created = await editAssetSet({ id: `set_${draft.assetSets.length + 1}`, label: 'New asset set', kinds: ['image'], exact: 1 });
            if (created) { draft.assetSets.push(created); renderAssetSets(); }
          },
        }, 'Declare an asset set →'),
      ));
    };
    renderAssetSets();
    return el('form', { onsubmit: (e) => { e.preventDefault(); close(draft); } },
      el('h2', {}, 'Entity selection'),
      field('Identifier', textInput({ value: draft.id, onInput: (value) => { draft.id = value; }, ariaLabel: 'Selection id' })),
      field('Label', textInput({ value: draft.label, onInput: (value) => { draft.label = value; }, ariaLabel: 'Selection label' })),
      field('Allowed record types (comma separated)', textInput({
        value: draft.entityTypes.join(', '),
        onInput: (value) => { draft.entityTypes = value.split(',').map((s) => s.trim()).filter((s) => ENTITY_TYPES.includes(s)); },
        ariaLabel: 'Entity types',
      }), { hint: ENTITY_TYPES.join(', ') }),
      field('Exact count (leave empty for a range)', textInput({
        value: draft.exact ?? '',
        onInput: (value) => { draft.exact = value === '' ? undefined : Math.trunc(Number(value)); if (draft.exact !== undefined) { delete draft.min; delete draft.max; } },
        ariaLabel: 'Exact count',
      })),
      field('Minimum', textInput({ value: draft.min ?? '', onInput: (value) => { draft.min = value === '' ? undefined : Math.trunc(Number(value)); if (draft.min !== undefined) delete draft.exact; }, ariaLabel: 'Minimum' })),
      field('Maximum', textInput({ value: draft.max ?? '', onInput: (value) => { draft.max = value === '' ? undefined : Math.trunc(Number(value)); if (draft.max !== undefined) delete draft.exact; }, ariaLabel: 'Maximum' })),
      fieldListEditor('Per-record fields', draft.fields, false),
      el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Asset sets per record'), assetSetsHost),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Keep this selection →'),
        el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
      ),
    );
  }, { label: 'Edit selection', wide: true });
  return promise;
}

function editAssetSet(set) {
  const { promise } = openOverlay((close) => {
    const draft = structuredClone(set);
    return el('form', { onsubmit: (e) => { e.preventDefault(); close(draft); } },
      el('h2', {}, 'Asset set'),
      field('Identifier', textInput({ value: draft.id, onInput: (value) => { draft.id = value; }, ariaLabel: 'Asset set id' })),
      field('Label', textInput({ value: draft.label, onInput: (value) => { draft.label = value; }, ariaLabel: 'Asset set label' })),
      field('Allowed kinds (comma separated)', textInput({
        value: (draft.kinds ?? []).join(', '),
        onInput: (value) => { draft.kinds = value.split(',').map((s) => s.trim()).filter((s) => ['image', 'audio', 'markdown', 'attachment'].includes(s)); if (draft.kinds.length === 0) delete draft.kinds; },
        ariaLabel: 'Asset kinds',
      }), { hint: 'image, audio, markdown, attachment' }),
      field('Allowed roles (comma separated)', textInput({
        value: (draft.roles ?? []).join(', '),
        onInput: (value) => { draft.roles = value.split(',').map((s) => s.trim()).filter(Boolean); if (draft.roles.length === 0) delete draft.roles; },
        ariaLabel: 'Asset roles',
      })),
      field('Required rendition recipes (comma separated)', textInput({
        value: (draft.recipes ?? []).join(', '),
        onInput: (value) => { draft.recipes = value.split(',').map((s) => s.trim()).filter(Boolean); if (draft.recipes.length === 0) delete draft.recipes; },
        ariaLabel: 'Recipes',
      })),
      field('Exact count', textInput({ value: draft.exact ?? '', onInput: (value) => { draft.exact = value === '' ? undefined : Math.trunc(Number(value)); if (draft.exact !== undefined) { delete draft.min; delete draft.max; } }, ariaLabel: 'Exact count' })),
      field('Minimum', textInput({ value: draft.min ?? '', onInput: (value) => { draft.min = value === '' ? undefined : Math.trunc(Number(value)); if (draft.min !== undefined) delete draft.exact; }, ariaLabel: 'Minimum' })),
      field('Maximum', textInput({ value: draft.max ?? '', onInput: (value) => { draft.max = value === '' ? undefined : Math.trunc(Number(value)); if (draft.max !== undefined) delete draft.exact; }, ariaLabel: 'Maximum' })),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Keep this asset set →'),
        el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
      ),
    );
  }, { label: 'Edit asset set' });
  return promise;
}
