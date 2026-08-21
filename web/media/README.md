# Background video

Drop the loop here and restart the process. Nothing else is needed — the
server finds the file at boot, tells the page about it through `/v1/config`,
and the page switches its background from the drawn sky to the video.

| File | Purpose |
|---|---|
| `backdrop.webm` | preferred encoding |
| `backdrop.mp4` | fallback, and what Safari and iOS actually play |
| `backdrop-poster.webp` or `.png` | first frame, shown while the video loads |

Ship **both** encodings. WebM compresses a dark, slow loop better, but
Safari's support for it is patchy and unreliable on iOS, so an MP4 alongside
is the difference between the backdrop appearing everywhere and appearing on
most browsers. The page lists both and lets the browser choose.

Without any of these files the page keeps its own gradient, drifting stars and
parallax clouds. That is a working state, not a broken one.

## What the page does with it

- Pauses the video the moment the tab is hidden, and resumes on return. This
  matters more here than anywhere else: the protocol is built on a hidden tab
  counting for nothing, and video decode is the heaviest thing on the page.
- Shows the poster and never starts the decoder under `prefers-reduced-motion`.
- Falls back to the drawn sky if the file is broken or autoplay is refused, so
  a failure is never a black screen.

## Encoding notes

The loop has to be seamless — last frame flowing into the first — because
nothing on our side can hide a jump.

Keep it dark and low-contrast. Every word on the page sits on top of this, and
the palette gives text only `--linen` and `--haze` to work with.

Watch the file size. It is fetched once per visitor and then loops from
memory, so this is a one-time cost rather than a per-loop one, but it is still
by far the largest thing the page serves. Ten seconds at 1280×720 in VP9
should land in the low megabytes; if it is much more than that, the bitrate is
higher than a dark ambient loop needs.

If the source is pixel art, encode at its native resolution and let CSS scale
it up — video codecs blur hard pixel edges, and a small native frame scaled by
the browser stays sharper than a large blurred one.

## Serving

`offchain/src/api/static.ts` marks `.mp4` and `.webm` as seekable, and the
router answers byte-range requests with `206` and streams the body instead of
buffering it. Both are required: **Safari refuses to play a `<video>` whose
server does not support ranges**, and buffering would put a copy of the file
in memory for every visitor at once. `offchain/test/media.test.ts` covers it.
