import { el, formatDate } from '../ui/dom.js';
import { call } from '../ipc.js';
import { getState } from '../store.js';
import { artImg } from '../ui/art.js';
import { navigate } from '../router.js';

/** Home answers: "What in the library needs attention?" */
export async function renderHome() {
  const counts = await call('library.counts');
  const state = getState();
  const [worlds, characters, documents, productions] = await Promise.all([
    call('entity.list', { type: 'world', limit: 6 }),
    call('entity.list', { type: 'character', limit: 8 }),
    call('document.list', { limit: 5 }),
    call('production.list', {}),
  ]);

  const headline = buildHeadline(counts, productions);
  const host = el('div', { class: 'main-inner wide' });

  /* art from the most recently active world may carry the screen */
  const heroWorld = worlds.find((world) => world.artUrl);
  if (heroWorld) {
    host.append(el('div', { class: 'hero' },
      artImg(heroWorld.artUrl, { alt: heroWorld.name, className: 'hero-art art-bleed' }),
      el('div', { class: 'hero-glow' }),
    ));
  }

  host.append(el('header', { class: 'page-head' },
    el('span', { class: 'eyebrow' }, state.library?.name ?? 'Library'),
    el('h1', {}, headline.text),
    headline.action
      ? el('p', { style: { marginTop: '0.6rem' } },
        el('a', { class: `btn btn-primary${headline.pulse ? ' pulse' : ''}`, href: `#${headline.action.path}` }, headline.action.label))
      : null,
  ));

  /* recent worlds */
  if (worlds.length > 0) {
    const gallery = el('div', { class: 'gallery' });
    for (const world of worlds) {
      gallery.append(el('div', {
        class: 'gallery-item', tabindex: '0', 'aria-label': world.name,
        onclick: () => navigate(`/world/${world.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/world/${world.id}`); },
      },
        artImg(world.artUrl, { alt: world.name }),
        el('div', { class: 'g-name' }, world.name),
      ));
    }
    host.append(el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Worlds'), gallery));
  }

  /* recent characters */
  if (characters.length > 0) {
    const gallery = el('div', { class: 'gallery portraits' });
    for (const character of characters) {
      gallery.append(el('div', {
        class: 'gallery-item', tabindex: '0', 'aria-label': character.name,
        onclick: () => navigate(`/character/${character.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/character/${character.id}`); },
      },
        artImg(character.artUrl, { alt: character.name }),
        el('div', { class: 'g-name' }, character.name),
        el('div', { class: 'g-sub' }, character.worldName ?? ' '),
      ));
    }
    host.append(el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Characters'), gallery));
  }

  /* recently edited documents */
  if (documents.length > 0) {
    const list = el('ul', { class: 'row-list' });
    for (const doc of documents) {
      list.append(el('li', {
        class: 'row', tabindex: '0',
        onclick: () => navigate(`/document/${doc.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/document/${doc.id}`); },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, doc.title),
          el('div', { class: 'row-sub' }, `${doc.wordCount} words · ${doc.links.map((l) => l.name).join(', ') || 'unlinked'}`),
        ),
        el('div', { class: 'row-side' }, formatDate(doc.updatedAt)),
      ));
    }
    host.append(el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Recently edited'), list));
  }

  /* distribution state */
  const distribution = el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'Distribution'));
  if (productions.length === 0) {
    distribution.append(el('p', { class: 'section-note' }, 'No productions yet. A production turns canon into content for one of your applications.'));
  } else {
    const list = el('ul', { class: 'row-list' });
    for (const production of productions.slice(0, 5)) {
      list.append(el('li', {
        class: 'row', tabindex: '0',
        onclick: () => navigate(`/production/${production.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/production/${production.id}`); },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, production.name),
          el('div', { class: 'row-sub' },
            production.publications > 0
              ? `${production.publications} publication(s) · ${production.status}`
              : `never published · ${production.status}`),
        ),
        production.status === 'ready' ? el('div', { class: 'row-side state-ready' }, 'ready') : null,
      ));
    }
    distribution.append(list);
  }
  host.append(distribution);

  /* first-run guidance */
  if (counts.worlds === 0 && counts.inboxUnreviewed === 0) {
    host.append(el('div', { class: 'section' },
      el('p', { class: 'empty-state' },
        'Nothing has been filed yet — create a world, or bring the first folder into the Inbox. The source folder will not be changed.'),
    ));
  }
  return host;
}

function buildHeadline(counts, productions) {
  if (counts.worlds === 0) {
    return { text: 'The archive is empty — begin with a world.', action: { path: '/worlds', label: 'Create a world →' } };
  }
  if (counts.inboxUnreviewed > 0) {
    return {
      text: counts.inboxUnreviewed === 1
        ? 'One imported file is waiting in the Inbox.'
        : `${counts.inboxUnreviewed} imported files are waiting in the Inbox.`,
      action: { path: '/inbox', label: 'Review the Inbox →' },
    };
  }
  const ready = productions.filter((production) => production.status === 'ready');
  if (ready.length > 0) {
    return {
      text: ready.length === 1
        ? `“${ready[0].name}” is ready to publish.`
        : `${ready.length} productions are ready to publish.`,
      action: { path: ready.length === 1 ? `/production/${ready[0].id}/publish` : '/productions', label: 'Publish this snapshot →' },
      pulse: true,
    };
  }
  if (counts.draftProductions > 0) {
    return {
      text: counts.draftProductions === 1
        ? 'One production is still in draft.'
        : `${counts.draftProductions} productions are still in draft.`,
      action: { path: '/productions', label: 'Continue the drafts →' },
    };
  }
  return { text: 'The archive is quiet and in order.', action: null };
}
