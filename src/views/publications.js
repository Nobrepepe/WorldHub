import { el, clear, formatBytes, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { navigate } from '../router.js';
import { getState } from '../store.js';
import { showToast } from '../ui/toast.js';
import { refreshCounts } from '../app.js';

/* ---------------- publish preview ---------------- */

export async function renderPublishPreview({ id }) {
  const production = await call('production.get', { id });
  const preview = await call('publication.preview', { productionId: id });
  const readOnly = getState().library?.readOnly;
  const host = el('div', { class: 'main-inner wide' });

  host.append(el('header', { class: 'page-head' },
    el('span', { class: 'eyebrow' }, `Publish · ${production.name}`),
    el('h1', {}, 'Preview this snapshot.'),
    el('p', { class: 'page-lede' }, 'A publication is an immutable, self-contained folder. If anything fails, the current publication stays active.'),
  ));

  /* issues */
  const issues = preview.validation.issues;
  const errors = issues.filter((issue) => issue.severity === 'error');
  const issuesSection = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Validation'));
  if (issues.length === 0) {
    issuesSection.append(el('p', { class: 'state-good' }, 'No errors and no warnings.'));
  } else {
    issuesSection.append(el('p', { class: errors.length > 0 ? 'state-bad' : 'dim' },
      `${errors.length} error(s), ${issues.length - errors.length} warning(s).`,
      errors.length > 0 ? ' Errors block publication.' : ' Warnings do not block publication.'));
    for (const issue of issues) {
      issuesSection.append(el('div', { class: `issue ${issue.severity}` },
        el('span', { class: 'issue-sev' }, issue.severity), ' ',
        el('span', { class: 'issue-text' }, issue.message),
      ));
    }
  }
  host.append(issuesSection);

  if (preview.error) {
    host.append(el('p', { class: 'state-bad' }, preview.error));
    return host;
  }

  /* included records */
  const records = preview.records;
  const included = el('div', { class: 'section' },
    el('span', { class: 'eyebrow' }, 'What the snapshot will contain'),
    el('dl', { class: 'def-list' },
      el('dt', {}, 'Canonical records'),
      el('dd', {}, records.entities.map((entity) => `${entity.name} (${entity.type}, revision ${entity.revision})`).join(' · ')),
      el('dt', {}, 'Documents'),
      el('dd', {}, records.documents.length > 0 ? records.documents.map((doc) => doc.title).join(' · ') : `none (mode: ${records.documentsMode})`),
      el('dt', {}, 'Asset files'),
      el('dd', {}, records.assets.map((asset) => `${asset.title} → ${asset.recipes.join(', ')}`).join(' · ') || 'none'),
      el('dt', {}, 'Relationships'),
      el('dd', {}, String(records.relationships)),
      el('dt', {}, 'Renditions to generate'),
      el('dd', {}, preview.renditionsToGenerate > 0 ? `${preview.renditionsToGenerate} (created during publication)` : 'none — all cached'),
      el('dt', {}, 'Estimated size'),
      el('dd', {}, `${formatBytes(preview.estimatedBytes)} (estimate; renditions may differ)`),
    ),
  );
  host.append(included);

  /* diff */
  const diffSection = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Compared with the current publication'));
  if (!preview.diff) {
    diffSection.append(el('p', { class: 'section-note' }, 'This will be the first publication of this production.'));
  } else if (preview.diff.error) {
    diffSection.append(el('p', { class: 'state-bad' }, preview.diff.error));
  } else {
    const line = (label, list) => el('p', { class: 'dim' },
      el('strong', {}, `${label}: `), list.length > 0 ? list.join(', ') : 'none');
    diffSection.append(
      el('p', { class: 'section-note' }, `The active publication is from ${formatDate(preview.diff.previousPublishedAt)}.`),
      line('Added', preview.diff.added),
      line('Changed', preview.diff.changed),
      line('Removed', preview.diff.removed),
    );
  }
  host.append(diffSection);

  /* actions */
  const busy = el('p', { class: 'save-state', role: 'status' }, '');
  host.append(el('div', { class: 'section' },
    el('div', { class: 'overlay-actions' },
      !readOnly ? el('button', {
        class: 'btn btn-primary',
        disabled: errors.length > 0,
        onclick: async (e) => {
          e.target.disabled = true;
          busy.textContent = 'Publishing… generating renditions and verifying the snapshot.';
          busy.className = 'save-state saving';
          try {
            const publication = await call('publication.publish', { productionId: id });
            showToast('The snapshot was published and is now active.', 'good');
            refreshCounts();
            navigate(`/publication/${publication.id}`);
          } catch (err) {
            busy.textContent = `Publication failed — ${err.message}`;
            busy.className = 'save-state error';
            e.target.disabled = false;
          }
        },
      }, 'Publish snapshot →') : null,
      el('button', { class: 'btn', onclick: () => navigate(`/production/${id}`) }, 'Back to the production'),
    ),
    busy,
    el('p', { class: 'section-note', style: { marginTop: '0.6rem' } },
      'The current publication stays active if validation or assembly fails.'),
  ));
  return host;
}

/* ---------------- publication detail (read-only) ---------------- */

export async function renderPublicationDetail({ id }) {
  const publication = await call('publication.get', { id });
  const host = el('div', { class: 'main-inner wide' });

  host.append(el('header', { class: 'page-head' },
    el('span', { class: 'eyebrow' }, `Publication · ${publication.productionName}`),
    el('h1', {}, formatDate(publication.createdAt)),
    el('p', { class: 'meta-line' },
      [publication.isCurrent ? 'Active publication' : 'Historical publication',
        `production revision ${publication.productionRevision}`,
        `contract v${publication.contractVersion}`,
        `${publication.fileCount} file(s)`,
        formatBytes(publication.packageSize)].join(' · ')),
    el('p', { class: 'section-note' }, 'A publication is read-only. It resolves its recorded names, files, revisions, and checksums even after current canon changes.'),
  ));

  if (publication.manifestProblem) {
    host.append(el('p', { class: 'state-bad' }, `The manifest could not be read: ${publication.manifestProblem}`));
  } else {
    const manifest = publication.manifest;
    host.append(el('div', { class: 'section' },
      el('span', { class: 'eyebrow' }, 'Manifest'),
      el('dl', { class: 'def-list' },
        el('dt', {}, 'Publication'), el('dd', {}, manifest.publicationId),
        el('dt', {}, 'Application type'), el('dd', {}, manifest.applicationType),
        el('dt', {}, 'Published (UTC)'), el('dd', {}, manifest.publishedAt),
        el('dt', {}, 'Source library'), el('dd', {}, manifest.sourceLibraryId),
        el('dt', {}, 'Records at exact revisions'), el('dd', {}, manifest.entities.map((entry) => `${entry.type} ${entry.id.slice(0, 8)}… r${entry.revision}`).join(' · ')),
      ),
    ));
  }

  /* verify */
  const verifyState = el('p', { class: 'save-state', role: 'status' }, '');
  host.append(el('div', { class: 'section' },
    el('span', { class: 'eyebrow' }, 'Integrity'),
    el('div', { class: 'overlay-actions' },
      el('button', {
        class: 'btn',
        onclick: async () => {
          verifyState.textContent = 'Verifying checksums…';
          verifyState.className = 'save-state saving';
          const result = await callSafe('publication.verify', { id });
          if (!result) { verifyState.textContent = ''; return; }
          if (result.ok) {
            verifyState.textContent = 'Every file matches its recorded checksum.';
            verifyState.className = 'save-state saved';
          } else {
            verifyState.textContent = `${result.problems.length} file(s) failed: ${result.problems.map((problem) => `${problem.path} (${problem.problem})`).join(', ')}`;
            verifyState.className = 'save-state error';
          }
        },
      }, 'Verify this package →'),
      el('button', { class: 'btn', onclick: () => callSafe('publication.reveal', { id }) }, 'Reveal the folder'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          const result = await callSafe('publication.exportZip', { id });
          if (result) showToast(`Exported ${result.entries} files to ${result.path}. The ZIP holds the exact same bytes as the folder.`, 'good');
        },
      }, 'Export snapshot as ZIP →'),
    ),
    verifyState,
  ));

  /* files */
  const filesSection = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Files'));
  const list = el('ul', { class: 'row-list', style: { maxHeight: '24rem', overflowY: 'auto' } });
  for (const file of publication.files) {
    list.append(el('li', { class: 'row', style: { cursor: 'default' } },
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title', style: { fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' } }, file.path),
        el('div', { class: 'row-sub' }, `${formatBytes(file.size)} · sha256 ${file.checksum.slice(0, 16)}…`),
      ),
    ));
  }
  filesSection.append(list);
  host.append(filesSection,
    el('p', {}, el('a', { class: 'btn', href: `#/production/${publication.productionId}` }, '← Back to the production')));
  return host;
}
