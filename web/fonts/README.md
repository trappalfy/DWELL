# Self-hosted faces

Two files belong here. Until they arrive the page falls back to Pixelify Sans
and Silkscreen from Google Fonts and stays correct — nothing breaks, it just
does not look like the intended design.

| File | Face | Role on the page | Source |
|---|---|---|---|
| `koganejidainogemu.ttf` | Koganejidainogemu | `--display`: wordmark, H1, big numbers, slide names, watermark | https://fonts-online.ru/fonts/koganejidainogemu |
| `pb-pixel.ttf` | PB Pixel | `--pixel`: navigation, buttons, terminal headings, labels | https://pixelbag.net/pb-pixel-font-free-download/ |

Both downloads sit behind a captcha or a JS form, so they have to be fetched
by hand. Extract the archive and drop the `.ttf` in here under exactly the
name above — `styles.css` refers to these paths.

## Before shipping either one

```bash
cd offchain && npm run fonts
```

That prints the copyright, licence and licence URL **out of the font file
itself**. Read it rather than trusting the download page: the sites that
carry these fonts also carry Apple's SF Pro and Emigre's Mrs Eaves, which
they are in no position to license to anyone.

Keep any `OFL.txt`, `LICENSE` or `COPYING` from the archive in this folder.
The Open Font Licence requires the licence to travel with the font, and a
GPL font requires the same.

## Why TrueType and not woff2

Both files are single-digit kilobytes, so the conversion would save almost
nothing and would put a build step into a project that deliberately has none.
`offchain/src/api/static.ts` serves `.ttf` with the right content type.
