# Self-hosted faces

One pixel face, self-hosted. `npm run fonts` reads the licence and the grid
out of the file's own tables — worth running again if it is ever replaced,
because the sites that carry these faces also carry other people's commercial
typefaces and their licence claims are not evidence.

| File | Face | Licence, as stated inside the file | Role |
|---|---|---|---|
| `akedopikuseru.otf` | Akedopikuseru, CoolGameXYZ | Public domain / GNU GPL | `--pixel` |

Karla comes from Google Fonts and sets everything that is read rather than
labelled. That split is the whole type system: **the pixel face never sets
running prose.** It is drawn at one size and comes apart in a paragraph.

## The seven-pixel grid

Akedopikuseru is an arcade face drawn in an eight-by-eight cell. The letters
fill seven pixels and the eighth is the gap between them. Its em is those
seven pixels, so:

| | |
|---|---|
| one drawn pixel | 128 units = **1/7 em** |
| cap height | 896 = **exactly 1 em** |
| x-height | 640 = 5 drawn pixels |
| advance | 1024 = 8 drawn pixels, **every glyph** |

Three rules follow, and all three are load-bearing.

**Font sizes are multiples of 7.** The scale is 14 / 21 / 28 / 35 / 42 / 63 /
84. Anything else puts a drawn pixel on a fraction of a screen pixel and the
whole face goes soft. **Do not make the type fluid** — a `clamp()` lands
between steps at nearly every viewport width, which is exactly the mistake
that made the large type look mushy the first time round.

**Letter-spacing is 0 or a multiple of `--px-gap`** (1/7 em). The cell already
carries its pixel of gap; arbitrary tracking pushes every letter after the
first off the grid.

**Line heights are 8/7 and 10/7** — `--lh-pixel` and `--lh-label`. Because the
size is a multiple of 7, both land on a whole number of pixels every time.

## Cap height is the whole em, which is unusual

Most faces put the cap at about 0.7 em. This one puts it at 1.0. A heading set
at 84px here has 84px capitals, where a normal face at 84px would have about
59px. **Sizes from this face are not comparable to sizes from any other** —
compare cap heights instead. That is how the page was converted off its
predecessor without the layout moving: 128px of the old face and 84px of this
one are the same 84px of capital.

## Centring

Every cell trails one drawn pixel of gap, including the last one on a line, so
a centred line always sits half a pixel-gap left of true centre — six pixels
on the headline, plainly visible. `.title-last` and `.watermark b` cancel it
with `margin-right: calc(var(--px-gap) * -1)`. Anything large and centred set
in this face needs the same treatment; below about 21px it is not worth it.

## Why the @font-face carries metric overrides

The file states its vertical metrics twice and the two disagree by 200 units:
`hhea` says the descender is 440 units, `OS/2` says 128. Browsers pick between
them by platform, so the baseline — and every line box built around it — would
land differently on Windows and macOS. `ascent-override`, `descent-override`
and `line-gap-override` settle it at 100% / 14.2857% / 0%, which is what the
glyphs actually do. Without them the grid holds horizontally and drifts
vertically.

## Known cost

159 KB for 769 glyphs, most of them Cyrillic and Latin Extended and unused on
an English page. Subsetting to Latin would cut it to a few kilobytes but needs
a font tool and therefore a build step, which this project does not have. The
page head preloads the file so the swap happens early. Worth revisiting if
page weight ever matters.

## Why OpenType and not woff2

Converting would save perhaps a third and would put a build step into a
project that deliberately has none. `offchain/src/api/static.ts` serves `.otf`
with the right content type.
