# Design

## Theme

**The Darkroom.**

A darkroom is lit by a deep red safelight because red doesn't expose photographic paper — you can see to work without destroying what you're developing. That is a real, functional reason for red in a technical tool, and it is the opposite of the neon-hacker reflex.

The metaphor does actual work here: **an image resolves out of nothing.** A finding starts latent — present but not yet legible — and develops into fact as evidence accumulates. That is precisely the epistemics this product is trying to teach, so the visual system and the data model say the same thing.

**Take the logic, never the props.** No film-strip borders. No photo-paper texture. No sprocket holes, vignettes, or faux grain. One drop of skeuomorphism and it reads as a costume. The darkroom is present as: a near-black surface with a faint red cast, amber as the working light, and content that develops.

Dark is not a default here — it's correct. Investigators often work alone at night in an unlit room. A light interface would be a lamp in their face.

## Color

OKLCH throughout. Strategy: **Restrained** — tinted neutrals plus a rationed accent.

### Core

```css
--bg:            oklch(0.16 0.008 20);   /* near-black, faint red cast */
--bg-sunken:     oklch(0.13 0.008 20);   /* wells, code blocks, empty */
--surface:       oklch(0.21 0.010 20);   /* panels, one step up */
--surface-raised:oklch(0.25 0.012 20);   /* popovers, menus */
--border:        oklch(0.30 0.008 20);   /* hairline, 1px */
--border-strong: oklch(0.38 0.010 20);   /* focused / active edges */

--primary:       oklch(0.40 0.130 20);   /* oxblood — selection, identity */
--primary-hover: oklch(0.46 0.140 20);
--primary-ink:   oklch(0.96 0.010 30);   /* text on primary */

--accent:        oklch(0.76 0.140 65);   /* safelight amber — LIVE only */
--accent-dim:    oklch(0.52 0.090 65);
```

### The confidence ramp — the heart of the system

Confidence is carried by **luminance and weight, never hue**, so it survives greyscale and every form of colour blindness. Explicit tokens, not opacity, so contrast is guaranteed rather than hoped for.

```css
--ink-latent:     oklch(0.63 0.006 40);  /* unverified   — 5.0:1, weight 400 */
--ink-developing: oklch(0.80 0.008 60);  /* corroborated — 9.2:1, weight 450 */
--ink-developed:  oklch(0.96 0.004 60);  /* confirmed    — 14.8:1, weight 600 */
--ink-fixed:      oklch(0.52 0.004 40);  /* refuted — struck through, muted */
```

| State | Token | Weight | Reads as |
|---|---|---|---|
| `unverified` | `--ink-latent` | 400 | present but not yet real |
| `corroborated` | `--ink-developing` + amber marker | 450 | developing |
| `confirmed` | `--ink-developed` | 600 | fully developed, fact |
| `refuted` | `--ink-fixed`, `line-through` | 400 | fixed and discarded |

**Every level stays comfortably readable.** Latent is dimmer, not hidden — nobody should have to hover to read their own results. The hierarchy is obvious at a glance and invisible as an obstacle.

### Text

```css
--ink:        oklch(0.94 0.005 60);   /* primary text  — 13.6:1 */
--ink-muted:  oklch(0.72 0.006 45);   /* secondary     —  6.8:1 */
--ink-subtle: oklch(0.58 0.005 40);   /* metadata      —  4.6:1 */
```

`--ink-subtle` is the floor. Nothing dimmer carries text, ever — including placeholders, which must hit 4.5:1 like everything else.

### Semantic

The palette is red-and-amber dominant, which collides with conventional error/warning colour. Two rules resolve it:

1. **Oxblood primary is dark (L 0.40); error is bright (L 0.66).** Different luminance register, not just different hue.
2. **Hue is never the sole carrier.** Every semantic state ships colour **plus an icon plus a text label.**

```css
--danger:   oklch(0.66 0.190 15);    /* bright rose — always + icon */
--warning:  oklch(0.78 0.130 85);    /* ochre       — always + icon */
--success:  oklch(0.72 0.110 150);   /* sage        — always + icon */
--info:     oklch(0.70 0.090 240);   /* cold slate blue */
```

### Accent discipline

`--accent` (safelight amber) means **live** and nothing else: a run in progress, the row being probed right now, a streaming result. When nothing is running, there is no amber on screen. This is what makes an active run feel like the darkroom light coming on.

Never use amber for decoration, emphasis, links, or headings.

## Typography

**One family, two variants: Geist Sans and Geist Mono.** Designed together, free (OFL), excellent at small sizes, real tabular numerals. Bundled locally — no network font fetch in an offline-capable desktop app.

### The monospace rule

**Monospace is rationed to data and nothing else.** Hashes, coordinates, usernames, timestamps, domains, IPs, file paths, raw tool output. Never headings, never buttons, never labels, never body copy.

This is the whole typographic trick: because mono is rationed, it *means something*. It marks "this is a literal value you could copy, and character-level detail matters." Spend it on chrome and it becomes wallpaper — and you land straight in terminal cosplay.

### Scale

Fixed rem, ratio ≈1.15. Desktop app at consistent DPI — no fluid clamp sizing.

```
0.6875rem / 11px   micro labels (rare, uppercase permitted here only)
0.75rem   / 12px   table cells, metadata, mono data
0.8125rem / 13px   UI default — buttons, labels, nav, most of the app
0.875rem  / 14px   body prose, doc panels
1rem      / 16px   section headings
1.25rem   / 20px   view titles
1.5rem    / 24px   page titles (rare)
```

Doc/prose columns cap at 68ch. Data tables may run to 120ch+.

## Layout

- **Panels and rules, not cards.** Findings are rows separated by 1px hairlines, grouped under panel headers. No rounded boxes floating on a surface, and never nested ones.
- **Three-zone shell:** left nav (collapsible, 200px), main content, right context panel (320px) holding "How this works" and evidence detail. The doc panel is a persistent margin annotation, not a modal.
- **Density is high but measured.** Table rows 30px. Section spacing varies deliberately — 12/16/24/40 — never a uniform 16 everywhere.
- Flexbox for 1D, Grid for 2D.

```css
--space: 4px base → 4 8 12 16 20 24 32 40 48 64
--radius-sm: 3px   /* inputs, badges, buttons */
--radius-md: 5px   /* panels, popovers */
--radius-lg: 8px   /* dialogs */
```

Small radii only. Nothing pill-shaped — pills read consumer-app, and this is an instrument.

```css
--z-dropdown: 100; --z-sticky: 200; --z-backdrop: 300;
--z-modal: 400;    --z-toast: 500;  --z-tooltip: 600;
```

Never arbitrary z-values.

## Motion

```css
--ease: cubic-bezier(0.25, 1, 0.5, 1);   /* ease-out-quart */
--dur-micro:   150ms;   /* hover, focus */
--dur-base:    200ms;   /* panel open, state change */
--dur-develop: 280ms;   /* confidence promotion */
```

Motion conveys state only. No orchestrated load sequences — the app opens into a task.

**Three motions earn their place:**

1. **Findings stream in.** As each result arrives from a running tool it appears with a 20ms stagger. This is not decoration — it reflects genuine arrival order, and it's why a run feels alive rather than frozen.
2. **Developing.** When a finding is promoted `unverified → corroborated → confirmed`, it transitions colour and weight over `--dur-develop`. The single most thematic moment in the app.
3. **The safelight sweep.** During an active run, a subtle amber gradient passes across the row currently being probed. This is the one atmospheric flourish permitted, and only while something is actually running.

`prefers-reduced-motion: reduce` → stagger becomes instant, developing becomes an immediate state change, the sweep becomes a static amber left-marker. Non-negotiable.

## Components

Every interactive component ships **all seven states**: default, hover, focus, active, disabled, loading, error. Half-built components don't ship.

- **Focus rings** meet 3:1 against both the surface and the adjacent element. Keyboard navigation throughout; no mouse-only affordances.
- **Skeletons, not spinners**, for content loading.
- **Progress is honest.** Never a bare spinner for a tool run. Show: `probing 247 / 3000 · 11 hits · 0:42 elapsed` plus the site being hit right now. These tools take minutes; a spinner is a lie.
- **Empty states teach.** Not "No findings." Instead: what this view does, what to feed it, and one concrete example. The Range's empty state explains what geolocation training is.
- **Copy affordance on every literal value** — hashes, coords, usernames, URLs — with real confirmation feedback, not a silent success.
- **The doc panel.** Every adapter's mandatory `doc` block renders in the right panel: what / how / why / better at / worse at / how it lies to you. Always reachable, never a modal.

### Banned in this project

Everything in the shared absolute bans, plus:

- Side-stripe borders (`border-left` accents) — rewrite with full hairlines or background tint
- Gradient text
- Glassmorphism
- Uppercase tracked eyebrows above sections (11px micro-labels inside dense panels are the sole exception)
- Cards as the default container
- Modal as first thought — exhaust the right panel and inline disclosure first
- Any terminal cosplay: scanlines, glitch effects, falling characters, `>` prompt decoration, blinking block cursors, ASCII-art headers
- Fear framing in copy — no "EXPOSED", no big red threat scores, no sirens

## Voice

Patient, exacting, unimpressed. It states what was found and what it can't support. It never celebrates a result and never dramatizes a risk.

| Don't | Do |
|---|---|
| "⚠️ 47 accounts exposed!" | "47 candidate accounts. 3 corroborated, 44 unverified." |
| "Scanning..." | "Probing 247 / 3000 · 11 hits · 0:42" |
| "No data" | "No findings yet. Add a username or email to the case, then run an adapter." |
| "Success!" | "Copied." |
| "Something went wrong" | "maigret exited 1: connection reset after 2,140 sites. Partial results kept." |
