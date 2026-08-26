import { el, append, clear, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { navigate } from '../router.js';
import { textInput, selectInput } from '../ui/forms.js';
import { getState } from '../store.js';
import { createAutosaver } from '../ui/autosave.js';
import { renderMarkdown } from '../ui/markdown.js';
import { pickEntity } from '../ui/entity-picker.js';
import { openOverlay, confirmOverlay } from '../ui/overlay.js';
import { showToast } from '../ui/toast.js';
import { backLink } from '../ui/back-link.js';

/* ---------------- documents browser ---------------- */

export async function renderDocuments() {
  const readOnly = getState().library?.readOnly;
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Canon'),
      el('h1', {}, 'Documents'),
      el('p', { class: 'page-lede' }, 'Long-form Markdown — biographies, setting guides, studies, timelines, and notes. Every document is an ordinary .md file inside the library.'),
    ),
  );

  const filter = { text: '', status: '' };
  const listHost = el('div', {});

  const render = async () => {
    clear(listHost);
    const documents = await call('document.list', {
      text: filter.text || undefined,
      status: filter.status || undefined,
    });
    if (documents.length === 0) {
      listHost.append(el('p', { class: 'empty-state' },
        'Nothing here yet — write the first document, or link one from a character or world screen.'));
      return;
    }
    const list = el('ul', { class: 'row-list' });
    for (const doc of documents) {
      list.append(el('li', {
        class: 'row', tabindex: '0',
        onclick: () => navigate(`/document/${doc.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/document/${doc.id}`); },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, doc.title),
          el('div', { class: 'row-sub' },
            [doc.links.map((l) => l.name).join(', ') || 'unlinked', `${doc.wordCount} words`, doc.status].join(' · ')),
        ),
        el('div', { class: 'row-side' }, formatDate(doc.updatedAt)),
      ));
    }
    listHost.append(list);
  };

  const createFlow = () => {
    openOverlay((close) => {
      const titleInput = el('input', { type: 'text', placeholder: 'Title', 'aria-label': 'Document title' });
      return el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          const title = titleInput.value.trim();
          if (!title) return;
          try {
            const doc = await call('document.create', { title });
            close();
            navigate(`/document/${doc.id}`);
          } catch (err) { showToast(err.message, 'error'); }
        },
      },
        el('h2', {}, 'Write a new document'),
        el('div', { class: 'field', style: { marginTop: '1rem' } }, titleInput),
        el('div', { class: 'overlay-actions' },
          el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create the document →'),
          el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        ),
      );
    }, { label: 'Create a document' });
  };

  host.append(
    el('div', { class: 'toolbar' },
      el('div', { class: 'field grow' },
        el('span', { class: 'eyebrow' }, 'Filter by title'),
        textInput({ ariaLabel: 'Filter documents', onInput: (value) => { filter.text = value; render(); } }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Status'),
        selectInput({
          value: '',
          options: [
            { value: '', label: 'Draft and canonical' },
            { value: 'draft', label: 'Draft only' },
            { value: 'canonical', label: 'Canonical only' },
            { value: 'archived', label: 'Archived' },
          ],
          onChange: (value) => { filter.status = value; render(); },
          ariaLabel: 'Filter by status',
        }),
      ),
      !readOnly ? el('button', { class: 'btn btn-primary', onclick: createFlow }, 'Write a new document →') : null,
    ),
    listHost,
  );

  document.addEventListener('worldhub:new-item', (e) => {
    if (e.detail?.section === '/documents' && !readOnly) createFlow();
  }, { once: true });

  await render();
  return host;
}

/* ---------------- markdown workspace ---------------- */

export async function renderDocumentDetail({ id }) {
  let doc = await call('document.get', { id });
  const readOnly = getState().library?.readOnly || doc.status === 'archived';
  const host = el('div', { class: 'main-inner wide' });

  let mode = 'split';
  let baseChecksum = doc.checksum;
  let content = doc.content;

  const saver = createAutosaver({
    save: async () => {
      try {
        const result = await call('document.save', { id: doc.id, content, baseChecksum });
        baseChecksum = result.checksum;
        wordsEl.textContent = `${result.wordCount} words`;
      } catch (err) {
        if (err.code === 'document.conflict') {
          conflictFlow();
        }
        throw err;
      }
    },
  });

  const titleInput = el('input', {
    type: 'text',
    value: doc.title,
    'aria-label': 'Document title',
    class: 'serif',
    style: { fontSize: '1.7rem', fontFamily: 'var(--serif)' },
    readOnly,
  });
  titleInput.addEventListener('change', async () => {
    const title = titleInput.value.trim();
    if (!title || title === doc.title) return;
    const renamed = await callSafe('document.rename', { id: doc.id, title });
    if (renamed) { doc = { ...doc, ...renamed }; showToast('Renamed. The file was moved with it.', 'good'); }
  });

  const wordsEl = el('span', { class: 'meta-line' }, `${doc.wordCount} words`);

  const textareaEl = el('textarea', { class: 'md-input', 'aria-label': 'Markdown text', readOnly });
  textareaEl.value = content;
  textareaEl.addEventListener('input', () => {
    content = textareaEl.value;
    if (!readOnly) saver.markDirty();
    schedulePreview();
  });

  const previewHost = el('div', {});
  let previewTimer = null;
  const schedulePreview = () => {
    if (mode === 'edit') return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      clear(previewHost);
      previewHost.append(renderMarkdown(content));
    }, 250);
  };

  const panes = el('div', { class: `md-panes mode-${mode}` });
  const applyMode = () => {
    panes.className = `md-panes mode-${mode}`;
    clear(panes);
    if (mode === 'edit') panes.append(textareaEl);
    else if (mode === 'preview') { clear(previewHost); previewHost.append(renderMarkdown(content)); panes.append(previewHost); }
    else { panes.append(textareaEl, previewHost); clear(previewHost); previewHost.append(renderMarkdown(content)); }
  };

  const modeButton = (value, label) => el('button', {
    class: `tab${mode === value ? ' active' : ''}`,
    role: 'tab',
    'aria-selected': mode === value ? 'true' : 'false',
    onclick: (e) => {
      mode = value;
      for (const sibling of e.target.parentElement.children) {
        sibling.classList.toggle('active', sibling === e.target);
        sibling.setAttribute('aria-selected', sibling === e.target ? 'true' : 'false');
      }
      applyMode();
    },
  }, label);

  /* in-document find */
  const findInput = el('input', {
    type: 'search', placeholder: 'Find in document…', 'aria-label': 'Find in document',
    style: { maxWidth: '12rem' },
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const needle = findInput.value;
    if (!needle) return;
    const haystack = textareaEl.value.toLowerCase();
    const from = textareaEl.selectionEnd ?? 0;
    let at = haystack.indexOf(needle.toLowerCase(), from);
    if (at === -1) at = haystack.indexOf(needle.toLowerCase());
    if (at === -1) { showToast(`“${needle}” is not in this document.`); return; }
    if (mode === 'preview') { mode = 'split'; applyMode(); }
    textareaEl.focus();
    textareaEl.setSelectionRange(at, at + needle.length);
  });

  const insertLinkFlow = async () => {
    const target = await pickInsertTarget();
    if (!target) return;
    const snippet = `[${target.label}](${target.href})`;
    const at = textareaEl.selectionStart ?? textareaEl.value.length;
    textareaEl.setRangeText(snippet, at, textareaEl.selectionEnd ?? at, 'end');
    content = textareaEl.value;
    saver.markDirty();
    schedulePreview();
    textareaEl.focus();
  };

  const conflictFlow = () => {
    openOverlay((close) => el('div', {},
      el('h2', {}, 'This file changed outside World Hub'),
      el('p', { class: 'dim' }, 'The Markdown file on disk was modified by another program since it was loaded. Your editor text has not been saved.'),
      el('p', { class: 'quiet', style: { marginTop: '0.5rem' } }, 'The external change will not be overwritten.'),
      el('div', { class: 'overlay-actions' },
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            close();
            const recovered = await callSafe('document.saveRecovered', { id: doc.id, content });
            if (recovered) { showToast('Your text was saved as a recovered copy.', 'good'); navigate(`/document/${recovered.id}`); }
          },
        }, 'Save my text as a recovered copy →'),
        el('button', {
          class: 'btn',
          onclick: () => { close(); navigate(`/document/${doc.id}`); },
        }, 'Reload the file from disk'),
        el('button', { class: 'btn', onclick: () => close() }, 'Decide later'),
      ),
    ), { label: 'External change detected' });
  };

  /* linked entities */
  const linksHost = el('div', { class: 'meta-line' });
  const renderLinks = () => {
    clear(linksHost);
    linksHost.append('Linked to: ');
    if (doc.links.length === 0) linksHost.append('nothing yet');
    doc.links.forEach((link, index) => {
      if (index > 0) linksHost.append(', ');
      linksHost.append(el('a', {
        href: `#${link.type === 'world' ? `/world/${link.id}` : link.type === 'character' ? `/character/${link.id}` : `/entry/${link.id}`}`,
      }, link.name || 'Untitled record'));
      if (!readOnly) {
        linksHost.append(el('button', {
          class: 'btn', style: { padding: '0 0.3rem' }, 'aria-label': `Unlink ${link.name || 'untitled record'}`,
          onclick: async () => {
            const updated = await callSafe('document.setLinks', { id: doc.id, entityIds: doc.links.filter((l) => l.id !== link.id).map((l) => l.id) });
            if (updated) { doc = { ...doc, ...updated }; renderLinks(); }
          },
        }, '×'));
      }
    });
    if (!readOnly) {
      linksHost.append(' ', el('button', {
        class: 'btn',
        onclick: async () => {
          const picked = await pickEntity({ title: 'Link this document to…', excludeIds: doc.links.map((l) => l.id) });
          if (picked) {
            const updated = await callSafe('document.setLinks', { id: doc.id, entityIds: [...doc.links.map((l) => l.id), picked.id] });
            if (updated) { doc = { ...doc, ...updated }; renderLinks(); }
          }
        },
      }, '+ link a record'));
    }
  };
  renderLinks();

  const careActions = el('div', { class: 'overlay-actions', style: { marginTop: '2rem' } },
    !readOnly ? el('button', {
      class: 'btn',
      onclick: async () => {
        const copy = await callSafe('document.duplicate', { id: doc.id });
        if (copy) navigate(`/document/${copy.id}`);
      },
    }, 'Duplicate →') : null,
    !readOnly && doc.status !== 'archived' ? el('button', {
      class: 'btn btn-danger',
      onclick: async () => {
        const confirmed = await confirmOverlay({
          title: `Archive “${doc.title}”?`,
          body: 'The Markdown file stays in the library and the document can be restored at any time.',
          confirmLabel: 'Archive this document', danger: true,
        });
        if (confirmed) {
          await callSafe('document.setStatus', { id: doc.id, status: 'archived' });
          navigate('/documents');
        }
      },
    }, 'Archive') : null,
    doc.status === 'archived' && !getState().library?.readOnly ? el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        await callSafe('document.setStatus', { id: doc.id, status: 'draft' });
        navigate(`/document/${doc.id}`);
      },
    }, 'Restore to draft →') : null,
  );

  /* The title here is an editable field rather than a headline, so the
     header states the name the next screen's way back should carry. */
  append(host, [
    el('header', { class: 'page-head', 'data-screen-name': doc.title },
      backLink(),
      el('span', { class: 'eyebrow' }, `Document · ${doc.path}`),
      titleInput,
      el('div', { class: 'toolbar', style: { marginTop: '0.4rem', marginBottom: '0' } },
        wordsEl,
        el('span', { class: 'meta-line' }, `edited ${formatDate(doc.updatedAt)}`),
        doc.status === 'archived' ? el('span', { class: 'state-bad' }, 'archived') : null,
        saver.stateEl,
      ),
      linksHost,
    ),
    doc.externallyChanged ? externalChangeNotice(conflictFlow) : null,
    doc.fileMissing ? el('p', { class: 'state-bad' }, 'The Markdown file is missing on disk — this text comes from the database cache. Saving will recreate the file.') : null,
    el('div', { class: 'md-editor' },
      el('div', { class: 'md-toolbar', role: 'tablist', 'aria-label': 'Editor mode' },
        modeButton('edit', 'Write'),
        modeButton('split', 'Side by side'),
        modeButton('preview', 'Preview'),
        el('span', { class: 'spacer' }),
        !readOnly ? el('button', { class: 'btn', onclick: insertLinkFlow }, 'Insert a link to a record →') : null,
        findInput,
      ),
      panes,
    ),
    careActions,
  ]);

  applyMode();
  if (doc.externallyChanged) conflictFlow();
  return host;
}

function externalChangeNotice(onReview) {
  return el('p', { class: 'state-bad', style: { marginBottom: '1rem' } },
    'This file changed outside World Hub since it was last saved here. ',
    el('button', { class: 'btn', onclick: onReview }, 'Review the conflict →'),
  );
}

/** Insertion picker for internal links: entity or document. */
async function pickInsertTarget() {
  const { promise } = openOverlay((close) => el('div', {},
    el('h2', {}, 'Insert a link'),
    el('p', { class: 'dim' }, 'Internal links use stable identifiers, so they survive renames.'),
    el('div', { class: 'overlay-actions', style: { marginTop: '1rem' } },
      el('button', { class: 'btn btn-primary', onclick: () => close('entity') }, 'Link a world, character, or entry →'),
      el('button', { class: 'btn', onclick: () => close('document') }, 'Link another document →'),
      el('button', { class: 'btn', onclick: () => close(undefined) }, 'Cancel'),
    ),
  ), { label: 'Insert a link' });
  const kind = await promise;
  if (kind === 'entity') {
    const picked = await pickEntity({ title: 'Link to which record?' });
    if (!picked) return undefined;
    return { label: picked.name, href: `worldhub://entity/${picked.id}` };
  }
  if (kind === 'document') {
    const picked = await pickDocument();
    if (!picked) return undefined;
    return { label: picked.title, href: `worldhub://document/${picked.id}` };
  }
  return undefined;
}

/** Small overlay to choose a document by title. */
function pickDocument() {
  const { promise } = openOverlay((close) => {
    const results = el('ul', { class: 'row-list' });
    const render = async (query) => {
      const documents = await call('document.list', { text: query || undefined, limit: 30 });
      clear(results);
      if (documents.length === 0) {
        results.append(el('li', { class: 'empty-state', style: { padding: '0.5rem 0' } }, 'No documents match.'));
        return;
      }
      for (const doc of documents) {
        results.append(el('li', { class: 'row', onclick: () => close(doc) },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' }, doc.title),
            el('div', { class: 'row-sub' }, doc.links.map((l) => l.name).join(', ') || 'unlinked'),
          ),
        ));
      }
    };
    const input = el('input', {
      type: 'search', placeholder: 'Type a title…', 'aria-label': 'Search documents',
      oninput: (e) => render(e.target.value),
    });
    render('');
    return el('div', {},
      el('h2', {}, 'Link to which document?'),
      el('div', { class: 'field' }, input),
      el('div', { style: { maxHeight: '18rem', overflowY: 'auto' } }, results),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn', onclick: () => close(undefined) }, 'Cancel'),
      ),
    );
  }, { label: 'Choose a document' });
  return promise;
}
