import { el, clear, formatDate, formatBytes } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { getState } from '../store.js';
import { confirmOverlay } from '../ui/overlay.js';
import { showToast } from '../ui/toast.js';

export async function renderIntegrity() {
  const readOnly = getState().library?.readOnly;
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Care'),
      el('h1', {}, 'Integrity'),
      el('p', { class: 'page-lede' }, 'Checks compare the database, files, publications, and search index. Repairs only regenerate, rebuild, recreate, or clear verified stale files — content is never deleted automatically and missing originals are never invented.'),
    ),
  );

  const progress = el('p', { class: 'save-state', role: 'status' }, '');
  const resultsHost = el('div', {});

  const renderSummary = (summary, { fromHistory = false } = {}) => {
    clear(resultsHost);
    if (!summary) {
      resultsHost.append(el('p', { class: 'empty-state' }, 'No integrity run has been recorded yet.'));
      return;
    }
    resultsHost.append(el('p', { class: summary.problems > 0 ? 'state-bad' : 'state-good' },
      `${fromHistory ? 'Last run' : 'This run'} (${formatDate(summary.ranAt)}): ` +
      (summary.problems === 0 && summary.notes === 0
        ? 'everything checks out.'
        : `${summary.problems} problem(s), ${summary.notes} note(s).`),
    ));
    for (const finding of summary.findings) {
      const row = el('div', { class: `issue ${finding.severity === 'problem' ? 'error' : 'warning'}` },
        el('span', { class: 'issue-sev' }, finding.severity), ' ',
        el('span', { class: 'issue-text' }, finding.message),
      );
      if (finding.repair && !readOnly) {
        row.append(' ', el('button', {
          class: 'btn',
          onclick: async () => {
            const result = await callSafe('integrity.repair', { repairId: finding.repair });
            if (result) {
              showToast(result.message, result.repaired ? 'good' : 'error');
              runNow();
            }
          },
        }, 'Repair →'));
      }
      resultsHost.append(row);
    }
  };

  const runNow = async () => {
    progress.textContent = 'Checking the database, documents, originals, renditions, publications, and search index…';
    progress.className = 'save-state saving';
    const summary = await callSafe('integrity.run');
    progress.textContent = '';
    if (summary) renderSummary(summary);
  };

  host.append(
    el('div', { class: 'toolbar' },
      el('button', { class: 'btn btn-primary', onclick: runNow }, 'Run all checks →'),
    ),
    progress,
    resultsHost,
  );

  /* blob audit */
  const auditHost = el('div', { class: 'section' },
    el('span', { class: 'eyebrow' }, 'Unreferenced original bytes'),
    el('p', { class: 'section-note' }, 'No automatic process ever deletes originals. This audit lists bytes no asset version uses; you decide whether they move to the recoverable trash.'),
  );
  const auditResults = el('div', {});
  auditHost.append(
    el('p', { style: { margin: '0.6rem 0' } },
      el('button', {
        class: 'btn',
        onclick: async () => {
          const audit = await callSafe('asset.auditBlobs');
          clear(auditResults);
          if (!audit) return;
          if (audit.length === 0) {
            auditResults.append(el('p', { class: 'state-good' }, 'Every stored original is referenced by an asset version.'));
            return;
          }
          for (const blob of audit) {
            auditResults.append(el('div', { class: 'issue warning' },
              el('span', { class: 'issue-text' }, `${blob.path} (${formatBytes(blob.size)}) — ${blob.reason}`),
            ));
          }
          if (!readOnly) {
            auditResults.append(el('p', { style: { marginTop: '0.6rem' } },
              el('button', {
                class: 'btn btn-danger',
                onclick: async () => {
                  const confirmed = await confirmOverlay({
                    title: `Move ${audit.length} unreferenced file(s) to the trash folder?`,
                    body: audit.map((blob) => blob.path).join(', '),
                    guarantee: 'They move to trash/ inside the library and can be brought back by re-importing. Nothing is permanently deleted.',
                    confirmLabel: 'Move them to the trash folder', danger: true,
                  });
                  if (confirmed) {
                    const moved = await callSafe('asset.trashBlobs', { hashes: audit.map((blob) => blob.hash) });
                    if (moved) showToast(`${moved.length} file(s) moved to the recoverable trash.`, 'good');
                    clear(auditResults);
                  }
                },
              }, 'Move all to the trash folder…'),
            ));
          }
        },
      }, 'Audit stored originals →'),
    ),
    auditResults,
  );
  host.append(auditHost);

  const last = await callSafe('integrity.last');
  renderSummary(last, { fromHistory: true });
  return host;
}
