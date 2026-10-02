import { el } from '../ui/dom.js';
import { call } from '../ipc.js';
import { getState } from '../store.js';
import { navigate } from '../router.js';

/**
 * Home is a wall the library's characters are hung on.
 *
 * One character keeps the wall for the day, standing full length at the
 * right. Around them, fifteen pieces of character art overlap without
 * frames — the art's own alpha does the joining. Every few seconds the
 * faintest piece leaves, everyone else steps one place further back,
 * and a clear piece is stamped in front. Each opening hangs a new wall.
 */

/* Shapes by role, and how often each is drawn. Portraits and stamps are
   most of any library, so they come up most; the rare shapes still turn
   up often enough to be seen. */
const SHAPES = {
  'character.portrait': { key: 'portrait', ratio: 3 / 4, height: 0.31, weight: 34, label: 'portrait' },
  'character.stamp': { key: 'stamp', ratio: 4 / 3, height: 0.26, weight: 30, label: 'stamp' },
  'character.collectible': { key: 'square', ratio: 1, height: 0.28, weight: 13, label: 'square' },
  'character.full_body': { key: 'full', ratio: 9 / 16, height: 0.49, weight: 11, label: 'full body' },
  'character.tile': { key: 'tile', ratio: 16 / 9, height: 0.24, weight: 12, label: 'tile' },
};

const PLACES = 15;            // pieces on the wall at once
const TURN_MS = 10_000;       // one piece leaves, one arrives
const SWAP_MS = 1_800;        // between the leaving and the stamp
const STAMP_GAP_MS = 170;     // between stamps while the wall is first hung
const SETTLE_MS = 700;        // pause before the hung wall recedes

/* Fifteen places in a brickwork of five by three, as fractions of the
   wall. The right side is left to the character who keeps the wall. */
const CELLS = [];
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 5; col++) {
    CELLS.push({ x: 0.094 + 0.1225 * col + (row % 2 ? 0.042 : 0), y: 0.36 + 0.26 * row });
  }
}

export async function renderHome() {
  const state = getState();
  const [counts, productions, pool] = await Promise.all([
    call('library.counts'),
    call('production.list', {}),
    call('gallery.characterWall'),
  ]);
  const attention = attentionLine(counts, productions);
  const libraryName = state.library?.name ?? 'Library';

  if (pool.length === 0) return emptyHome(libraryName, attention, counts);

  const lead = leadForToday(pool);
  const others = pool.filter((piece) => piece.characterId !== lead.characterId);
  const hangable = others.length > 0 ? others : pool.filter((piece) => piece.assetId !== lead.assetId);

  const wall = el('div', { class: 'home-wall' });
  const leadArt = el('a', {
    class: `wall-lead wall-lead-${SHAPES[lead.role].key}`,
    href: `#/character/${lead.characterId}`,
    'aria-label': `${lead.name}, ${SHAPES[lead.role].label}`,
  }, el('img', { alt: '', decoding: 'async' }));

  const headline = hangable.length > 0
    ? `${lead.name} keeps the wall today; the others take turns.`
    : `${lead.name} keeps the wall today.`;

  const head = el('header', { class: 'wall-head' },
    el('div', { class: 'wall-eyebrow eyebrow' },
      el('span', {}, `${libraryName} · ${todayLabel()}`),
      el('span', { 'aria-hidden': 'true' }, '·'),
      el('button', { class: 'btn wall-rehang', type: 'button', onclick: () => navigate('/home') }, 'Rehang the wall'),
    ),
    el('h1', {}, headline),
    attention
      ? el('p', { class: 'wall-attention' },
        `${attention.text} `,
        attention.action
          ? el('a', { class: `btn btn-primary${attention.pulse ? ' pulse' : ''}`, href: `#${attention.action.path}` }, attention.action.label)
          : null)
      : null,
  );

  const keeper = el('div', { class: 'wall-keeper' },
    el('div', { class: 'eyebrow' }, lead.worldName ? `${lead.worldName} · keeps the wall today` : 'Keeps the wall today'),
    el('div', { class: 'wall-keeper-name' }, lead.name),
    el('a', { href: `#/character/${lead.characterId}` }, `Visit ${lead.name} →`),
  );

  const justName = el('span', { class: 'wall-just-name' });
  const justMeta = el('span', { class: 'wall-just-meta' });
  const just = el('div', { class: 'wall-just', hidden: true },
    el('div', { class: 'eyebrow' }, 'Just hung'),
    el('div', {}, justName, justMeta),
  );

  wall.append(leadArt, head, keeper, just);
  startWallWhenShown(wall, { lead, leadArt, pool: hangable, just, justName, justMeta });
  return wall;
}

/* ---------------- the wall ---------------- */

/** The router attaches the view after this returns; begin once it has. */
function startWallWhenShown(wall, parts) {
  let tries = 0;
  const wait = () => {
    if (wall.isConnected) { runWall(wall, parts); return; }
    if (++tries < 100) setTimeout(wait, 20);
  };
  setTimeout(wait, 0);
}

async function runWall(wall, { lead, leadArt, pool, just, justName, justMeta }) {
  const still = motionReduced();
  const alive = () => wall.isConnected;
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  const byShape = new Map();
  for (const piece of pool) {
    if (!byShape.has(piece.role)) byShape.set(piece.role, []);
    byShape.get(piece.role).push(piece);
  }
  const places = Math.min(PLACES, pool.length);
  const cells = shuffle(CELLS.slice()).slice(0, places);
  const ages = shuffle(Array.from({ length: places }, (_, i) => i));
  const slots = [];
  let settled = false;
  /* Looking at a piece holds the wall still: a pointer that is over a
     piece and has moved lately, or keyboard focus on one. A pointer
     simply left resting on the wall does not stop it for good. */
  let pointerOver = false;
  let focused = false;
  let lastMove = 0;
  const HOLD_AFTER_MOVE_MS = 6_000;
  let lastX = null;
  let lastY = null;
  /* Chromium repeats the last pointer position when art moves under a
     still cursor; only a real change of position counts as looking. */
  wall.addEventListener('pointermove', (event) => {
    if (event.clientX === lastX && event.clientY === lastY) return;
    lastX = event.clientX;
    lastY = event.clientY;
    lastMove = Date.now();
  });
  const held = () => focused || (pointerOver && Date.now() - lastMove < HOLD_AFTER_MOVE_MS);

  /* Someone not among the four freshest, in a weighted shape, not already up. */
  const pick = () => {
    const onWall = new Set(slots.map((slot) => slot.piece?.assetId));
    const fresh = new Set(slots.filter((slot) => slot.age <= 3).map((slot) => slot.piece?.characterId));
    let fallback = null;
    for (let tries = 0; tries < 24; tries++) {
      const role = weightedRole(byShape);
      const list = byShape.get(role);
      const piece = list[Math.floor(Math.random() * list.length)];
      if (onWall.has(piece.assetId)) continue;
      if (!fresh.has(piece.characterId)) return piece;
      fallback ??= piece;
    }
    return fallback ?? pool.find((piece) => !onWall.has(piece.assetId)) ?? null;
  };

  const look = (slot) => {
    const t = settled && places > 1 ? slot.age / (places - 1) : 0;
    slot.node.style.zIndex = String(50 - slot.age * 2);
    slot.node.style.opacity = (1 - 0.76 * t).toFixed(3);
    slot.node.style.transform = `translateY(${(-2.3 * t).toFixed(2)}cqh) scale(${(1.06 - 0.28 * t).toFixed(3)})`;
    slot.node.style.filter = `saturate(${(1 - 0.45 * t).toFixed(2)}) brightness(${(1 - 0.48 * t).toFixed(2)})`;
  };

  /* Set a look with no easing, so a stamp lands where it belongs. */
  const jump = (slot) => {
    slot.node.style.transition = 'none';
    look(slot);
    void slot.node.offsetWidth;
    slot.node.style.transition = '';
  };

  const stamp = (slot) => {
    slot.node.classList.add('is-up');
    if (still) return;
    slot.ink.classList.remove('stamping');
    void slot.ink.offsetWidth;
    slot.ink.classList.add('stamping');
  };

  const announce = (piece) => {
    justName.textContent = piece.name;
    justMeta.textContent = `  ·  ${SHAPES[piece.role].label}${piece.worldName ? ` · ${piece.worldName}` : ''}`;
    just.hidden = false;
    if (still) return;
    just.classList.remove('is-new');
    void just.offsetWidth;
    just.classList.add('is-new');
  };

  const hang = (slot, piece, src) => {
    const shape = SHAPES[piece.role];
    slot.piece = piece;
    slot.node.href = `#/character/${piece.characterId}`;
    slot.node.setAttribute('aria-label', `${piece.name}, ${shape.label}`);
    slot.node.style.setProperty('--x', (slot.cell.x + (Math.random() - 0.5) * 0.066).toFixed(4));
    slot.node.style.setProperty('--y', (slot.cell.y + (Math.random() - 0.5) * 0.062).toFixed(4));
    slot.node.style.setProperty('--h', shape.height.toFixed(3));
    slot.node.style.setProperty('--ar', String(shape.ratio));
    slot.img.src = src;
    slot.name.textContent = piece.name;
    slot.world.textContent = piece.worldName ?? '';
  };

  /* Build the places, empty, in the order they will be stacked. */
  for (let i = 0; i < places; i++) {
    const img = el('img', { alt: '', decoding: 'async' });
    const ink = el('span', { class: 'wall-ink' }, img);
    const name = el('span', { class: 'wall-cap-name' });
    const world = el('span', { class: 'eyebrow' });
    const node = el('a', {
      class: 'wall-piece', href: '#',
      onpointerenter: () => { pointerOver = true; },
      onpointerleave: () => { pointerOver = false; },
      onfocus: () => { focused = true; },
      onblur: () => { focused = false; },
    }, ink, el('span', { class: 'wall-cap' }, name, world));
    const slot = { node, ink, img, name, world, cell: cells[i], age: ages[i], piece: null };
    slots.push(slot);
    wall.insertBefore(node, leadArt);
  }

  /* Choose and fetch the opening wall together; hang each as it is ready. */
  const leadReady = ready(lead);
  const opening = slots.map((slot) => {
    const piece = pick();
    slot.piece = piece;
    return piece ? ready(piece) : Promise.resolve(null);
  });

  leadReady.then((src) => {
    if (!alive()) return;
    if (!src) { leadArt.remove(); return; }
    leadArt.querySelector('img').src = src;
    leadArt.classList.add('is-in');
  });

  const order = slots.map((slot, i) => ({ slot, i })).sort((a, b) => b.slot.age - a.slot.age);
  for (const { slot, i } of order) {
    const src = await opening[i];
    if (!alive()) return;
    if (!src) { slot.node.remove(); continue; }
    hang(slot, slot.piece, src);
    jump(slot);
    stamp(slot);
    if (!still) await sleep(STAMP_GAP_MS);
  }
  const hung = slots.filter((slot) => slot.node.isConnected);
  slots.length = 0;
  slots.push(...hung);
  if (!still) await sleep(SETTLE_MS);
  if (!alive()) return;
  settled = true;
  for (const slot of slots) (still ? jump : look)(slot);
  const newest = slots.reduce((a, b) => (b.age < a.age ? b : a), slots[0]);
  if (newest) announce(newest.piece);

  /* Nothing new could ever arrive, or the reader asked for stillness. */
  if (still || pool.length <= slots.length) return;

  let turning = false;
  const timer = setInterval(async () => {
    if (!alive()) { clearInterval(timer); return; }
    if (turning || held() || document.hidden) return;
    turning = true;
    try {
      const oldest = slots.reduce((a, b) => (b.age > a.age ? b : a));
      const next = pick();
      const src = next ? await ready(next) : null;
      if (!alive() || !src) return;
      /* the faintest leaves, everyone steps back */
      oldest.node.classList.add('is-leaving');
      for (const slot of slots) if (slot !== oldest) { slot.age += 1; look(slot); }
      await sleep(SWAP_MS);
      if (!alive()) return;
      /* and a clear one is stamped in front */
      oldest.node.classList.remove('is-leaving');
      oldest.age = 0;
      hang(oldest, next, src);
      jump(oldest);
      stamp(oldest);
      announce(next);
    } finally {
      turning = false;
    }
  }, TURN_MS);
}

/**
 * A displayable, decoded source for a piece: its rendition when one can
 * be had (generated on first use, like any gallery), else the original.
 * Null when the file cannot be shown, so the wall passes it over.
 */
async function ready(piece) {
  const generate = async () => {
    try {
      const rendition = await call('rendition.generate', { versionId: piece.versionId, recipeId: piece.recipeId });
      return rendition?.url ?? null;
    } catch {
      return null; /* a read-only library hangs the original instead */
    }
  };
  let src = piece.isRendition ? piece.url : (await generate()) ?? piece.url;
  if (await decodes(src)) return src;
  /* A rendition whose file has gone is made again on request. */
  if (src !== piece.url || piece.isRendition) {
    src = (await generate()) ?? piece.url;
    if (await decodes(src)) return src;
  }
  return null;
}

async function decodes(src) {
  const probe = new Image();
  probe.src = src;
  try {
    await probe.decode();
    return true;
  } catch {
    return false;
  }
}

/* ---------------- choosing ---------------- */

/** The same keeper all day: a full-length piece chosen by the date. */
function leadForToday(pool) {
  const full = pool.filter((piece) => piece.role === 'character.full_body');
  const candidates = (full.length > 0 ? full : pool.filter((piece) => piece.role === 'character.portrait'));
  const list = (candidates.length > 0 ? candidates : pool).slice().sort((a, b) => a.assetId.localeCompare(b.assetId));
  const day = new Date().toISOString().slice(0, 10);
  let hash = 0;
  for (const ch of day) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return list[hash % list.length];
}

function weightedRole(byShape) {
  const roles = [...byShape.keys()];
  const total = roles.reduce((sum, role) => sum + SHAPES[role].weight, 0);
  let roll = Math.random() * total;
  for (const role of roles) {
    roll -= SHAPES[role].weight;
    if (roll <= 0) return role;
  }
  return roles[roles.length - 1];
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function motionReduced() {
  return document.documentElement.dataset.reducedMotion === 'true'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function todayLabel() {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ---------------- words ---------------- */

/** Nothing to hang yet: the archive speaks plainly instead. */
function emptyHome(libraryName, attention, counts) {
  const host = el('div', { class: 'main-inner' });
  host.append(el('header', { class: 'page-head' },
    el('span', { class: 'eyebrow' }, libraryName),
    el('h1', {}, attention?.text ?? 'The archive is quiet and in order.'),
    attention?.action
      ? el('p', { style: { marginTop: '0.6rem' } },
        el('a', { class: `btn btn-primary${attention.pulse ? ' pulse' : ''}`, href: `#${attention.action.path}` }, attention.action.label))
      : null,
  ));
  host.append(el('div', { class: 'section' },
    el('p', { class: 'empty-state' }, counts.worlds === 0 && counts.inboxUnreviewed === 0
      ? 'Nothing has been filed yet — create a world, or bring the first folder into the Inbox. The source folder will not be changed.'
      : 'No character art hangs here yet — give a character a portrait, stamp, or full body and this wall will fill.'),
  ));
  return host;
}

/** The one thing the library would like done, if anything. */
function attentionLine(counts, productions) {
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
  return null;
}
