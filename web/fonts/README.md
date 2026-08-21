# Self-hosted faces

Both files are in place and verified. `npm run fonts` re-reads the licence
out of each file's own `name` table — worth doing again if either is ever
replaced, because the sites that carry these fonts also carry other people's
commercial typefaces and their licence claims are not evidence.

| File | Face | Licence, as stated inside the file | Role |
|---|---|---|---|
| `koganejidainogemu.ttf` | Koganejidainogemu, CoolGameXYZ 2020 | Public domain / GNU GPL | `--display` |
| `pb-pixel.ttf` | PB Pixel, Pixelbag 2026 | SIL Open Font License 1.1 | `--pixel` |

## The 32-pixel grid

Koganejidainogemu has a units-per-em of **32**: it is a real bitmap face drawn
on a 32-pixel grid, not an outline face that happens to look blocky. It is
crisp only at whole multiples of that grid and soft everywhere between.

Every size it sets is therefore a step on a 16-pixel scale — 16 / 32 / 48 /
64 / 96 / 128 — and none of them use `clamp()`. **Do not make the display
type fluid again.** A fluid size lands between steps at nearly every viewport
width, which is what made the large type look mushy in the first place.

PB Pixel has a normal units-per-em of 1000 and is free of that constraint.

## Which face does what, and why

Koganejidainogemu is monospaced; PB Pixel is not. That is why the terminal
headings (`$ cat HEARTBEAT.log`) use the display face rather than the label
face: a shell prompt whose columns do not line up is not a shell prompt.

## Known cost

Koganejidainogemu is 161 KB for 1165 glyphs, most of them Cyrillic and unused
on an English-only page. Subsetting it to Latin would cut it to a few
kilobytes, but that needs a font tool and therefore a build step, which this
project does not have. Worth revisiting if page weight ever matters.

## Why TrueType and not woff2

Converting would save little and would put a build step into a project that
deliberately has none. `offchain/src/api/static.ts` serves `.ttf` with the
right content type.
