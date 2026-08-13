import { el, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { getState, update } from '../store.js';
import { field, textInput, selectInput } from '../ui/forms.js';
import { confirmOverlay } from '../ui/overlay.js';
import { showToast } from '../ui/toast.js';
import { applyLibrarySettings } from '../app.js';

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
