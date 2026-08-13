# Design philosophy

World Hub's visual identity is permanent: HeroCollector's warm archive palette, applied to an authoring tool.

> **The app is about entering a living archive. It should feel like handling the worlds themselves, not administering records about them.**

## Five governing words

- **Bleed** — significant art exceeds its nominal region and dissolves into the floor (CSS masks, scrims, no hard rectangles around transparent art).
- **Imply** — proximity, typography, and fading rules create groups; boxes do not.
- **Name** — every meaningful block has a small uppercase eyebrow label; states are written in prose, never color alone.
- **One** — one headline, one primary action, one accent thread, at most one pulsing element per view.
- **Quiet** — interface chrome recedes so worlds, characters, prose, and artwork stay dominant.

## Scrolling

World Hub is an authoring application: vertical scrolling is normal and required. The shell is a stable text navigation rail plus a naturally scrolling main document. What is avoided: careless nesting of independent scroll containers, hidden unreachable controls, and layouts that only work at 1440×900. Everything must stay reachable at 960×640, where the rail becomes an accessible drawer.

## Palette

```css
--bg: #12100f;        --bg-2: #1a1512;      --bg-hover: #221b16;
--text: #f4ece1;      --text-dim: #b8aca1;  --muted: #a2958a;
--muted-2: #8e8278;   --faint: #6f645c;
--line: rgba(244,236,225,.14);  --line-input: rgba(244,236,225,.18);
--accent: #e9a94f;    --accent-2: #b48ade;
--good: #6fc9a0;      --bad: #c9705f;
```

Amber is scarce: the primary action, the active tab underline, and the one ready/attention state. Every state that uses color is also written in words. World and character colors belong to content — a restrained glow behind their own art — and never recolor the interface. Real information never uses `--faint` as its only color.

## Typography

- **Instrument Serif** — headlines, world and character names, section titles, meaningful quantities.
- **Figtree** — body, labels, controls, metadata, editing apparatus.

Both are vendored locally with their OFL licenses; there are no web font requests. Sizing is `rem`-based through a `--text-scale` variable; headlines wrap rather than clip at 1.4× scale.

## No box-heavy interface

No filled dashboard panels, bordered cards, pill filters, chips, or icon-button clusters. Grouping is done with spacing, 11px uppercase eyebrows, and horizontal rules that fade before their ends. The exceptions are practical: dense Inbox/search rows may use a very quiet bottom hairline, and code/JSON/Markdown regions sit on a subtly recessed floor. Inputs are transparent with an underlined focus treatment; selects read as text; destructive actions use `--bad` and explicit verbs.

## Art

Covers, portraits, and full bodies carry their screens through masks, alpha-preserving images, radial glows, and full-width scrims. Cropping belongs to the rendition editor, never to layout convenience. Missing art is a deliberate masked hatch with a readable `NO ART` caption — never a broken-image icon.

## Voice

- Sentence case, full stops. Warm and calm, never cute.
- Reactive headlines: "Three worlds have changed since their last publication."
- Written empty states: "Nothing has been filed yet — bring the first folder into the Inbox."
- Actions are verb plus destination: "Create a world →", "Publish this snapshot →".
- Guarantees are explicit: "The source folder will not be changed." "The current publication stays active if validation fails."
- No decorative emoji; no icons that need tooltips to explain themselves.

## Motion and accessibility

- Route crossfade ≈180 ms; hover raises contrast and lifts art at most 2 px.
- One slow pulse may mark the single ready or blocking item.
- Progress animates only while something is happening.
- `prefers-reduced-motion` and the in-app setting disable nonessential motion.
- Visible keyboard focus, semantic elements, ARIA names, focus-trapped overlays, Escape closes the top layer, screen-reader text where the visual alone is not enough.
