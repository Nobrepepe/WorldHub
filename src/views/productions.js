import { el, clear, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { navigate } from '../router.js';
import { field, textInput, selectInput } from '../ui/forms.js';
import { getState } from '../store.js';
import { artImg } from '../ui/art.js';
import { openOverlay, confirmOverlay } from '../ui/overlay.js';
import { pickEntity } from '../ui/entity-picker.js';
import { pickAsset } from '../ui/asset-picker.js';
import { fieldInput } from '../ui/field-inputs.js';
import { showToast } from '../ui/toast.js';
import { refreshCounts } from '../app.js';

export async function renderProductions() {
  const readOnly = getState().library?.readOnly;
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Distribution'),
      el('h1', {}, 'Productions'),
      el('p', { class: 'page-lede' }, 'App-specific content that arranges canonical material by reference. Nothing canonical is ever copied in.'),
    ),
  );

  const listHost = el('div', {});
  const render = async () => {
    clear(listHost);
    const productions = await call('production.list', { includeArchived: true });
    if (productions.length === 0) {
      listHost.append(el('p', { class: 'empty-state' }, 'No productions yet — a production turns canon into content for one of your applications.'));
      return;
    }
    const list = el('ul', { class: 'row-list' });
    for (const production of productions) {
      list.append(el('li', {
        class: 'row', tabindex: '0',
        onclick: () => navigate(`/production/${production.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/production/${production.id}`); },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, production.name),
          el('div', { class: 'row-sub' },
            [production.worldName, `${production.publications} publication(s)`, validationSentence(production.validationState)]
              .filter(Boolean).join(' · ')),
        ),
        el('div', { class: 'row-side' },
          production.status === 'ready' ? el('span', { class: 'state-ready' }, 'ready') : production.status),
      ));
    }
    listHost.append(list);
  };

  const createFlow = async () => {
    const contracts = await call('contract.list', {});
    if (contracts.length === 0) { showToast('Create an application contract first.', 'error'); return; }
    openOverlay((close) => {
      const nameInput = el('input', { type: 'text', placeholder: 'Name the production', 'aria-label': 'Production name' });
      const contractSelect = el('select', { 'aria-label': 'Contract' },
        ...contracts.map((contract) => el('option', { value: contract.contractId }, `${contract.name} (v${contract.version})`)));
      return el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          const name = nameInput.value.trim();
          if (!name) return;
          try {
            const production = await call('production.create', { name, contractId: contractSelect.value });
            close();
            refreshCounts();
            navigate(`/production/${production.id}`);
          } catch (err) { showToast(err.message, 'error'); }
        },
      },
        el('h2', {}, 'Create a production'),
        el('div', { class: 'field', style: { marginTop: '1rem' } }, el('span', { class: 'eyebrow' }, 'Name'), nameInput),
        el('div', { class: 'field' }, el('span', { class: 'eyebrow' }, 'Application contract'), contractSelect),
        el('div', { class: 'overlay-actions' },
          el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create the production →'),
          el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        ),
      );
    }, { label: 'Create a production' });
  };

  host.append(
    el('div', { class: 'toolbar' },
      !readOnly ? el('button', { class: 'btn btn-primary', onclick: createFlow }, 'Create a production →') : null,
    ),
    listHost,
  );
  await render();
  return host;
}

function validationSentence(state) {
  return {
    unknown: 'not yet validated',
    valid: 'valid',
    warnings: 'valid with warnings',
    errors: 'has errors',
  }[state] ?? state;
}

/* ---------------- production editor ---------------- */

export async function renderProductionDetail({ id }) {
  let production = await call('production.get', { id });
  const readOnly = getState().library?.readOnly || production.status === 'archived';
  const host = el('div', { class: 'main-inner wide' });
  const contract = production.contract;

  const reload = () => navigate(`/production/${id}`);

  host.append(el('header', { class: 'page-head' },
    el('span', { class: 'eyebrow' }, `Production · ${production.contractName} v${production.contractVersion}`),
    el('h1', {}, production.name),
    el('p', { class: 'meta-line' },
      [production.status === 'ready' ? 'Ready to publish' : production.status === 'archived' ? 'Archived' : 'Draft',
        `revision ${production.revision}`,
        validationSentence(production.validationState)].join(' · ')),
  ));

  /* validation panel */
  const validationHost = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Validation'));
  const issuesEl = el('div', {});
  validationHost.append(issuesEl);
  const runValidation = async () => {
    const result = await callSafe('production.validate', { id });
    if (!result) return;
    clear(issuesEl);
    if (result.issues.length === 0) {
      issuesEl.append(el('p', { class: 'state-good' }, 'Everything the contract asks for is present and valid.'));
    } else {
      issuesEl.append(el('p', { class: 'dim' },
        `${result.errors} error(s), ${result.warnings} warning(s). Errors block readiness; warnings do not.`));
      for (const issue of result.issues) {
        issuesEl.append(el('div', { class: `issue ${issue.severity}` },
          el('span', { class: 'issue-sev' }, issue.severity), ' ',
          el('span', { class: 'issue-text' }, issue.message), ' ',
          el('button', {
            class: 'btn', style: { padding: '0 0.3rem' },
            onclick: () => {
              const anchor = document.getElementById(`dest-${issue.destination}`);
              anchor?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            },
          }, 'Go there →'),
        ));
      }
    }
  };
  validationHost.append(el('p', { style: { marginTop: '0.6rem' } },
    el('button', { class: 'btn', onclick: runValidation }, 'Validate now →'),
  ));

  /* production fields */
  const fieldsSection = el('div', { class: 'section', id: 'dest-fields', style: { maxWidth: '46rem' } },
    el('span', { class: 'eyebrow' }, 'Production fields'),
    el('p', { class: 'section-note' }, 'These belong only to this production.'),
  );
  if ((contract.productionFields ?? []).length === 0) {
    fieldsSection.append(el('p', { class: 'section-note' }, 'This contract declares no production fields.'));
  }
  for (const def of contract.productionFields ?? []) {
    fieldsSection.append(fieldInput(def, production.values[def.id], async (value) => {
      await callSafe('production.setValue', { id, scope: 'production', field: def.id, value });
    }, { readOnly }));
  }

  /* entity selections */
  const selectionSections = (contract.entitySelections ?? []).map((selection) =>
    selectionSection(production, selection, { readOnly, reload }));

  /* production-level asset sets */
  const productionSets = (contract.assetSets ?? []).map((set) =>
    assetSetEditor(production, set, null, { readOnly, id: `dest-assets:${set.id}` }));

  /* publications */
  const publicationsSection = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Publications'));
  if (production.publications.length === 0) {
    publicationsSection.append(el('p', { class: 'section-note' }, 'Never published.'));
  } else {
    const list = el('ul', { class: 'row-list' });
    for (const publication of production.publications) {
      list.append(el('li', {
        class: 'row', tabindex: '0',
        onclick: () => navigate(`/publication/${publication.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/publication/${publication.id}`); },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, formatDate(publication.created_at), publication.is_current ? ' — active' : ''),
          el('div', { class: 'row-sub' }, `revision ${publication.production_revision} · ${publication.entity_count} record(s) · ${publication.file_count} file(s)`),
        ),
      ));
    }
    publicationsSection.append(list);
  }

  /* actions */
  const actions = el('div', { class: 'section' },
    el('span', { class: 'eyebrow' }, 'Actions'),
    el('div', { class: 'overlay-actions' },
      !readOnly && production.status !== 'ready' ? el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            await call('production.setStatus', { id, status: 'ready' });
            showToast('Marked ready. It can now be published.', 'good');
            reload();
          } catch (err) {
            showToast(err.message, 'error');
            runValidation();
          }
        },
      }, 'Mark ready →') : null,
      production.status === 'ready' ? el('button', {
        class: 'btn btn-primary pulse',
        onclick: () => navigate(`/production/${id}/publish`),
      }, 'Publish this snapshot →') : null,
      !readOnly && production.status === 'ready' ? el('button', {
        class: 'btn',
        onclick: async () => { await callSafe('production.setStatus', { id, status: 'draft' }); reload(); },
      }, 'Back to draft') : null,
      !getState().library?.readOnly && production.status !== 'archived' ? el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          const confirmed = await confirmOverlay({
            title: `Archive “${production.name}”?`,
            body: 'Its publications remain readable. The production can be restored later.',
            confirmLabel: 'Archive this production', danger: true,
          });
          if (confirmed) { await callSafe('production.setStatus', { id, status: 'archived' }); navigate('/productions'); }
        },
      }, 'Archive') : null,
      production.status === 'archived' && !getState().library?.readOnly ? el('button', {
        class: 'btn btn-primary',
        onclick: async () => { await callSafe('production.setStatus', { id, status: 'draft' }); reload(); },
      }, 'Restore to draft →') : null,
    ),
  );

  /* name edit */
  const nameField = !readOnly ? el('div', { class: 'section', style: { maxWidth: '30rem' } },
    field('Rename', textInput({
      value: production.name, ariaLabel: 'Production name',
      onInput: () => { /* commit on change */ },
    })),
  ) : null;
  if (nameField) {
    nameField.querySelector('input').addEventListener('change', async (e) => {
      const name = e.target.value.trim();
      if (name && name !== production.name) { await callSafe('production.update', { id, name }); reload(); }
    });
  }

  host.append(validationHost, fieldsSection, ...selectionSections, ...productionSets, publicationsSection, actions, nameField ?? '');
  runValidation();
  return host;
}

/** One contract entity selection: ordered picks with fields and asset sets. */
function selectionSection(production, selection, { readOnly, reload }) {
  const id = production.id;
  const section = el('div', { class: 'section', id: `dest-selection:${selection.id}` },
    el('span', { class: 'eyebrow' }, selection.label),
    selection.hint ? el('p', { class: 'section-note' }, selection.hint) : null,
  );
  const chosen = production.selections[selection.id] ?? [];
  const listEl = el('div', {});
  section.append(listEl);

  const commitOrder = async (ids) => {
    await callSafe('production.setSelection', { id, slot: selection.id, entityIds: ids });
    reload();
  };

  if (chosen.length === 0) {
    listEl.append(el('p', { class: 'section-note' }, 'Nothing selected yet.'));
  }
  chosen.forEach((entity, index) => {
    const row = el('div', {
      class: 'row',
      draggable: !readOnly && selection.ordered !== false,
      ondragstart: (e) => e.dataTransfer.setData('text/plain', String(index)),
      ondragover: (e) => e.preventDefault(),
      ondrop: (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isInteger(from) || from === index) return;
        const ids = chosen.map((c) => c.id);
        const [moved] = ids.splice(from, 1);
        ids.splice(index, 0, moved);
        commitOrder(ids);
      },
    },
      artImg(entity.artUrl, { alt: entity.name, className: 'row-thumb', noArtClass: 'row-thumb no-art' }),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title' }, entity.name,
          el('span', { class: 'quiet' }, `  ${entity.type} · canonical, by reference`)),
        entity.status === 'archived' ? el('div', { class: 'row-sub state-bad' }, 'archived') : null,
      ),
      !readOnly ? el('div', { class: 'row-side' },
        el('button', { class: 'btn', 'aria-label': `Move ${entity.name} up`, disabled: index === 0, onclick: () => { const ids = chosen.map((c) => c.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; commitOrder(ids); } }, '↑'),
        el('button', { class: 'btn', 'aria-label': `Move ${entity.name} down`, disabled: index === chosen.length - 1, onclick: () => { const ids = chosen.map((c) => c.id); [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]]; commitOrder(ids); } }, '↓'),
        el('button', { class: 'btn btn-danger', 'aria-label': `Remove ${entity.name}`, onclick: () => commitOrder(chosen.filter((c) => c.id !== entity.id).map((c) => c.id)) }, '×'),
      ) : null,
    );

    const detail = el('div', { style: { padding: '0.2rem 0 0.8rem 3.9rem' } });
    for (const def of selection.fields ?? []) {
      detail.append(fieldInput(def, production.entityValues[entity.id]?.[def.id], async (value) => {
        await callSafe('production.setValue', { id, scope: 'entity', entityId: entity.id, field: def.id, value });
      }, { readOnly }));
    }
    for (const set of selection.assetSets ?? []) {
      detail.append(assetSetEditor(production, set, entity, { readOnly, compact: true }));
    }
    listEl.append(row, detail);
  });

  if (!readOnly) {
    section.append(el('p', { style: { marginTop: '0.6rem' } },
      el('button', {
        class: 'btn',
        onclick: async () => {
          const picked = await pickEntity({
            title: `Add to ${selection.label}`,
            types: selection.entityTypes,
            excludeIds: chosen.map((c) => c.id),
          });
          if (picked) commitOrder([...chosen.map((c) => c.id), picked.id]);
        },
      }, `Add to ${selection.label.toLowerCase()} →`),
    ));
  }
  return section;
}

/** Ordered asset set editor (production-level or per selected entity). */
function assetSetEditor(production, set, entity, { readOnly, compact = false, id: domId } = {}) {
  const id = production.id;
  const key = entity ? `${set.id}:${entity.id}` : set.id;
  const items = production.assetSets[key] ?? [];
  const label = entity ? `${set.label}` : set.label;

  const section = el('div', { class: compact ? '' : 'section', id: domId },
    el('span', { class: 'eyebrow' }, label),
    set.hint ? el('p', { class: 'section-note' }, set.hint) : null,
  );
  const listEl = el('div', {});
  section.append(listEl);

  const commit = async (nextItems) => {
    await callSafe('production.setAssetSet', {
      id, slot: set.id, entityId: entity?.id ?? '',
      items: nextItems.map((item) => ({ assetId: item.assetId, values: item.values ?? {} })),
    });
    navigate(`/production/${id}`);
  };

  if (items.length === 0) {
    listEl.append(el('p', { class: 'section-note' }, 'No assets chosen yet.'));
  }
  items.forEach((item, index) => {
    const row = el('div', { class: 'row' },
      artImg(item.thumbUrl, { alt: item.title, className: 'row-thumb', noArtClass: 'row-thumb no-art' }),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title' }, item.title),
        el('div', { class: 'row-sub' }, item.kind),
      ),
      !readOnly ? el('div', { class: 'row-side' },
        el('button', { class: 'btn', 'aria-label': `Move ${item.title} up`, disabled: index === 0, onclick: () => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; commit(next); } }, '↑'),
        el('button', { class: 'btn', 'aria-label': `Move ${item.title} down`, disabled: index === items.length - 1, onclick: () => { const next = [...items]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; commit(next); } }, '↓'),
        el('button', { class: 'btn btn-danger', 'aria-label': `Remove ${item.title}`, onclick: () => commit(items.filter((_, i) => i !== index)) }, '×'),
      ) : null,
    );
    listEl.append(row);
    for (const def of set.itemFields ?? []) {
      listEl.append(el('div', { style: { padding: '0 0 0.6rem 3.9rem' } },
        fieldInput(def, item.values?.[def.id], async (value) => {
          const next = items.map((existing, i) => i === index
            ? { ...existing, values: { ...(existing.values ?? {}), [def.id]: value } }
            : existing);
          await commit(next);
        }, { readOnly }),
      ));
    }
  });

  if (!readOnly) {
    section.append(el('p', { style: { marginTop: '0.4rem' } },
      el('button', {
        class: 'btn',
        onclick: async () => {
          const picked = await pickAsset({
            title: `Add to ${label}`,
            kinds: set.kinds ?? null,
            roles: set.roles ?? null,
            entityId: entity?.id ?? null,
          });
          if (picked) commit([...items, { assetId: picked.id, values: {} }]);
        },
      }, `Choose an asset →`),
    ));
  }
  return section;
}
