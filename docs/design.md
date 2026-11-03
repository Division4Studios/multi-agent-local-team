# Visual design and assets

MALT's identity is an upright ear of malt barley: warm, crafted and recognizable, with a precise silhouette suited to a developer tool. The banner and extension icon use amber grains on charcoal; the activity bar uses a simplified monochrome sprig. Keep the interface native to VS Code so the user's theme, file icons, keyboard navigation and accessibility settings continue to work.

| Asset | Use |
| --- | --- |
| `media/malt.svg` | Simplified monochrome 24 px barley activity-bar mark, using `currentColor` |
| `media/barley.svg` | Editable gold vector companion for documentation and small-scale use |
| `media/icon.png` | Generated square barley icon for VSIX/Marketplace metadata |
| `media/banner.png` | Generated repository header with MALT wordmark and tagline |

Brand colors: charcoal `#191D24`, amber `#E6B85C`, cream `#F7EFDA`. Brand colors belong to identity assets. Review states use contributed theme colors, so light and high-contrast themes remain supported. Amber branding does not replace the green/amber/red verdict system.

Use VS Code product icons for actions and review status: play/stop for lifecycle, checklist for standards, output for logs, key/trash for credentials, refresh for retries, pass/warning/error for verdicts, and disconnected for request errors. These icons are deliberately native and respond to product icon themes. Do not replace them with platform-dependent emoji.

Keep inline labels short; the hover owns the explanation. Use text with status icons so meaning survives monochrome display and assistive technology. Keep untrusted reviewer text escaped, including when changing hover layout. Only MALT's retry command is enabled in hover links.

The PNG banner and icon were created with the built-in image-generation tool; prompts are recorded in [asset prompts](asset-prompts.md). The SVG companions are hand-authored simplified adaptations, not exact vector traces of the raster art. Keep fine facets and texture in large artwork; preserve the bolder silhouette for the activity bar. Use `currentColor` for all monochrome UI branding. All project assets in this directory are distributed under the repository's MIT license.
