import { el } from '../ui/dom.js';
import { call } from '../ipc.js';
import { getState } from '../store.js';

/** Home answers: "What in the library needs attention?" */
export async function renderHome() {
  const counts = await call('library.counts');
  const state = getState();

  const headline = buildHeadline(counts);
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, state.library?.name ?? 'Library'),
      el('h1', {}, headline.text),
    ),
  );

  if (headline.action) {
    host.append(el('p', {},
      el('a', { class: 'btn btn-primary', href: `#${headline.action.path}` }, headline.action.label),
    ));
  }

  const facts = el('dl', { class: 'def-list', style: { marginTop: '1.6rem' } });
  const fact = (label, value) => facts.append(el('dt', {}, label), el('dd', {}, String(value)));
  fact('Worlds', counts.worlds);
  fact('Characters', counts.characters);
  fact('Other entries', counts.entries);
  fact('Documents', counts.documents);
  fact('Assets', counts.assets);
  fact('Inbox awaiting review', counts.inboxUnreviewed);
  fact('Draft productions', counts.draftProductions);
  fact('Publications', counts.publications);
  host.append(el('div', { class: 'section' }, el('span', { class: 'eyebrow' }, 'The library at a glance'), facts));

  return host;
}

function buildHeadline(counts) {
  if (counts.worlds === 0) {
    return {
      text: 'The archive is empty — begin with a world.',
      action: { path: '/worlds', label: 'Create a world →' },
    };
  }
  if (counts.inboxUnreviewed > 0) {
    return {
      text: counts.inboxUnreviewed === 1
        ? 'One imported file is waiting in the Inbox.'
        : `${counts.inboxUnreviewed} imported files are waiting in the Inbox.`,
      action: { path: '/inbox', label: 'Review the Inbox →' },
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
