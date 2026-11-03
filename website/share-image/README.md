# Share images

Sources for the two link-preview images. This folder isn't deployed (Vercel serves `website/static`).

| File | Size | Used as |
|---|---|---|
| `og.html` | 1200×630 | `website/static/img/og-image.png`, the `og:image` of every page |
| `gh.html` | 1280×640 | `.github/social-preview.png`, uploaded by hand in the repo's Settings → Social preview |

They use the site's colors and fonts (from Google Fonts, so render while online) and the app icon from `../static/img/logo.svg`. Keep version numbers, download counts and privacy claims off them: the old image said "v0.3.4" for months.

To re-render on a Mac, from this folder:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=8000 \
  --window-size=1200,630 --screenshot="$PWD/../static/img/og-image.png" "file://$PWD/og.html"
"$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=8000 \
  --window-size=1280,640 --screenshot="$PWD/../../.github/social-preview.png" "file://$PWD/gh.html"
```

Chrome writes PNGs of a little over 200 KB, which every platform accepts. Avoid squeezing them to a 256-color palette: that turns the small butter and plum dots grey.
