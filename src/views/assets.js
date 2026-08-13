import { el, clear, formatBytes, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { navigate } from '../router.js';
import { textInput, selectInput, field, tagsInput } from '../ui/forms.js';
import { getState } from '../store.js';
import { artImg } from '../ui/art.js';
import { openOverlay, confirmOverlay } from '../ui/overlay.js';
import { pickEntity } from '../ui/entity-picker.js';
import { showToast } from '../ui/toast.js';
import { createAutosaver } from '../ui/autosave.js';

/* ---------------- assets gallery ---------------- */

export async function renderAssets() {
  const readOnly = getState().library?.readOnly;
  const [worlds, roles] = await Promise.all([
    call('entity.list', { type: 'world' }),
    call('asset.roles'),
  ]);

  const host = el('div', { class: 'main-inner wide' },
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Canon'),
      el('h1', {}, 'Assets'),
      el('p', { class: 'page-lede' }, 'Original artwork, audio, and files — deduplicated, versioned, and never overwritten.'),
    ),
  );

  const filter = { text: '', role: '', kind: '', worldId: '', status: 'active', aspect: '' };
  const galleryHost = el('div', {});

  const render = async () => {
    clear(galleryHost);
    const assets = await call('asset.list', {
      text: filter.text || undefined,
      role: filter.role || undefined,
      kind: filter.kind || undefined,
      worldId: filter.worldId || undefined,
      status: filter.status,
      aspect: filter.aspect || undefined,
    });
    if (assets.length === 0) {
      galleryHost.append(el('p', { class: 'empty-state' },
        'Nothing has been filed yet — bring the first folder into the Inbox, or import files directly.'));
      return;
    }
    const gallery = el('div', { class: 'gallery', role: 'list' });
    for (const asset of assets) {
      gallery.append(el('div', {
        class: 'gallery-item', role: 'listitem', tabindex: '0', 'aria-label': asset.title,
        onclick: () => navigate(`/asset/${asset.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/asset/${asset.id}`); },
      },
        asset.kind === 'image'
          ? artImg(asset.thumbUrl, { alt: asset.title })
          : el('div', { class: 'no-art', style: { aspectRatio: '16 / 10' } }, asset.kind.toUpperCase()),
        el('div', { class: 'g-name' }, asset.title),
        el('div', { class: 'g-sub' }, [asset.kind, ...(asset.roles ?? [])].join(' · ') || ' '),
      ));
    }
    galleryHost.append(gallery);
  };

  const importFlow = async () => {
    const result = await callSafe('asset.importFiles', {});
    if (result && result.imported.length > 0) {
      showToast(`${result.imported.length} file(s) imported as managed assets.`, 'good');
      render();
    }
  };

  host.append(
    el('div', { class: 'toolbar' },
      el('div', { class: 'field grow' },
        el('span', { class: 'eyebrow' }, 'Filter'),
        textInput({ ariaLabel: 'Filter assets', onInput: (value) => { filter.text = value; render(); } }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Role'),
        selectInput({
          value: '', ariaLabel: 'Filter by role',
          options: [{ value: '', label: 'All roles' }, ...roles.map((r) => ({ value: r, label: r }))],
          onChange: (value) => { filter.role = value; render(); },
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Kind'),
        selectInput({
          value: '', ariaLabel: 'Filter by kind',
          options: [
            { value: '', label: 'All kinds' },
            { value: 'image', label: 'Images' },
            { value: 'audio', label: 'Audio' },
            { value: 'markdown', label: 'Markdown' },
            { value: 'attachment', label: 'Attachments' },
          ],
          onChange: (value) => { filter.kind = value; render(); },
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'World'),
        selectInput({
          value: '', ariaLabel: 'Filter by world',
          options: [{ value: '', label: 'All worlds' }, ...worlds.map((w) => ({ value: w.id, label: w.name }))],
          onChange: (value) => { filter.worldId = value; render(); },
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Shape'),
        selectInput({
          value: '', ariaLabel: 'Filter by aspect',
          options: [
            { value: '', label: 'Any shape' },
            { value: 'wide', label: 'Wide' },
            { value: 'tall', label: 'Tall' },
            { value: 'square', label: 'Square-ish' },
          ],
          onChange: (value) => { filter.aspect = value; render(); },
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Status'),
        selectInput({
          value: 'active', ariaLabel: 'Filter by status',
          options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }],
          onChange: (value) => { filter.status = value; render(); },
        }),
      ),
      !readOnly ? el('button', { class: 'btn btn-primary', onclick: importFlow }, 'Import files →') : null,
    ),
    galleryHost,
  );

  document.addEventListener('worldhub:new-item', (e) => {
    if (e.detail?.section === '/assets' && !readOnly) importFlow();
  }, { once: true });

  await render();
  return host;
}

/* ---------------- asset detail ---------------- */

export async function renderAssetDetail({ id }) {
  let asset = await call('asset.get', { id });
  const readOnly = getState().library?.readOnly;
  const host = el('div', { class: 'main-inner wide' });

  const reload = async () => {
    asset = await call('asset.get', { id });
    navigate(`/asset/${id}`);
  };

  const current = asset.versions.find((v) => v.id === asset.currentVersionId) ?? asset.versions[0];

  host.append(
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, `Asset · ${asset.kind}`),
      el('h1', {}, asset.title),
      el('p', { class: 'meta-line' },
        [asset.status === 'archived' ? 'Archived' : 'Active',
          `${asset.versions.length} version(s)`,
          current ? formatBytes(current.size) : '',
          current?.width ? `${current.width}×${current.height}` : '',
          current?.durationSeconds ? `${current.durationSeconds}s` : '',
        ].filter(Boolean).join(' · ')),
    ),
  );

  /* current art or media */
  if (asset.kind === 'image' && asset.url) {
    host.append(el('div', { class: 'hero' },
      artImg(asset.url, { alt: asset.title, className: 'hero-art art-bleed' }),
      el('div', { class: 'hero-glow' }),
    ));
  } else if (asset.kind === 'audio' && current) {
    const audio = el('audio', { controls: true, src: current.url, style: { width: '100%', maxWidth: '30rem' } });
    host.append(el('div', { class: 'section' }, audio));
  }

  /* editable title + notes + tags */
  const patch = {};
  const saver = createAutosaver({
    save: async () => {
      await call('asset.update', { id: asset.id, ...patch });
      Object.keys(patch).forEach((k) => delete patch[k]);
    },
  });
  const change = (key) => (value) => { if (!readOnly) { patch[key] = value; saver.markDirty(); } };

  host.append(el('div', { class: 'section', style: { maxWidth: '44rem' } },
    el('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, saver.stateEl),
    field('Title', textInput({ value: asset.title, onInput: change('title'), ariaLabel: 'Asset title' })),
    field('Notes', textInput({ value: asset.notes, onInput: change('notes'), ariaLabel: 'Notes' })),
    field('Tags', tagsInput({
      tags: asset.tags,
      onSave: (names) => callSafe('tag.setForSubject', { subjectType: 'asset', subjectId: asset.id, tags: names }),
    })),
  ));

  /* associations */
  const linksSection = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Associations'));
  const renderLinks = () => {
    while (linksSection.children.length > 1) linksSection.lastChild.remove();
    if (asset.links.length === 0) {
      linksSection.append(el('p', { class: 'section-note' }, 'Not associated with any record yet.'));
    } else {
      const list = el('ul', { class: 'row-list' });
      for (const link of asset.links) {
        list.append(el('li', { class: 'row' },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' }, link.name),
            el('div', { class: 'row-sub' }, `${link.type} · ${link.role}`),
          ),
          !readOnly ? el('div', { class: 'row-side' },
            el('button', {
              class: 'btn btn-danger', 'aria-label': `Remove association with ${link.name}`,
              onclick: async () => {
                const remaining = asset.links.filter((l) => l.link_id !== link.link_id)
                  .map((l) => ({ entityId: l.id, role: l.role }));
                const updated = await callSafe('asset.setLinks', { id: asset.id, links: remaining });
                if (updated) { asset = updated; renderLinks(); }
              },
            }, 'Remove'),
          ) : null,
        ));
      }
      linksSection.append(list);
    }
    if (!readOnly) {
      linksSection.append(el('p', { style: { marginTop: '0.6rem' } },
        el('button', { class: 'btn', onclick: addLinkFlow }, 'Associate with a record →')));
    }
  };
  const addLinkFlow = async () => {
    const picked = await pickEntity({ title: 'Associate this asset with…' });
    if (!picked) return;
    const roles = await call('asset.roles');
    openOverlay((close) => {
      const roleSelect = el('select', { 'aria-label': 'Semantic role' });
      for (const role of roles) roleSelect.append(el('option', { value: role }, role));
      return el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          const links = [...asset.links.map((l) => ({ entityId: l.id, role: l.role })), { entityId: picked.id, role: roleSelect.value }];
          const updated = await callSafe('asset.setLinks', { id: asset.id, links });
          if (updated) { asset = updated; renderLinks(); }
          close();
        },
      },
        el('h2', {}, `Role for ${picked.name}`),
        el('p', { class: 'dim' }, 'The role tells consuming apps what this art means, never how it is stored.'),
        el('div', { class: 'field', style: { marginTop: '1rem' } }, roleSelect),
        el('div', { class: 'overlay-actions' },
          el('button', { class: 'btn btn-primary', type: 'submit' }, 'Associate →'),
          el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        ),
      );
    }, { label: 'Choose a role' });
  };
  renderLinks();
  host.append(linksSection);

  /* renditions */
  if (asset.kind === 'image' && current) {
    host.append(el('div', { class: 'section' },
      el('span', { class: 'eyebrow' }, 'Renditions'),
      el('p', { class: 'section-note' }, 'Reusable shapes derived from the original. Crops are stored as instructions — the original is never altered.'),
      el('p', { style: { marginTop: '0.6rem' } },
        el('button', { class: 'btn btn-primary', onclick: () => openRenditionEditor(asset, current, reload) }, 'Open the rendition editor →')),
      asset.renditions.length > 0 ? renditionStrip(asset.renditions) : null,
    ));
  }

  /* versions */
  const versionsSection = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Versions'));
  const versionList = el('ul', { class: 'row-list' });
  for (const version of asset.versions) {
    versionList.append(el('li', { class: 'row' },
      asset.kind === 'image' ? artImg(version.url, { alt: `Version ${version.versionNumber}`, className: 'row-thumb', noArtClass: 'row-thumb no-art' }) : null,
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title' },
          `Version ${version.versionNumber}`,
          version.id === asset.currentVersionId ? ' — current' : ''),
        el('div', { class: 'row-sub' },
          [version.originalFilename, version.importedFrom, formatBytes(version.size), formatDate(version.createdAt), version.note]
            .filter(Boolean).join(' · ')),
      ),
      el('div', { class: 'row-side' },
        el('button', {
          class: 'btn', onclick: () => callSafe('asset.revealOriginal', { versionId: version.id }),
        }, 'Reveal file'),
      ),
    ));
  }
  versionsSection.append(versionList);
  if (!readOnly) {
    versionsSection.append(el('p', { style: { marginTop: '0.6rem' } },
      el('button', {
        class: 'btn',
        onclick: async () => {
          const updated = await callSafe('asset.replaceVersion', { id: asset.id });
          if (updated) { showToast('A new version was created. Earlier versions stay untouched.', 'good'); reload(); }
        },
      }, 'Replace with a new version →'),
      el('span', { class: 'section-note', style: { marginLeft: '1rem' } }, 'Earlier bytes are never overwritten or deleted.'),
    ));
  }
  host.append(versionsSection);

  /* usage */
  const usage = await call('asset.usage', { id: asset.id });
  const usageSection = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Usage'));
  if (usage.links.length === 0 && usage.productions.length === 0 && usage.preferredIn.length === 0) {
    usageSection.append(el('p', { class: 'section-note' }, 'Nothing references this asset yet.'));
  } else {
    const list = el('ul', { class: 'row-list' });
    for (const link of usage.links) {
      list.append(el('li', {
        class: 'row', onclick: () => navigate(link.type === 'world' ? `/world/${link.id}` : link.type === 'character' ? `/character/${link.id}` : `/entry/${link.id}`),
      }, el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, link.name), el('div', { class: 'row-sub' }, link.role))));
    }
    for (const pref of usage.preferredIn) {
      list.append(el('li', { class: 'row' }, el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, pref.name), el('div', { class: 'row-sub' }, `preferred ${pref.via}`))));
    }
    for (const production of usage.productions) {
      list.append(el('li', { class: 'row', onclick: () => navigate(`/production/${production.id}`) },
        el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, production.name), el('div', { class: 'row-sub' }, `production · ${production.status}`))));
    }
    usageSection.append(list);
  }
  host.append(usageSection);

  /* care */
  if (!readOnly) {
    host.append(el('div', { class: 'section' },
      el('span', { class: 'eyebrow' }, 'Care'),
      asset.status === 'active'
        ? el('button', {
          class: 'btn btn-danger',
          onclick: async () => {
            const confirmed = await confirmOverlay({
              title: `Archive “${asset.title}”?`,
              body: usage.links.length > 0 ? `It is associated with ${usage.links.length} record(s); the associations are kept.` : 'Nothing references it.',
              guarantee: 'The original files and every version stay in the library.',
              confirmLabel: 'Archive this asset', danger: true,
            });
            if (confirmed) { await callSafe('asset.setArchived', { id: asset.id, archived: true }); navigate('/assets'); }
          },
        }, 'Archive this asset')
        : el('button', {
          class: 'btn btn-primary',
          onclick: async () => { await callSafe('asset.setArchived', { id: asset.id, archived: false }); reload(); },
        }, 'Restore this asset →'),
    ));
  }

  return host;
}

function renditionStrip(renditions) {
  const strip = el('div', { class: 'gallery', style: { marginTop: '0.8rem', gridTemplateColumns: 'repeat(auto-fill, minmax(9rem, 1fr))' } });
  for (const rendition of renditions) {
    strip.append(el('div', { class: 'gallery-item' },
      artImg(rendition.url, { alt: rendition.recipe_id }),
      el('div', { class: 'g-sub' }, `${rendition.recipe_id} · ${rendition.width}×${rendition.height}`),
    ));
  }
  return strip;
}

/* ---------------- rendition editor ---------------- */

/**
 * Previews all requested shapes from one original; stores focal point,
 * zoom, pan, rotation, and background per version and recipe.
 */
async function openRenditionEditor(asset, version, onDone) {
  const recipes = (await call('recipe.list')).filter((r) => r.format !== 'original');
  const readOnly = getState().library?.readOnly;

  openOverlay((close) => {
    let currentRecipe = recipes[0];
    const crop = { focalX: 0.5, focalY: 0.5, zoom: 1, panX: 0, panY: 0, rotation: 0, background: '' };
    let saveTimer = null;

    const previewImg = el('img', { alt: 'Rendition preview', style: { maxWidth: '100%', maxHeight: '46vh', margin: '0 auto', display: 'block' } });
    const previewState = el('p', { class: 'save-state', role: 'status' }, '');

    const loadCrop = async () => {
      const stored = await call('crop.get', { versionId: version.id, recipeId: currentRecipe.id });
      Object.assign(crop, stored ? {
        focalX: stored.focal_x, focalY: stored.focal_y, zoom: stored.zoom,
        panX: stored.pan_x, panY: stored.pan_y, rotation: stored.rotation, background: stored.background,
      } : { focalX: 0.5, focalY: 0.5, zoom: 1, panX: 0, panY: 0, rotation: 0, background: '' });
      syncSliders();
      await regenerate(false);
    };

    const regenerate = async (save = true) => {
      previewState.textContent = 'Rendering…';
      previewState.className = 'save-state saving';
      try {
        if (save && !readOnly) {
          await call('crop.set', { versionId: version.id, recipeId: currentRecipe.id, ...crop });
        }
        const rendition = await call('rendition.generate', { versionId: version.id, recipeId: currentRecipe.id });
        previewImg.src = `${rendition.url}?t=${Date.now()}`;
        previewState.textContent = `${currentRecipe.id} — ${rendition.width}×${rendition.height}, regenerated deterministically.`;
        previewState.className = 'save-state saved';
      } catch (err) {
        previewState.textContent = err.message;
        previewState.className = 'save-state error';
      }
    };
    const scheduleRegenerate = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => regenerate(true), 350);
    };

    const slider = (label, key, min, max, step) => {
      const input = el('input', {
        type: 'range', min: String(min), max: String(max), step: String(step),
        value: String(crop[key]), 'aria-label': label,
        oninput: (e) => { crop[key] = Number(e.target.value); scheduleRegenerate(); },
        disabled: readOnly,
      });
      return el('div', { class: 'field' }, el('span', { class: 'eyebrow' }, label), input);
    };
    const sliders = el('div', {},
      slider('Focal point — horizontal', 'focalX', 0, 1, 0.01),
      slider('Focal point — vertical', 'focalY', 0, 1, 0.01),
      slider('Zoom', 'zoom', 1, 4, 0.05),
      slider('Rotation', 'rotation', -45, 45, 1),
    );
    const syncSliders = () => {
      const inputs = sliders.querySelectorAll('input');
      inputs[0].value = String(crop.focalX);
      inputs[1].value = String(crop.focalY);
      inputs[2].value = String(crop.zoom);
      inputs[3].value = String(crop.rotation);
    };

    const recipeTabs = el('div', { class: 'tabs', role: 'tablist' });
    for (const recipe of recipes) {
      recipeTabs.append(el('button', {
        class: `tab${recipe.id === currentRecipe.id ? ' active' : ''}`,
        role: 'tab', 'aria-selected': recipe.id === currentRecipe.id ? 'true' : 'false',
        onclick: (e) => {
          currentRecipe = recipe;
          for (const sibling of recipeTabs.children) {
            sibling.classList.toggle('active', sibling === e.target);
            sibling.setAttribute('aria-selected', sibling === e.target ? 'true' : 'false');
          }
          loadCrop();
        },
      }, recipe.id));
    }

    loadCrop();
    return el('div', {},
      el('h2', {}, 'Rendition editor'),
      el('p', { class: 'dim' }, `Shaping “${asset.title}”, version ${version.versionNumber}. The original is never changed.`),
      recipeTabs,
      previewImg,
      previewState,
      sliders,
      el('div', { class: 'overlay-actions' },
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            for (const recipe of recipes) {
              try { await call('rendition.generate', { versionId: version.id, recipeId: recipe.id }); } catch { /* per-shape errors shown when opened */ }
            }
            close();
            onDone();
          },
        }, 'Generate every shape →'),
        el('button', { class: 'btn', onclick: () => { close(); onDone(); } }, 'Done'),
      ),
    );
  }, { label: 'Rendition editor', wide: true });
}
