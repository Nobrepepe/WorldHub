import { el, clear, formatBytes, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { getState, update } from '../store.js';
import { navigate } from '../router.js';
import { field, textInput, selectInput } from '../ui/forms.js';
import { confirmOverlay } from '../ui/overlay.js';
import { showToast } from '../ui/toast.js';
import { applyLibrarySettings } from '../app.js';

/**
 * Per-recipe transparency. Art drawn to bleed into a consumer's
 * background needs its alpha channel; a recipe told to matte composites
 * transparent pixels onto a flat colour instead, which is a deliberate
 * choice and never a silent one.
 */
async function transparencyFields({ readOnly }) {
  const recipes = (await call('recipe.list')).filter((recipe) => recipe.format === 'webp');
  const host = el('div', { style: { marginTop: '1.2rem' } },
    el('span', { class: 'eyebrow' }, 'Transparency'),
    el('p', { class: 'field-hint', style: { display: 'block', margin: '0.3rem 0 0.7rem' } },
      'Turning one off regenerates that recipe’s renditions the next time they are asked for. Snapshots already published keep the images they shipped with — republish to carry a change into them.'),
  );

  for (const recipe of recipes) {
    const note = el('span', { class: 'quiet' }, transparencyNote(recipe));
    const box = el('input', {
      type: 'checkbox', checked: !!recipe.preserve_alpha, disabled: readOnly,
      'aria-label': `Keep transparency in ${recipe.name}`,
      onchange: async (event) => {
        const wanted = event.target.checked;
        const updated = await callSafe('recipe.update', { id: recipe.id, preserveAlpha: wanted });
        if (!updated) {
          event.target.checked = !!recipe.preserve_alpha;
          return;
        }
        Object.assign(recipe, updated);
        note.textContent = transparencyNote(updated);
        showToast(wanted
          ? `“${updated.name}” keeps transparency.`
          : `“${updated.name}” now mattes transparent pixels.`, wanted ? 'good' : 'info');
      },
    });
    host.append(el('label', {
      style: { display: 'flex', gap: '0.5rem', alignItems: 'baseline', padding: '0.25rem 0' },
    }, box, el('span', {}, recipe.name), note));
  }
  return host;
}

function transparencyNote(recipe) {
  const canvas = recipe.width && recipe.height ? `${recipe.width}×${recipe.height} · ` : '';
  if (recipe.preserve_alpha) return `${canvas}keeps the alpha channel`;
  return `${canvas}matted onto ${recipe.background ? recipe.background : 'the archive floor'}`;
}

const ARCHIVE_SCOPES = [
  { id: 'productions', label: 'Productions', one: 'production', many: 'productions', note: 'and everything they arranged' },
  { id: 'entities', label: 'Records', one: 'record', many: 'records', note: 'worlds, characters and entries' },
  { id: 'assets', label: 'Assets', one: 'asset', many: 'assets', note: 'including their original files' },
  { id: 'documents', label: 'Documents', one: 'document', many: 'documents', note: 'including their Markdown files' },
  { id: 'contracts', label: 'Application contracts', one: 'contract', many: 'contracts', note: 'only ones nothing is built on' },
];

/**
 * Archiving is a promise that nothing is lost by accident, not a
 * promise that nothing can ever be let go. This panel is the one place
 * that empties the archive for good: it counts what would go, names
 * what it refuses to touch and why, and never guesses at the scope.
 */
async function archivePanel({ readOnly }) {
  const section = el('div', { class: 'section', style: { maxWidth: '44rem' } },
    el('span', { class: 'eyebrow' }, 'The archive'),
  );
  const overview = await callSafe('archive.overview');
  if (!overview) return section;

  const total = Object.values(overview.counts).reduce((sum, n) => sum + n, 0);
  if (total === 0) {
    section.append(el('p', { class: 'section-note' }, 'The archive is empty. Nothing has been set aside.'));
    return section;
  }

  section.append(el('p', { class: 'section-note' },
    'Archived material stays readable and restorable. Clearing it removes it from this library for good — the originals leave the disk with it.'));

  const chosen = new Set();
  const includePublications = el('input', { type: 'checkbox', disabled: readOnly });
  const previewHost = el('div', { style: { marginTop: '1rem' } });
  const purgeButton = el('button', { class: 'btn btn-danger', type: 'button', disabled: true }, 'Clear the archive…');
  let currentPreview = null;

  const refresh = async () => {
    clear(previewHost);
    if (chosen.size === 0) {
      purgeButton.disabled = true;
      previewHost.append(el('p', { class: 'section-note' }, 'Choose what to clear.'));
      return;
    }
    previewHost.append(el('p', { class: 'dim' }, 'Counting…'));
    const preview = await callSafe('archive.preview', {
      scopes: [...chosen], includePublications: includePublications.checked,
    });
    clear(previewHost);
    if (!preview) return;
    currentPreview = preview;
    purgeButton.disabled = readOnly || preview.total === 0;

    if (preview.total === 0) {
      previewHost.append(el('p', { class: 'state-good' }, 'Nothing in the chosen scopes can be cleared right now.'));
    } else {
      const lines = ARCHIVE_SCOPES
        .filter((scope) => preview.counts[scope.id] > 0)
        .map((scope) => `${preview.counts[scope.id]} ${preview.counts[scope.id] === 1 ? scope.one : scope.many}`);
      previewHost.append(el('p', {},
        el('span', { class: 'state-bad' }, `${preview.total} item(s) would be removed for good`),
        el('span', { class: 'dim' }, `: ${lines.join(', ')}.`)));
      if (preview.publications > 0) {
        previewHost.append(el('p', { class: 'state-bad' },
          `${preview.publications} published snapshot(s) go with them. Any application still reading one loses it.`));
      }
      if (preview.bytes > 0) {
        previewHost.append(el('p', { class: 'dim' }, `About ${formatBytes(preview.bytes)} returns to the disk${preview.originals > 0 ? `, including ${preview.originals} original file(s)` : ''}.`));
      }
      for (const consequence of preview.consequences) {
        previewHost.append(el('p', { class: 'dim' }, consequence));
      }
    }
    if (preview.blocked.length > 0) {
      previewHost.append(el('span', { class: 'eyebrow', style: { display: 'block', marginTop: '0.9rem' } }, 'Left alone'));
      previewHost.append(el('ul', { class: 'plain-list' },
        ...preview.blocked.slice(0, 12).map((reason) => el('li', { class: 'quiet' }, reason))));
      if (preview.blocked.length > 12) {
        previewHost.append(el('p', { class: 'quiet' }, `…and ${preview.blocked.length - 12} more.`));
      }
    }
  };

  const boxes = el('div', {});
  for (const scope of ARCHIVE_SCOPES) {
    const count = overview.counts[scope.id] ?? 0;
    boxes.append(el('label', {
      style: { display: 'flex', gap: '0.5rem', alignItems: 'baseline', padding: '0.25rem 0' },
    },
      el('input', {
        type: 'checkbox', disabled: readOnly || count === 0,
        onchange: (e) => { if (e.target.checked) chosen.add(scope.id); else chosen.delete(scope.id); refresh(); },
      }),
      el('span', {}, `${scope.label} — ${count} archived`),
      el('span', { class: 'quiet' }, scope.note),
    ));
  }
  includePublications.addEventListener('change', refresh);

  section.append(boxes,
    el('label', { style: { display: 'flex', gap: '0.5rem', alignItems: 'baseline', padding: '0.6rem 0 0' } },
      includePublications,
      el('span', {}, 'Also delete the published snapshots of archived productions'),
      el('span', { class: 'quiet' }, `${overview.publications} snapshot(s)`),
    ),
    previewHost,
    el('div', { class: 'overlay-actions' }, purgeButton),
  );

  purgeButton.addEventListener('click', async () => {
    if (!currentPreview || currentPreview.total === 0) return;
    const confirmed = await confirmOverlay({
      title: `Clear ${currentPreview.total} archived item(s) for good?`,
      body: el('div', {},
        el('p', { class: 'dim' }, 'This cannot be undone from inside World Hub. A safety backup of the database is taken first, but it does not hold the original asset files — only a full archive does.'),
        currentPreview.names.productions.length > 0
          ? el('p', { class: 'quiet' }, `Productions: ${currentPreview.names.productions.join(', ')}`) : null,
        currentPreview.publications > 0
          ? el('p', { class: 'state-bad' }, `${currentPreview.publications} published snapshot(s) are deleted too.`) : null,
      ),
      confirmLabel: 'Clear the archive permanently',
      danger: true,
      guarantee: 'Nothing outside the archive is touched.',
    });
    if (!confirmed) return;
    purgeButton.disabled = true;
    purgeButton.textContent = 'Clearing…';
    const result = await callSafe('archive.purge', {
      scopes: [...chosen], includePublications: includePublications.checked,
    });
    if (!result) {
      purgeButton.disabled = false;
      purgeButton.textContent = 'Clear the archive…';
      return;
    }
    const cleared = ARCHIVE_SCOPES
      .filter((scope) => result.removed[scope.id] > 0)
      .map((scope) => `${result.removed[scope.id]} ${result.removed[scope.id] === 1 ? scope.one : scope.many}`);
    showToast(`Archive cleared: ${cleared.join(', ')}. ${formatBytes(result.bytes)} returned to the disk.`, 'good');
    if (result.failedFiles.length > 0) {
      showToast(`${result.failedFiles.length} file(s) could not be removed; the Integrity centre will list them.`, 'error');
    }
    navigate('/settings');
  });

  await refresh();
  return section;
}

export async function renderSettings() {
  const status = await call('library.status');
  const settings = status.settings;
  const library = status.library;
  const versions = await call('app.versions');
  const readOnly = library.readOnly;

  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Care'),
      el('h1', {}, 'Settings'),
    ),
  );

  const saveSetting = async (patch) => {
    const updated = await callSafe('settings.update', patch);
    if (updated) applyLibrarySettings(updated);
  };

  /* library */
  const nameInput = textInput({ value: library.name, ariaLabel: 'Library name' });
  nameInput.addEventListener('change', async () => {
    const name = nameInput.value.trim();
    if (!name || name === library.name) return;
    const renamed = await callSafe('library.rename', { name });
    if (renamed) {
      update({ library: { ...getState().library, name: renamed.name } });
      showToast('The library was renamed.', 'good');
    }
  });
  host.append(el('div', { class: 'section', style: { maxWidth: '36rem' } },
    el('span', { class: 'eyebrow' }, 'Library'),
    field('Name', nameInput),
    el('p', { class: 'meta-line' }, `Folder: ${library.path}`),
    el('p', { class: 'meta-line' }, `Library id: ${library.libraryId}`),
    el('p', { style: { marginTop: '0.6rem' } },
      el('button', { class: 'btn', onclick: () => callSafe('library.reveal') }, 'Reveal the library folder →'),
    ),
  ));

  /* appearance */
  host.append(el('div', { class: 'section', style: { maxWidth: '36rem' } },
    el('span', { class: 'eyebrow' }, 'Reading and motion'),
    field('Text scale', selectInput({
      value: String(settings.textScale),
      options: [
        { value: '0.9', label: 'Compact (0.9×)' },
        { value: '1', label: 'Standard (1×)' },
        { value: '1.15', label: 'Comfortable (1.15×)' },
        { value: '1.4', label: 'Large (1.4×)' },
      ],
      onChange: (value) => saveSetting({ textScale: Number(value) }),
      ariaLabel: 'Text scale',
    })),
    el('label', { style: { display: 'flex', gap: '0.5rem', alignItems: 'center' } },
      el('input', {
        type: 'checkbox', checked: !!settings.reducedMotion, disabled: readOnly,
        onchange: (e) => saveSetting({ reducedMotion: e.target.checked }),
      }),
      'Reduce motion — disable nonessential animation',
    ),
  ));

  /* renditions */
  host.append(el('div', { class: 'section', style: { maxWidth: '36rem' } },
    el('span', { class: 'eyebrow' }, 'Renditions'),
    field('Default quality', selectInput({
      value: String(settings.renditionQuality),
      options: [
        { value: '70', label: 'Smaller files (70)' },
        { value: '82', label: 'Balanced (82)' },
        { value: '92', label: 'Highest fidelity (92)' },
      ],
      onChange: (value) => saveSetting({ renditionQuality: Number(value) }),
      ariaLabel: 'Default rendition quality',
    }), { hint: 'Applies to recipe defaults; each recipe can be tuned on its own.' }),
    await transparencyFields({ readOnly }),
  ));

  /* backups */
  const backups = await call('backup.list');
  const backupState = el('p', { class: 'save-state', role: 'status' }, '');
  host.append(el('div', { class: 'section', style: { maxWidth: '44rem' } },
    el('span', { class: 'eyebrow' }, 'Backups'),
    el('label', { style: { display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.8rem' } },
      el('input', {
        type: 'checkbox', checked: !!settings.autoBackup, disabled: readOnly,
        onchange: (e) => saveSetting({ autoBackup: e.target.checked }),
      }),
      'Automatic daily safety backup when the library has changed',
    ),
    settings.lastAutoBackupAt ? el('p', { class: 'meta-line' }, `Last safety backup: ${formatDate(settings.lastAutoBackupAt)}`) : null,
    el('div', { class: 'overlay-actions' },
      !readOnly ? el('button', {
        class: 'btn',
        onclick: async () => {
          backupState.textContent = 'Backing up…';
          backupState.className = 'save-state saving';
          const result = await callSafe('backup.safetyNow');
          backupState.textContent = result ? `Safety backup ${result.name} created.` : '';
          backupState.className = 'save-state saved';
        },
      }, 'Back up now →') : null,
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          backupState.textContent = 'Writing the archive…';
          backupState.className = 'save-state saving';
          const result = await callSafe('backup.createArchive', { includePublications: true });
          backupState.textContent = result ? `Archive written to ${result.path} (${result.entries} entries). It can recreate this library on any Arch Linux or Windows PC.` : '';
          backupState.className = result ? 'save-state saved' : 'save-state';
        },
      }, 'Create full archive →'),
      !readOnly ? el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          const confirmed = await confirmOverlay({
            title: 'Restore this library from an archive?',
            body: 'The archive is validated first. The current library is safety-backed-up and kept aside as a renamed folder — nothing is destroyed.',
            confirmLabel: 'Choose an archive and restore', danger: true,
          });
          if (!confirmed) return;
          backupState.textContent = 'Validating and restoring…';
          backupState.className = 'save-state saving';
          const result = await callSafe('backup.replaceFromArchive');
          if (result) {
            showToast(`Restored. The previous library is kept at ${result.retiredPath}.`, 'good');
            location.reload();
          } else {
            backupState.textContent = '';
          }
        },
      }, 'Restore from an archive…') : null,
    ),
    backupState,
    backups.length > 0 ? el('div', { style: { marginTop: '1rem' } },
      el('span', { class: 'eyebrow' }, 'Safety backups in this library'),
      el('ul', { class: 'row-list' },
        ...backups.slice(0, 10).map((backup) => el('li', { class: 'row', style: { cursor: 'default' } },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' }, backup.name),
            el('div', { class: 'row-sub' }, [backup.reason, backup.createdAt ? formatDate(backup.createdAt) : null].filter(Boolean).join(' · ')),
          ),
        )),
      ),
    ) : null,
  ));

  /* the archive */
  host.append(await archivePanel({ readOnly }));

  /* about + leave */
  host.append(el('div', { class: 'section' },
    el('span', { class: 'eyebrow' }, 'About'),
    el('dl', { class: 'def-list' },
      el('dt', {}, 'World Hub'), el('dd', {}, versions.app),
      el('dt', {}, 'Package protocol'), el('dd', {}, String(versions.protocol)),
      el('dt', {}, 'Contract format'), el('dd', {}, String(versions.contract)),
      el('dt', {}, 'Electron'), el('dd', {}, versions.electron),
    ),
    el('p', { style: { marginTop: '1.2rem' } },
      el('button', {
        class: 'btn',
        onclick: async () => {
          await callSafe('library.close');
        },
      }, 'Close this library and return to the chooser →'),
    ),
  ));
  return host;
}
