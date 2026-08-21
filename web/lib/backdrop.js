/**
 * The optional video backdrop.
 *
 * Two rules shape everything here.
 *
 * It must never be the only thing holding the page up: if the file is absent,
 * broken, or refused by the browser's autoplay policy, the drawn sky takes
 * over and nothing about the page looks unfinished.
 *
 * And it must stop when the tab is hidden. That matters more on this page
 * than on any other: the whole protocol is built on a hidden tab counting for
 * nothing, and video decode is the heaviest thing here by a wide margin. A
 * page that asks to be left open for hours has no business spinning a decoder
 * while nobody is looking at it.
 */

const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * @returns true when the video took over the background, false when the
 *          caller should start the drawn sky instead.
 */
export function startBackdrop({ video, config, onGiveUp }) {
  const sources = config?.backdrop?.sources ?? [];
  if (!video || sources.length === 0) return false;

  if (config.backdrop.poster) video.poster = config.backdrop.poster;

  for (const source of sources) {
    const element = document.createElement("source");
    element.src = source.src;
    element.type = source.type;
    video.appendChild(element);
  }

  let handedOver = false;
  const giveUp = () => {
    if (handedOver) return;
    handedOver = true;
    document.documentElement.removeAttribute("data-backdrop");
    onGiveUp();
  };

  // An <source> that fails errors on the element only once every candidate
  // has been tried, which is exactly the moment to fall back.
  video.addEventListener("error", giveUp);
  video.addEventListener("stalled", giveUp);

  document.documentElement.dataset.backdrop = "video";
  video.load();

  // Reduced motion keeps the poster frame and never starts the decoder.
  if (still()) return true;

  const play = () => {
    // Autoplay can be refused outright; muted playback usually is not, but a
    // refusal must not leave a frozen first frame as the whole background.
    const started = video.play();
    if (started && typeof started.catch === "function") started.catch(giveUp);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") play();
    else video.pause();
  });

  if (document.visibilityState === "visible") play();
  return true;
}
