# Visual design and assets

<p align="center"><img src="../design/brand/lockup-dark.png" alt="MALT" width="390" /></p>

MALT's identity is an upright ear of malt barley: sharp, pointed almond grains, each split into a light and a shaded amber facet, long tapering awns, and a teal stem. It's warm, crafted and recognizable, and as precise as a developer tool should be. The silhouette follows the original extension icon. The project artwork (README hero, diagrams, social card) shares one look: a charcoal background with a faint 40 px grid, monospace headlines with one teal accent, and diagrams of rounded, color-coded boxes with dashed boundaries, labeled arrows and a legend.

Keep the interface itself native to VS Code, so the user's theme, file icons, keyboard navigation and accessibility settings keep working. Brand colors belong to artwork, not to the editor UI.

## Palette

| Role | Color |
|---|---|
| Charcoal (background) | `#0E1217` artwork, `#121821` icon tile |
| Amber (grains, awns, workspace) | `#F2C66A` light facet, `#D9982F` shaded facet, `#E6B85C` awns and diagrams |
| Teal (stem, accent, extension) | `#2BB8A6` |
| Cream (wordmark on dark) | `#F7EFDA` |
| Ink (wordmark on light) | `#191D24` |
| Diagram categories | violet `#A78BFA` reviewer, orange `#F59E5B` model, green `#3FC98A` what you see, red `#F0646E` dropped or failed |

Review states in the editor use contributed theme colors, so light and high-contrast themes stay supported. Amber branding never replaces the green/red verdict colors.

## Assets

Every asset is hand-authored as SVG or HTML/CSS and is reviewable as text. No image generator is involved, so there's no garbled text and nothing to re-prompt.

| File | Use | Ships in the VSIX |
|---|---|---|
| `media/malt.svg` | Activity-bar icon: the mark in `currentColor`, so it follows the theme | Yes |
| `media/icon.png` | 256 px Marketplace and VSIX icon, rendered from `design/icon.html` | Yes |
| `design/brand/mark.svg` | The full-color mark (`mark.png`: 480 px export) | No |
| `design/brand/lockup-dark.svg`, `lockup-light.svg` | Mark and drawn wordmark for dark or light backgrounds (PNG exports beside them) | No |
| `design/hero.html` → `hero.png` | README and wiki header: the editor mock-up with MALT's real labels and hover layout | No |
| `design/pipeline.html` → `pipeline.png` | How a change is reviewed (README, architecture guide, wiki) | No |
| `design/trust.html` → `trust.png` | The prompt-injection trust boundary (`SECURITY.md`, wiki) | No |
| `design/social-preview.png` | 1280×640 GitHub social card, scaled and cropped from `hero.png` | No |

The wordmark is drawn as strokes, not set in a font, so it looks the same everywhere. The PNG exports exist because the VS Code Marketplace rejects SVG images in a README, and GitHub's social preview needs a raster image. How to re-render them is in [`design/README.md`](../design/README.md).

The diagrams describe real behavior. When the review pipeline or the trust boundary changes, update `pipeline.html` or `trust.html` in the same pull request, re-render, and check the wording against [architecture.md](architecture.md) and [SECURITY.md](../SECURITY.md).

The wiki (`images/`) and the project board link to copies of these PNGs. Refresh those copies when you re-render.

## Product icons

Use VS Code product icons for actions and review status: play/stop for lifecycle, checklist for standards, output for logs, key/trash for credentials, refresh for retries, pass/warning/error for verdicts, and disconnected for request errors. These icons are deliberately native and respond to product icon themes. Don't replace them with platform-dependent emoji.

Keep inline labels short; the hover owns the explanation. Use text with status icons so meaning survives monochrome display and assistive technology. Keep untrusted reviewer text escaped, including when changing hover layout. Only MALT's retry command is enabled in hover links.

All project assets are distributed under the repository's MIT license.
