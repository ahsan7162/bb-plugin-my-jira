# Jira Board: design system

The single source for how the plugin looks and moves. The values live as class strings in `parts.tsx`
(Tailwind finds classes by scanning source, so they stay literal); this file says what each one means.
Validated by the user on the in-plugin preview, 2026-10-30; hierarchy pass (Inbox layout) validated the same day.

## Visual thesis

A calm, airy, rounded panel on bb's own neutrals and font, where colour appears only to carry meaning,
once per dimension. The issue type keeps Jira's familiar hue in a rounded-square icon chip. The status
category is a round progress-ring glyph and pill. Every priority has a colour: urgent ones as a tinted tag
with 6px corners, the rest as coloured text. A group header takes a soft tint of what it groups. Shape keeps
type and status apart where their hues are the same family. Chrome stays neutral: segmented controls, stat
labels, avatars and the sign-in panel use bb's neutrals and only their small icons carry colour.
bb's primary colour fills only Connect Jira (Create ticket is an outline button). Amber is for warnings, bb's destructive tone
for errors. "Not plain" comes from rounding, the ring glyphs and motion, not from more colour.

## Hierarchy thesis (Inbox)

The title is the loudest thing on every row and everything else steps back in three tiers: (1) the ticket title;
(2) one muted line, or aligned columns on a wide list, with key, parent, status, priority and age; (3) Open in Jira
and the chevron, shown on hover or keyboard focus. Controls fit in two quiet rows: search beside the site name,
Create ticket as an outline button, Disconnect muted; status chips are plain text until one is on, Type and Group by
are menus, Clear filters appears only when something is on. No summary tiles and no tinted group bands: counts
live in plain headings, stacked in workflow order (in progress, to do, done) so the page reads top to bottom.
Colour and breathing room stay.

Rows, inbox style (`Row` in parts.tsx):
- Wide list (`@container/list` 56rem or more): type glyph | key | title | parent | status | priority | age | actions,
  in fixed columns so the eye runs down them. The parent column drops when no row in the group names a parent.
- Narrow list (and beside an open ticket): title on its own (two lines at most), then one muted line that never wraps:
  key, parent (truncates), status, priority, age.
- Status: the ring and chevron alone where the heading already names the status (grouped by status); the full pill
  otherwise. Always one click, or S.
- Priority: highest and high as their tinted tag with the label; medium, low and lowest as the coloured glyph alone,
  name on hover.
- Parent: a subtask names its task, a task its epic, an epic its initiative; on a board, the ancestor that put it there
  ("via …"). The full chain stays in the ticket view.
- Type: the coloured glyph, no chip background (chips stay in headings and the ticket view).

## Interaction thesis

Quick and soft: two durations and one curve. Hovering a row fades in a faint tint and nudges its chevron
2px right; the selected row gets a ring; the ticket pane enters with an 8px slide from the right and a fade;
a status change pops the pill once; collapsing a group is instant, its chevron rotates; menus and the
shortcut list enter with a fade and a 4px drop. Nothing moves on scroll.

Forbidden: bounce or elastic springs, scroll reveals, parallax, zoom, animating height or any layout
property, anything over 200ms, endless motion other than real loading.

Reduced motion (`prefers-reduced-motion: reduce`): fades only, no slide, no pop, no nudge, no spin.

Allowed patterns: monospace issue keys; progress-ring status glyphs; the
one-time pop on a status change; the spinner and skeleton as real loading states; the 🎉 in the "nothing
assigned" empty state.

## Tokens

### Host-owned (never restyled)
`--background`, `--card`, `--border`, `--muted`, `--muted-foreground`, `--foreground`, `--primary`,
`--ring`, `--destructive`, and the font. Dark mode follows the OS colour scheme, as bb compiles `dark:`.

### Status category (`STATUS` in parts.tsx)
| Category | Ring glyph | Pill |
|---|---|---|
| To do (`new`) | slate-500 / dark slate-400, empty ring | slate-500/15, slate-700 / dark slate-300 |
| In progress (`indeterminate`) | sky-600 / dark sky-400, half ring | sky-500/15, sky-800 / dark sky-200 |
| Done (`done`) | emerald-600 / dark emerald-400, filled with a check | emerald-500/15, emerald-800 / dark emerald-200 |

### Issue type (`TYPES`): chip `X-500/15` with `X-700 / dark X-300`, glyph text `X-600 / dark X-400`
Initiative amber (Star), Epic violet (Layers), Story green (AlignLeft), Task blue (Check), Bug red (Bug),
Security rose (SecurityCheck), Subtask cyan (ChildThread). Boards are teal, like a type (Columns2).

### Priority (`PRIO`)
| Level | Look | Colour |
|---|---|---|
| Highest | tag, double chevron up | red-500/15, red-700 / dark red-300 |
| High | tag, chevron up | orange-500/15, orange-800 / dark orange-300 |
| Medium | text, equals | amber-700 / dark amber-400 |
| Low | text, chevron down | sky-700 / dark sky-400 |
| Lowest | text, double chevron down | slate-600 / dark slate-400 |

### Group headings
Plain text (14px semibold, nested 13px medium), no band; the colour is the heading's glyph: status ring, initiative or
epic chip, teal board icon. Rows of a group sit in one surface (`ROWS`: bg-card, hairline border, hairline dividers).

### Contrast (measured on bb, both themes)
Text pairs 4.5:1 or more, glyphs and chips 3:1 or more. Light-theme fixes applied: in-progress ring sky-600
(was sky-500, 2.7:1), done ring emerald-600 (was 2.5:1), High tag text orange-800 (was 4.4:1).

### Type
bb's sans, no custom face (the panel lives inside bb). 20px semibold ticket titles (`text-xl`), 14px medium
summaries (`text-sm font-medium`), 12px muted meta (`text-xs text-muted-foreground`), monospace only for
issue keys.

### Spacing (4px grid)
Rows 10px tall padding by 16px wide; 8px from a heading to its rows; 16px between nested groups; 24px between
groups and around the page.

### Shape and depth
16px cards and row surfaces (`rounded-2xl`), 12px panels and menu items (`rounded-xl`), 8px icon chips (`rounded-lg`),
6px priority tags (`rounded-md`), round pills, chips and controls (`rounded-full`). Hairline borders
(`border-border/60`). Flat surfaces; the selected row gets `bg-muted/60` and an inset `ring-1 ring-primary/40`;
menus `shadow-lg shadow-black/10`.

### Motion (`ENTER`, `EASE` in parts.tsx)
| Token | Value | Used for |
|---|---|---|
| fast | 120ms | hover tint, chevron nudge and rotation, segment background, chip state |
| enter | 200ms | ticket pane, menus, shortcut list, status pop, content appearing |
| ease | `cubic-bezier(0.2, 0, 0, 1)` | everything |
| pane slide | 8px from the right (`slide-in-from-right-2`) | ticket pane |
| menu drop | 4px (`slide-in-from-top-1`) | status menu, chip menus, shortcut list |
| pop | scale 1 → 1.06 → 1 | status pill after a change |

## Components
Ring, PriorityMark / PriorityCue, TypeChip, Crumb / Lineage, NodeTitle, Seg (neutral segmented control),
ChipFilter (quiet chips + menu), useMenu (Type, Group by and chip menus), Row (inbox ticket row), Section (plain
collapsible heading), StatusPill + MenuPanel (status change, full or ring-only), Empty, Problem, Warning, Tiles
(skeleton), Kbd. Every interactive one has hover, focus-visible ring, active and disabled states and a
pointer cursor.
