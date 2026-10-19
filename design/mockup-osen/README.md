# Osen mockup — autumn style

To open it, double-click `index.html`. No build or server is needed. The page takes its colors, font families, font sizes, spacing and corner radii from the shared `brand/tokens.css` (the families are `--font-ui` and `--font-mono`). The IBM Plex Sans and JetBrains Mono files themselves load from Google Fonts; without a network the page falls back to system fonts.

This is a styling variant made in the style of Vesna (`seasons-ai/vesna`): flat surfaces, thin borders, monospace technical details. The screens and data are taken from `design/mockup`; that one is also on the osen tokens, and the pages of this folder use the same `brand/tokens.css` tokens.

How to carry the style into the app is described in `SPEC.md`. The logo in all sizes, the app icon, `tokens.css`, the `components-osen.css` layer, the theme switcher `theme.js` and the `OsenMark.tsx` component are in `brand/`. All logo variants on one sheet: `brand/preview.png`.

## Screens

| Screen | File |
|---|---|
| New discussion | `index.html` |
| Session setup | `setup.html` |
| Discussion — in progress | `session.html` |
| Result — consensus | `result.html` |
| History | `history.html` |
| Settings | `settings.html` |
| Mark, palette, states | `styleguide.html` |
| All five themes side by side | `themes.html` |

The screens are linked to each other. The demo path: `index.html` → a template card → `setup.html` → "Начать" (Start) → `session.html` → "К итогу" (To the result) → `result.html`, then the rail → "История" (History).

## Color rule

Warm (`leaf`) is what is happening now: "in progress", "thinking", the selected rail item, the primary button.
Cool (`rain`) is what has settled: "agrees", "consensus reached", the accepted version.
Color always comes with an icon and a label.

## The osen palette (dark, the default)

| Token | Color | Purpose |
|---|---|---|
| bg | `#17130F` | window background |
| panel | `#211B16` | cards, input fields |
| rule | `#2E261F` | dividers, borders |
| text | `#EDE4D8` | main text |
| muted | `#8E8273` | captions, secondary text |
| faint | `#5C5146` | decorative marks |
| leaf | `#EE9A62` | alive: in progress, thinking, active |
| rain | `#9EBFD3` | settled: consensus, accepted |
| ok | `#A7CC96` | check passed |
| warn | `#E8C66E` | no consensus, dropped out |
| error | `#EC8A7A` | objects, failure |

## Themes

One dark theme and four light ones:

| id | Name | Character |
|---|---|---|
| `osen` | Осень | dark, the default |
| `tuman` | Туман | warm paper; the default light theme |
| `len` | Лён | neutral, near white; highest contrast |
| `inei` | Иней | cool blue-grey |
| `pergament` | Пергамент | soft sepia; for long reading |

Switch them in `settings.html` → «Оформление»: the mode (dark / light / match system) and the light theme. The choice is remembered in the browser and applies to every page of the mockup. To open a page in a given theme right away: `session.html#theme=len` (also `osen`, `tuman`, `inei`, `pergament`).

The themes live in `brand/tokens.css` as `[data-theme="…"]` blocks; `brand/theme.js` sets the attribute on `<html>`. Values, contrast and how to wire it into the app: `SPEC.md`, section 12.

## What is not here

The template editor and the intermediate screen states (`#owner-question`, `#resume`, `#cap` and the others from `design/mockup`) have not been redrawn yet.
