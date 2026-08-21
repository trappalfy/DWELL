# Self-hosted faces

Two pixel faces, self-hosted. `npm run fonts` reads the licence and metrics
out of each file's own tables — worth running again if either is ever
replaced, because the sites that carry these faces also carry other people's
commercial typefaces and their licence claims are not evidence.

| File | Face | Licence, as stated inside the file | Role |
|---|---|---|---|
| `akedopikuseru.otf` | Akedopikuseru, CoolGameXYZ | Public domain / GNU GPL | `--display` |
| `pb-pixel.ttf` | PB Pixel, Pixelbag 2026 | SIL Open Font License 1.1 | `--pixel` |

Karla comes from Google Fonts and sets everything that is read rather than
labelled. That is the whole type system: **neither pixel face ever sets
running prose.** Both are drawn at one size and come apart in a paragraph.

## Which face does what, and why

`--display` carries the project's own name and its biggest numbers — the
wordmark, the hero title, the footer watermark, the countdown digits, the
fund figures. `--pixel` labels everything smaller around them — nav links,
the connect button, unit labels, the tagline.

Akedopikuseru is also the only monospaced one of the two, which is why the
terminal headings (`.term`, `$ cat HEARTBEAT.log`) and the timeline dates
(`.node-at`) stay on `--display` rather than moving to the smaller `--pixel`
face with the rest of the labels: a shell prompt whose columns do not line up
is not a shell prompt. That is a real constraint, not a size choice — do not
move `.term` or `.node-at` to `--pixel` even if a design pass wants them
smaller.

## The seven-pixel grid — `--display` only

Akedopikuseru is an arcade face drawn in an eight-by-eight cell. The letters
fill seven pixels and the eighth is the gap between them. Its em is those
seven pixels, so:

| | |
|---|---|
| one drawn pixel | 128 units = **1/7 em** |
| cap height | 896 = **exactly 1 em** |
| x-height | 640 = 5 drawn pixels |
| advance | 1024 = 8 drawn pixels, **every glyph** |

Three rules follow for anything set in `--display`, and all three are
load-bearing.

**Font sizes are multiples of 7.** The scale in use is 14 / 21 / 28 / 35 /
42 / 63 / 84. Anything else puts a drawn pixel on a fraction of a screen
pixel and the whole face goes soft. **Do not make it fluid** — a `clamp()`
lands between steps at nearly every viewport width, which is exactly the
mistake that made the large type look mushy before this face.

**Letter-spacing is 0 or a multiple of `--px-gap`** (1/7 em). The cell
already carries its pixel of gap; arbitrary tracking pushes every letter
after the first off the grid.

**Line heights are 8/7 and 10/7** — `--lh-pixel` and `--lh-label`. Because
the size is a multiple of 7, both land on a whole number of pixels every
time.

`npm run fonts` derives this grid from the file and prints it, so the rule
above is checked against the actual font rather than trusted from memory.
`offchain/test/typography.test.ts` enforces it on every `--display` rule in
`styles.css`.

PB Pixel carries no equivalent constraint. It is an ordinary proportional
OFL face — `npm run fonts` reports a coincidental common divisor across its
round metrics (em 1000, advance 350), but that is an artefact of the numbers
being round, not a drawn pixel grid the way Akedopikuseru's is. Its sizes on
the page (17, 19, 20, 22, 24, 28) do not follow fixed steps and do not need
to.

## Cap height is the whole em, which is unusual

Most faces put the cap at about 0.7 em. Akedopikuseru puts it at 1.0. A
heading set at 84px has 84px capitals, where a normal face at 84px would have
about 59px. **Sizes from this face are not comparable to sizes from any
other** — compare cap heights instead. That is how the page was converted
from its Koganejidainogemu-based predecessor without the layout moving:
128px of that face and 84px of this one are the same 84px of capital.

## Centring — `--display` only

Every cell trails one drawn pixel of gap, including the last one on a line,
so a centred line always sits half a pixel-gap left of true centre — six
pixels on the headline, plainly visible. `.title-last` and `.watermark b`
cancel it with `margin-right: calc(var(--px-gap) * -1)`. Anything large and
centred set in `--display` needs the same treatment; below about 21px it is
not worth it. PB Pixel centres the way any ordinary face does and needs none
of this.

## Why the Akedopikuseru @font-face carries metric overrides

The file states its vertical metrics twice and the two disagree by 200
units: `hhea` says the descender is 440 units, `OS/2` says 128. Browsers
pick between them by platform, so the baseline — and every line box built
around it — would land differently on Windows and macOS. `ascent-override`,
`descent-override` and `line-gap-override` settle it at 100% / 14.2857% / 0%,
which is what the glyphs actually do. Without them the grid holds
horizontally and drifts vertically. PB Pixel's metrics agree with themselves
and need no override.

## Known cost

Akedopikuseru is 159 KB for 769 glyphs, most of them Cyrillic and Latin
Extended and unused on an English page. Subsetting to Latin would cut it to
a few kilobytes but needs a font tool and therefore a build step, which this
project does not have. PB Pixel is 9.4 KB. The page head preloads both files
so the swap happens early. Worth revisiting the subsetting if page weight
ever matters.

## Why these formats and not woff2

Converting would save some weight on Akedopikuseru and almost nothing on the
already-small PB Pixel, and either way would put a build step into a project
that deliberately has none. `offchain/src/api/static.ts` serves `.otf` and
`.ttf` with the right content types.
