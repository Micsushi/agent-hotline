---
project: agent-hotline
version: "1.0"
detailed: false
colors:
  bg: "#060912"
  sidebar-1: "#0A0F1C"
  sidebar-2: "#111A2E"
  surface: "#18233D"
  border: "#25324E"
  border-strong: "#3A4D70"
  text: "#E6EAF2"
  text-dim: "#95A0B5"
  text-muted: "#5C6680"
  accent: "#004BA8"
  accent-hover: "#3E78B2"
  on-accent: "#FFFFFF"
  accent-soft: "rgba(0,75,168,0.22)"
  focus-ring: "rgba(62,120,178,0.35)"
  transport-enabled: "#4A525A"
  transport-disabled: "#24272B"
  shadow: "0 4px 14px rgba(0,0,0,0.35)"
  owner-codex: "#5a93cc"
  owner-codex-bg: "rgba(62,120,178,0.16)"
  owner-codex-border: "rgba(62,120,178,0.4)"
  owner-claude: "#f0a98a"
  owner-claude-bg: "rgba(217,119,87,0.16)"
  owner-claude-border: "rgba(217,119,87,0.4)"
  owner-antigravity: "#c9a2f7"
  owner-antigravity-bg: "rgba(168,85,247,0.16)"
  owner-antigravity-border: "rgba(168,85,247,0.4)"
  positive: "#5A9E65"
  negative: "#B84040"
  warning: "#C49A3C"
typography:
  fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif"
  body-sm: "13px / 1.45"
  label: "12px / 700 / 0.05em uppercase"
  mono: "JetBrains Mono, monospace"
layout:
  nav-width: "200px"
  col-width: "264px"
  col-head-height: "46px"
  bar-height: "104px"
  col-head-padding: "0 16px"
---

# agent-hotline Design

Cobalt navy-dark skin for the Agent Hotline desktop (Tauri/Vite).
This file is the project UI source of truth.

## Token Source

All CSS custom properties in `packages/desktop/src/styles.css` must match the YAML tokens above.
The `:root` block is the single source of truth in CSS; no raw hex outside it except owner badge colours (intentionally branded).

## Header Alignment Rule

All top-level panel headers must share the same height to form a continuous horizontal band:

- `.nav-brand` (leftmost, 200px nav rail)
- `.column-head` (Projects and Sessions columns)
- `.col-messages .column-head` (Messages/conversation pane)

Implementation: `--col-head-height: 46px`. Every header: `height: var(--col-head-height)` + `display: flex; align-items: center`.

## Colour Rules

- **Accent (primary)** = cobalt `#004BA8`, hover/highlight = rich cerulean `#3E78B2`. Use accent for: solid primary fills (play button, transport primary, unread dot/badge), active nav bg tint, selected item bg. Use cerulean (`accent-hover` / `focus-ring`) for: hover text, selection/unread outline rings, karaoke cursor — the brighter blue stays legible on the dark navy bg where cobalt would vanish. Palette family: cobalt `#004BA8`, rich-cerulean `#3E78B2`, iron-grey `#4A525A`, shadow-grey `#24272B`, black `#07070A`.
- **Surfaces**: bg < sidebar-1 < sidebar-2 < surface. Darker = further back. Never use a surface lighter than `surface` for raised elements.
- **Owner badges**: identity colours, NOT app accent. Codex=green, Claude=orange (distinct from accent), Antigravity=purple. Keep as-is.
- **Negative/error**: `#B84040` / text `#ff9db0`. Warning: `#C49A3C`.
- No raw hex outside `:root` except owner badge RGBA variants (approved).

## Component Notes

### Selected project row (`.tree-item.has-project-color.is-selected`)

- Border + bg tint: from `--project-color` (55% / 10% mix).
- Title text: also `--project-color` so text matches the box highlight. Falls back to `--accent-hover` when no project color.

### Column headers (`.column-head`)

- Height: `var(--col-head-height)` = 46px
- Padding: `0 16px`
- Font: 11px / 700 / uppercase / 0.05em tracking
- Color: `var(--text-dim)`
- Border-bottom: `1px solid var(--border)`

### Nav brand (`.nav-brand`)

- Height: `var(--col-head-height)` = 46px -- must match column-head exactly
- Padding: `0 16px`

### Playback bar (`.now-bar`)

- Background: `var(--sidebar-2)` not surface
- Grid: 3-column, center = controls card

### Owner-tinted message surfaces

Assistant bubbles, the now-bar preview, and the modal carry an inline `--owner-color` (from `ownerSolidColor(sourceApp)` in project-colors.js): Codex blue, Claude orange, Antigravity purple (rainbow→`#c084fc`), else grey. CSS uses it (falling back to `--accent`) for: assistant bubble fill (`--bubble-bg` = 28% owner over surface, tail inherits; reads deeper/muted vs the full-strength play+highlight), bubble play button fill, karaoke `.spoken-done` highlight, and the selected/unread bubble drop-shadow ring. So each message reads in its harness's colour.

### Bubble play button

- Background: `var(--owner-color, var(--accent))`, hover `filter: brightness(1.15)`
- Color: `var(--on-accent)` (#FFFFFF)

### Active nav item

- Background: `var(--accent-soft)` (cobalt tint)
- Border: `rgba(62,120,178,0.35)` (cerulean focus-ring)
- Color: `var(--accent-hover)`
