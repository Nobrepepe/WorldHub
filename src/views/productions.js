import { el, clear, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { navigate } from '../router.js';
import { field, textInput, selectInput } from '../ui/forms.js';
import { getState } from '../store.js';
import { artImg } from '../ui/art.js';
import { openOverlay, confirmOverlay } from '../ui/overlay.js';
import { pickEntity } from '../ui/entity-picker.js';
import { pickAssets } from '../ui/asset-picker.js';
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

  /* Archived productions stay readable but stop crowding the shelf; the
     toggle only appears once there is something behind it. */
  let showArchived = false;
  const archivedToggle = el('button', {
    class: 'btn', type: 'button', hidden: true,
    onclick: () => { showArchived = !showArchived; render(); },
  }, '');

  const render = async () => {
    clear(listHost);
    const all = await call('production.list', { includeArchived: true });
    const archivedCount = all.filter((production) => production.status === 'archived').length;
    archivedToggle.hidden = archivedCount === 0;
    archivedToggle.textContent = showArchived
      ? `Hide the ${archivedCount} archived`
      : `Show ${archivedCount} archived`;
    if (all.length === 0) {
      listHost.append(el('p', { class: 'empty-state' }, 'No productions yet — a production turns canon into content for one of your applications.'));
      return;
    }
    const productions = showArchived ? all : all.filter((production) => production.status !== 'archived');
    if (productions.length === 0) {
      listHost.append(el('p', { class: 'empty-state' }, 'Every production here is archived. Show them to restore one, or clear the archive for good from Settings.'));
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
      archivedToggle,
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

/**
 * Fold state for the editor, remembered for as long as the app is open.
 * Sections redraw themselves after every commit, and a fold the author
 * made must not spring back open under them.
 */
const collapsedAssetSets = new Set();
const collapsedRecords = new Set();
const collapsedSections = new Set();

/**
 * Scroll to whatever a validation issue points at, opening any fold
 * that hides it on the way. Destinations are colon-joined and read
 * left to right, so an unknown tail still lands on the right section.
 */
function revealDestination(destination) {
  const parts = String(destination ?? '').split(':');
  let anchor = null;
  while (parts.length > 0 && !anchor) {
    anchor = document.getElementById(`dest-${parts.join(':')}`);
    if (!anchor) parts.pop();
  }
  if (!anchor) return;
  const folds = [];
  for (let node = anchor; node; node = node.parentElement) {
    if (typeof node.reveal === 'function') folds.push(node);
  }
  for (const node of folds.reverse()) node.reveal();
  anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  anchor.classList.add('flash-target');
  setTimeout(() => anchor.classList.remove('flash-target'), 1800);
}

/* ---------------- field sections ---------------- */

/**
 * Group a contract's fields into the named, collapsible sections it asks for.
 *
 * A contract that describes a whole game can declare a hundred fields, and
 * rendering them as one flat column makes the screen unusable for the person
 * who came to write a character's name. Consecutive fields sharing a `section`
 * are shown together under its heading; a section whose fields are marked
 * `advanced` opens collapsed, so tuning is present without being in the way.
 *
 * Fields declaring no section are rendered plainly, exactly as before, so a
 * contract that says nothing about sections looks unchanged.
 */
function groupFieldsBySection(defs) {
  const groups = [];
  for (const def of defs ?? []) {
    const name = typeof def.section === 'string' && def.section.trim() ? def.section.trim() : null;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.defs.push(def);
    else groups.push({ name, defs: [def] });
  }
  return groups;
}

/**
 * A collapsible heading. `foldKey` keeps the author's choice for as long as
 * the app is open, so a section does not spring back open under them after a
 * commit redraws the screen.
 */
function sectionFold(label, foldKey, { startCollapsed = false, count = null } = {}) {
  const body = el('div', { class: 'fold-body' });
  const mark = el('span', { class: 'fold-mark', 'aria-hidden': 'true' }, '▾');
  const header = el('button', {
    class: 'btn fold-head', type: 'button', 'aria-expanded': 'true',
  }, mark, el('span', { class: 'eyebrow' }, label),
    count === null ? null : el('span', { class: 'dim' }, ` ${count}`));
  const fold = (collapsed) => {
    if (collapsed) collapsedSections.add(foldKey);
    else collapsedSections.delete(foldKey);
    body.hidden = collapsed;
    mark.textContent = collapsed ? '▸' : '▾';
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  };
  header.onclick = () => fold(!collapsedSections.has(foldKey));
  const group = el('div', { class: 'field-section' }, header, body);
  group.reveal = () => fold(false);
  /* A section the author has never touched follows the contract's advice;
     once they have folded or unfolded it, their choice wins. */
  const remembered = collapsedSections.has(foldKey);
  fold(remembered || (startCollapsed && !collapsedSections.has(`${foldKey}:seen`)));
  collapsedSections.add(`${foldKey}:seen`);
  return { group, body, fold };
}

/** Render `defs` into `host`, honouring any sections they declare. */
function appendFields(host, defs, foldPrefix, renderOne) {
  for (const group of groupFieldsBySection(defs)) {
    if (group.name === null) {
      for (const def of group.defs) host.append(renderOne(def));
      continue;
    }
    const advanced = group.defs.every((def) => def.advanced === true);
    const { group: sectionEl, body } = sectionFold(group.name, `${foldPrefix}:${group.name}`, {
      startCollapsed: advanced,
      count: group.defs.length,
    });
    for (const def of group.defs) body.append(renderOne(def));
    host.append(sectionEl);
  }
}

export async function renderProductionDetail({ id }) {
  let production = await call('production.get', { id });
  const readOnly = getState().library?.readOnly || production.status === 'archived';
  const host = el('div', { class: 'main-inner wide' });
  const contract = production.contract;

  const reload = () => navigate(`/production/${id}`);

  /* Sections read the production through live() and hand back whatever a
     command returned through adopt(), so a commit redraws one list
     instead of the whole screen. */
  const live = () => production;
  const statusLine = () => [
    production.status === 'ready' ? 'Ready to publish' : production.status === 'archived' ? 'Archived' : 'Draft',
    `revision ${production.revision}`,
    validationSentence(production.validationState),
  ].join(' · ');
  const metaLine = el('p', { class: 'meta-line' }, statusLine());
  const adopt = (next) => {
    if (next) {
      production = next;
      metaLine.textContent = statusLine();
    }
    return next;
  };

  host.append(el('header', { class: 'page-head' },
    el('span', { class: 'eyebrow' }, `Production · ${production.contractName} v${production.contractVersion}`),
    el('h1', {}, production.name),
    metaLine,
  ));

  /* validation panel */
  const validationHost = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Validation'));
  const issuesEl = el('div', {});
  validationHost.append(issuesEl);
  const runValidation = async () => {
    const result = await callSafe('production.validate', { id });
    if (!result) return;
    production.validationState = result.state;
    metaLine.textContent = statusLine();
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
            onclick: () => revealDestination(issue.destination),
          }, 'Go there →'),
        ));
      }
    }
  };
  validationHost.append(el('p', { style: { marginTop: '0.6rem' } },
    el('button', { class: 'btn', onclick: runValidation }, 'Validate now →'),
  ));

  /* which contract version this production answers to */
  const contractSection = await contractPanel(production, { readOnly: getState().library?.readOnly, reload });

  /* production fields */
  const fieldsSection = el('div', { class: 'section', id: 'dest-fields', style: { maxWidth: '46rem' } },
    el('span', { class: 'eyebrow' }, 'Production fields'),
    el('p', { class: 'section-note' }, 'These belong only to this production.'),
  );
  if ((contract.productionFields ?? []).length === 0) {
    fieldsSection.append(el('p', { class: 'section-note' }, 'This contract declares no production fields.'));
  }
  appendFields(fieldsSection, contract.productionFields, `production:${id}`, (def) => (
    /* "Go there →" needs to land on the field itself, not merely on the block
       that holds it: a collapsed section would otherwise hide what the issue
       is pointing at. Destinations read left to right, so `fields:<id>` still
       falls back to the block when no such field is on screen. */
    el('div', { id: `dest-fields:${def.id}` },
      fieldInput(def, production.values[def.id], async (value) => {
        await callSafe('production.setValue', { id, scope: 'production', field: def.id, value });
      }, { readOnly }))
  ));

  /* documents chosen explicitly, when the contract asks for it */
  let documentsSection = null;
  if (contract.documents?.mode === 'selected') {
    documentsSection = el('div', { class: 'section', id: 'dest-documents' },
      el('span', { class: 'eyebrow' }, 'Documents in this snapshot'),
      el('p', { class: 'section-note' }, 'This contract includes only the documents you choose here.'),
    );
    const chosenDocs = new Set(Array.isArray(production.values.__documents__) ? production.values.__documents__ : []);
    const allDocs = await call('document.list', {});
    if (allDocs.length === 0) {
      documentsSection.append(el('p', { class: 'section-note' }, 'The library has no documents yet.'));
    }
    for (const doc of allDocs) {
      documentsSection.append(el('label', { style: { display: 'flex', gap: '0.5rem', alignItems: 'baseline', padding: '0.2rem 0' } },
        el('input', {
          type: 'checkbox', checked: chosenDocs.has(doc.id), disabled: readOnly,
          onchange: async (e) => {
            if (e.target.checked) chosenDocs.add(doc.id);
            else chosenDocs.delete(doc.id);
            await callSafe('production.setValue', { id, scope: 'production', field: '__documents__', value: [...chosenDocs] });
          },
        }),
        el('span', {}, doc.title),
        el('span', { class: 'quiet' }, doc.links.map((l) => l.name).join(', ')),
      ));
    }
  }

  /* entity selections */
  const selectionSections = (contract.entitySelections ?? []).map((selection) =>
    selectionSection({ live, adopt, selection, readOnly }));

  /* production-level asset sets */
  const productionSets = (contract.assetSets ?? []).map((set) =>
    assetSetEditor({ live, adopt, set, entity: null, readOnly, domId: `dest-assets:${set.id}` }));

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
            body: 'Its publications remain readable. The production can be restored later, or cleared for good from Settings › The archive.',
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
      if (!name || name === production.name) return;
      const updated = await callSafe('production.update', { id, name });
      if (updated) {
        adopt(updated);
        host.querySelector('h1').textContent = updated.name;
        showToast('Renamed.', 'good');
      }
    });
  }

  host.append(validationHost, contractSection, fieldsSection, documentsSection ?? '', ...selectionSections, ...productionSets, publicationsSection, actions, nameField ?? '');
  runValidation();
  return host;
}

/* ---------------- moving to another contract version ---------------- */

/**
 * A contract that gains a field or narrows a role does not oblige the
 * author to build the production again: this panel moves an existing
 * one onto another version, keeping everything the new version still
 * recognises and saying plainly what it lets go.
 */
async function contractPanel(production, { readOnly, reload }) {
  const section = el('div', { class: 'section', style: { maxWidth: '46rem' } },
    el('span', { class: 'eyebrow' }, 'Application contract'),
  );
  const targets = await callSafe('production.rebindTargets', { id: production.id });
  if (!targets) return section;

  const behind = targets.latestOwnVersion > production.contractVersion;
  section.append(el('p', { class: 'meta-line' },
    `${production.contractName} v${production.contractVersion}`,
    behind ? ` · v${targets.latestOwnVersion} is available` : ' · this is the newest version'));

  /* The application's own copy of the contract has moved since it was
     imported. Publishing now would ship content answering a document the
     application has left behind, so this says so here — where the work is
     — and offers the whole remedy in one action. */
  const drift = await callSafe('contract.drift', { contractId: production.contractId });
  if (drift?.unverifiable) {
    section.append(el('p', { class: 'section-note' }, drift.message));
  }
  if (drift?.drifted) {
    section.append(el('div', { class: 'issue error', id: 'dest-contract-drift' },
      el('span', { class: 'issue-sev' }, 'drifted'), ' ',
      el('span', { class: 'issue-text' }, drift.message)));
    if (!readOnly) {
      section.append(el('div', { class: 'overlay-actions' },
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const imported = await callSafe('contract.importFile', { sourcePath: drift.sourcePath });
            if (!imported) return;
            if (imported.version === production.contractVersion) {
              showToast('Contract re-imported. This production is already on that version.');
              reload();
              return;
            }
            /* Moving versions can drop values the new contract no longer
               recognises, so it goes through the same panel as any other
               rebind rather than deciding silently. */
            const fresh = await callSafe('production.rebindTargets', { id: production.id });
            if (!fresh) return;
            rebindFlow(production, fresh, {
              contractId: production.contractId,
              contractVersion: imported.version,
            }, reload);
          },
        }, 'Re-import and rebind →'),
      ));
    }
  }

  if (readOnly) return section;

  const open = (preset) => rebindFlow(production, targets, preset, reload);
  section.append(el('div', { class: 'overlay-actions' },
    behind ? el('button', {
      class: 'btn btn-primary',
      onclick: () => open({ contractId: production.contractId, contractVersion: targets.latestOwnVersion }),
    }, `Move to v${targets.latestOwnVersion} →`) : null,
    el('button', {
      class: 'btn',
      onclick: () => open({ contractId: production.contractId, contractVersion: production.contractVersion }),
    }, 'Choose another version or contract…'),
  ));
  return section;
}

function rebindFlow(production, targets, preset, reload) {
  openOverlay((close) => {
    const contractSelect = el('select', { 'aria-label': 'Contract' },
      ...targets.contracts.map((contract) => el('option', {
        value: contract.contractId,
        selected: contract.contractId === preset.contractId,
      }, `${contract.name}${contract.status === 'archived' ? ' (archived)' : ''}`)));
    const versionSelect = el('select', { 'aria-label': 'Version' });
    const previewHost = el('div', { style: { marginTop: '1rem' } });
    const confirm = el('button', { class: 'btn btn-primary', type: 'button' }, 'Move this production →');

    const fillVersions = (keep) => {
      const contract = targets.contracts.find((c) => c.contractId === contractSelect.value);
      clear(versionSelect);
      for (const version of contract?.versions ?? []) {
        versionSelect.append(el('option', { value: String(version), selected: version === keep }, `v${version}`));
      }
      if (!versionSelect.value && versionSelect.firstChild) versionSelect.selectedIndex = 0;
    };

    const refresh = async () => {
      clear(previewHost);
      previewHost.append(el('p', { class: 'dim' }, 'Working out what carries over…'));
      confirm.disabled = true;
      const plan = await callSafe('production.planRebind', {
        id: production.id,
        contractId: contractSelect.value,
        contractVersion: Number(versionSelect.value),
      });
      clear(previewHost);
      if (!plan) return;
      confirm.disabled = plan.unchanged;
      if (plan.unchanged) {
        previewHost.append(el('p', { class: 'dim' }, 'This production is already on that version.'));
        return;
      }
      previewHost.append(el('p', { class: 'meta-line' },
        `${plan.from.name} v${plan.from.version}  →  ${plan.to.name} v${plan.to.version}`));
      if (plan.differentContract) {
        previewHost.append(el('p', { class: 'state-bad' },
          'That is a different contract, not another version of this one. Expect most selections to be released.'));
      }
      if (plan.losses.length === 0) {
        previewHost.append(el('p', { class: 'state-good' }, 'Nothing is released — every value, record and asset you have chosen is still recognised.'));
      } else {
        previewHost.append(el('span', { class: 'eyebrow' }, 'Released by the move'));
        previewHost.append(el('ul', { class: 'plain-list' },
          ...plan.losses.map((loss) => el('li', { class: 'state-bad' }, loss))));
      }
      if (plan.additions.length > 0) {
        previewHost.append(el('span', { class: 'eyebrow', style: { display: 'block', marginTop: '0.9rem' } }, 'New in that version'));
        previewHost.append(el('ul', { class: 'plain-list' },
          ...plan.additions.map((addition) => el('li', { class: 'dim' }, addition))));
      }
      previewHost.append(el('p', { class: 'quiet', style: { marginTop: '0.9rem' } },
        plan.publications > 0
          ? `The ${plan.publications} snapshot(s) already published keep the contract version they shipped with; they are not touched. The production returns to draft and is validated again.`
          : 'The production returns to draft and is validated again.'));
    };

    contractSelect.addEventListener('change', () => { fillVersions(null); refresh(); });
    versionSelect.addEventListener('change', refresh);
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      const moved = await callSafe('production.rebind', {
        id: production.id,
        contractId: contractSelect.value,
        contractVersion: Number(versionSelect.value),
      });
      if (!moved) { confirm.disabled = false; return; }
      close();
      showToast(`Now on ${moved.contractName} v${moved.contractVersion}.`, 'good');
      reload();
    });

    fillVersions(preset.contractVersion);
    refresh();

    return el('div', {},
      el('h2', {}, 'Move to another contract version'),
      el('p', { class: 'dim' }, 'The production keeps everything the chosen version still recognises. Nothing is minted again.'),
      el('div', { style: { display: 'flex', gap: '1rem', marginTop: '1rem' } },
        el('div', { class: 'field', style: { flex: '1 1 auto' } }, el('span', { class: 'eyebrow' }, 'Contract'), contractSelect),
        el('div', { class: 'field' }, el('span', { class: 'eyebrow' }, 'Version'), versionSelect),
      ),
      previewHost,
      el('div', { class: 'overlay-actions' },
        confirm,
        el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      ),
    );
  }, { label: 'Move to another contract version', wide: true });
}

/* ---------------- selections ---------------- */

/** One contract entity selection: ordered picks with fields and asset sets. */
function selectionSection({ live, adopt, selection, readOnly }) {
  const id = live().id;
  const section = el('div', { class: 'section', id: `dest-selection:${selection.id}` },
    el('span', { class: 'eyebrow' }, selection.label),
    selection.hint ? el('p', { class: 'section-note' }, selection.hint) : null,
  );
  const chosen = () => live().selections[selection.id] ?? [];
  const listEl = el('div', {});
  const hasAssetSets = (selection.assetSets ?? []).length > 0;

  /* With a dozen records, each carrying its own long asset lists, folding
     them all at once is the difference between a page and a scroll. */
  let records = [];
  const foldAllRecords = el('button', { class: 'btn', type: 'button' }, 'Fold every record');
  const foldAllAssets = el('button', { class: 'btn', type: 'button' }, 'Fold every asset list');
  const syncFoldButtons = () => {
    foldAllRecords.disabled = records.length === 0;
    foldAllRecords.textContent = records.length > 0 && records.every((record) => record.folded())
      ? 'Unfold every record' : 'Fold every record';
    const sets = records.flatMap((record) => record.assetSets);
    foldAllAssets.disabled = sets.length === 0;
    foldAllAssets.textContent = sets.length > 0 && sets.every((set) => set.assetSetFolded())
      ? 'Unfold every asset list' : 'Fold every asset list';
  };
  foldAllRecords.addEventListener('click', () => {
    const collapse = records.some((record) => !record.folded());
    for (const record of records) record.fold(collapse);
    syncFoldButtons();
  });
  foldAllAssets.addEventListener('click', () => {
    const sets = records.flatMap((record) => record.assetSets);
    const collapse = sets.some((set) => !set.assetSetFolded());
    for (const set of sets) set.foldAssetSet(collapse);
    syncFoldButtons();
  });

  const count = el('span', { class: 'quiet' }, '');
  section.append(el('p', { class: 'fold-controls' }, foldAllRecords, hasAssetSets ? foldAllAssets : null, count));
  section.append(listEl);

  const commitOrder = async (ids) => {
    const updated = await callSafe('production.setSelection', { id, slot: selection.id, entityIds: ids });
    if (adopt(updated)) renderList();
  };

  const renderList = () => {
    clear(listEl);
    records = [];
    const entities = chosen();
    count.textContent = entities.length === 0 ? '' : `${entities.length} chosen`;
    if (entities.length === 0) {
      listEl.append(el('p', { class: 'section-note' }, 'Nothing selected yet.'));
      syncFoldButtons();
      return;
    }
    entities.forEach((entity, index) => {
      listEl.append(recordBlock({
        live, adopt, selection, entity, index, entities, readOnly, commitOrder,
        register: (record) => records.push(record),
        onFold: syncFoldButtons,
      }));
    });
    syncFoldButtons();
  };
  renderList();

  if (!readOnly) {
    section.append(el('p', { style: { marginTop: '0.6rem' } },
      el('button', {
        class: 'btn',
        onclick: async () => {
          const picked = await pickEntity({
            title: `Add to ${selection.label}`,
            types: selection.entityTypes,
            excludeIds: chosen().map((c) => c.id),
          });
          if (picked) await commitOrder([...chosen().map((c) => c.id), picked.id]);
        },
      }, `Add to ${selection.label.toLowerCase()} →`),
    ));
  }
  return section;
}

/** One selected record: its row, its fields, and its asset sets. */
function recordBlock({ live, adopt, selection, entity, index, entities, readOnly, commitOrder, register, onFold }) {
  const productionId = live().id;
  const foldKey = `${productionId}:${selection.id}:${entity.id}`;
  const group = el('div', { class: 'record', id: `dest-selection:${selection.id}:${entity.id}` });
  const detail = el('div', { class: 'record-detail' });
  const mark = el('span', { class: 'fold-mark' }, '▾');

  const fold = (collapsed) => {
    if (collapsed) collapsedRecords.add(foldKey);
    else collapsedRecords.delete(foldKey);
    detail.hidden = collapsed;
    mark.textContent = collapsed ? '▸' : '▾';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    onFold?.();
  };
  const toggle = el('button', {
    class: 'btn record-fold', type: 'button',
    'aria-label': `Show or hide the details for ${entity.name}`,
    'aria-expanded': 'true',
    onclick: () => fold(!collapsedRecords.has(foldKey)),
  }, mark);

  const row = el('div', {
    class: 'row',
    draggable: !readOnly && selection.ordered !== false,
    ondragstart: (e) => e.dataTransfer.setData('text/plain', String(index)),
    ondragover: (e) => e.preventDefault(),
    ondrop: (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (!Number.isInteger(from) || from === index) return;
      const ids = entities.map((c) => c.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(index, 0, moved);
      commitOrder(ids);
    },
  },
    toggle,
    artImg(entity.artUrl, { alt: entity.name, className: 'row-thumb', noArtClass: 'row-thumb no-art' }),
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, `${index + 1}. ${entity.name}`,
        el('span', { class: 'quiet' }, `  ${entity.type} · canonical, by reference`)),
      entity.status === 'archived' ? el('div', { class: 'row-sub state-bad' }, 'archived') : null,
    ),
    !readOnly ? el('div', { class: 'row-side' },
      el('button', { class: 'btn', 'aria-label': `Move ${entity.name} up`, disabled: index === 0, onclick: () => { const ids = entities.map((c) => c.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; commitOrder(ids); } }, '↑'),
      el('button', { class: 'btn', 'aria-label': `Move ${entity.name} down`, disabled: index === entities.length - 1, onclick: () => { const ids = entities.map((c) => c.id); [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]]; commitOrder(ids); } }, '↓'),
      el('button', { class: 'btn btn-danger', 'aria-label': `Remove ${entity.name}`, onclick: () => commitOrder(entities.filter((c) => c.id !== entity.id).map((c) => c.id)) }, '×'),
    ) : null,
  );

  appendFields(detail, selection.fields, `record:${entity.id}`, (def) => (
    fieldInput(def, live().entityValues[entity.id]?.[def.id], async (value) => {
      await callSafe('production.setValue', { id: productionId, scope: 'entity', entityId: entity.id, field: def.id, value });
    }, { readOnly })
  ));
  const assetSets = (selection.assetSets ?? []).map((set) => {
    const editor = assetSetEditor({
      live, adopt, set, entity, readOnly, compact: true, onFold,
      domId: `dest-assetset:${set.id}:${entity.id}`,
    });
    detail.append(editor);
    return editor;
  });

  group.append(row, detail);
  group.reveal = () => fold(false);
  register({ fold, folded: () => collapsedRecords.has(foldKey), assetSets });
  fold(collapsedRecords.has(foldKey));
  return group;
}

/* ---------------- asset sets ---------------- */

/** Ordered asset set editor (production-level or per selected record). */
function assetSetEditor({ live, adopt, set, entity, readOnly, compact = false, domId = null, onFold = null }) {
  const productionId = live().id;
  const key = entity ? `${set.id}:${entity.id}` : set.id;
  const items = () => live().assetSets[key] ?? [];
  const cap = set.exact ?? set.max ?? null;

  const foldKey = `${productionId}:${key}`;
  const section = el('div', { class: compact ? 'asset-set' : 'section', id: domId });
  const body = el('div', {}, set.hint ? el('p', { class: 'section-note' }, set.hint) : null);
  const mark = el('span', { class: 'fold-mark' }, '▾');
  const countEl = el('span', { class: 'quiet' }, '');
  const header = el('button', {
    class: 'btn fold-head', type: 'button', 'aria-expanded': 'true',
    onclick: () => fold(!collapsedAssetSets.has(foldKey)),
  }, mark, el('span', { class: 'eyebrow' }, set.label), countEl);
  const fold = (collapsed) => {
    if (collapsed) collapsedAssetSets.add(foldKey);
    else collapsedAssetSets.delete(foldKey);
    body.hidden = collapsed;
    mark.textContent = collapsed ? '▸' : '▾';
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    onFold?.();
  };
  section.append(header, body);
  // Read by the fold-everything controls and by validation navigation.
  section.foldAssetSet = fold;
  section.assetSetFolded = () => collapsedAssetSets.has(foldKey);
  section.reveal = () => fold(false);

  const listEl = el('div', {});
  const addHost = el('p', { style: { marginTop: '0.4rem' } });
  body.append(listEl, addHost);

  /**
   * Adding, reordering and removing redraw this one list. Typing into a
   * per-asset field does not redraw at all: the value the author just
   * typed is already on screen, and rebuilding it would take the caret
   * away mid-sentence.
   */
  const commit = async (nextItems, { redraw = true } = {}) => {
    const updated = await callSafe('production.setAssetSet', {
      id: productionId, slot: set.id, entityId: entity?.id ?? '',
      items: nextItems.map((item) => ({ assetId: item.assetId, values: item.values ?? {} })),
    });
    if (!adopt(updated)) return false;
    if (redraw) renderItems();
    else renderCount();
    return true;
  };

  const renderCount = () => {
    const current = items();
    countEl.textContent = current.length === 0 ? 'none chosen'
      : cap ? `${current.length} of ${cap} chosen` : `${current.length} chosen`;
  };

  const renderItems = () => {
    clear(listEl);
    clear(addHost);
    renderCount();
    const current = items();
    if (current.length === 0) {
      listEl.append(el('p', { class: 'section-note' }, 'No assets chosen yet.'));
    }
    current.forEach((item, index) => {
      listEl.append(el('div', { class: 'row' },
        artImg(item.thumbUrl, { alt: item.title, className: 'row-thumb', noArtClass: 'row-thumb no-art' }),
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, `${index + 1}. ${item.title}`),
          el('div', { class: 'row-sub' }, item.kind),
        ),
        !readOnly ? el('div', { class: 'row-side' },
          el('button', { class: 'btn', 'aria-label': `Move ${item.title} up`, disabled: index === 0, onclick: () => { const next = [...items()]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; commit(next); } }, '↑'),
          el('button', { class: 'btn', 'aria-label': `Move ${item.title} down`, disabled: index === current.length - 1, onclick: () => { const next = [...items()]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; commit(next); } }, '↓'),
          el('button', { class: 'btn btn-danger', 'aria-label': `Remove ${item.title}`, onclick: () => commit(items().filter((_, i) => i !== index)) }, '×'),
        ) : null,
      ));
      for (const def of set.itemFields ?? []) {
        listEl.append(el('div', { class: 'item-field' },
          fieldInput(def, item.values?.[def.id], async (value) => {
            const next = items().map((existing, i) => i === index
              ? { ...existing, values: { ...(existing.values ?? {}), [def.id]: value } }
              : existing);
            await commit(next, { redraw: false });
          }, { readOnly }),
        ));
      }
    });

    if (readOnly) return;
    const remaining = cap === null ? null : Math.max(0, cap - current.length);
    addHost.append(el('button', {
      class: 'btn',
      disabled: remaining === 0,
      title: remaining === 0 ? `“${set.label}” already holds its ${cap} asset(s).` : undefined,
      onclick: async () => {
        const picked = await pickAssets({
          title: `Add to ${set.label}`,
          kinds: set.kinds ?? null,
          roles: set.roles ?? null,
          entityId: entity?.id ?? null,
          max: remaining,
          alreadyChosenIds: items().map((item) => item.assetId),
        });
        if (picked.length > 0) {
          await commit([...items(), ...picked.map((asset) => ({ assetId: asset.id, values: {} }))]);
        }
      },
    }, remaining === 0 ? 'This set is full' : 'Choose assets →'));
  };

  renderItems();
  fold(collapsedAssetSets.has(foldKey));
  return section;
}
