# Design sources

Sources and exports for MALT's artwork. The palette, the rules and the asset list are in [docs/design.md](../docs/design.md). This folder is not packaged into the extension; only `media/malt.svg` and `media/icon.png` ship.

| Source | Export | Size |
|---|---|---|
| `brand/mark.svg` | `brand/mark.png` | 480×480 |
| `brand/lockup-dark.svg`, `brand/lockup-light.svg` | `brand/lockup-dark.png`, `brand/lockup-light.png` | 780×240 |
| `hero.html` | `hero.png` | 1600×900 |
| `pipeline.html` | `pipeline.png` | 1600×820 |
| `trust.html` | `trust.png` | 1600×820 |
| `icon.html` | `../media/icon.png` | 256×256, transparent corners |
| `hero.png` | `social-preview.png` | 1280×640: scale to 1280×720, keep the middle 640 rows |

## Rendering

Open a source in Chrome to preview it. To export at exactly the listed size, use headless Chrome from this folder. A fresh profile directory avoids clashing with your running browser:

```sh
chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --user-data-dir="$(mktemp -d)" --default-background-color=00000000 \
  --window-size=1600,900 --screenshot=hero.png hero.html
```

For an SVG, render a tiny page that shows it as `<img>` at the listed size. Fonts come from your system: the sources ask for Cascadia Code and Segoe UI, with JetBrains Mono, Consolas and system fonts as fallbacks. Check the export by eye before committing, because a fallback font changes line lengths.

After re-rendering, copy the changed PNGs to the wiki's `images/` folder, and update the GitHub social preview (Settings → General) if the hero changed.
