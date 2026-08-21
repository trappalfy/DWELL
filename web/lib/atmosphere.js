/**
 * The night above the page and the sparks inside it.
 *
 * One canvas holds both: stars while you are outside the dwelling, embers
 * rising once you have scrolled in, cross-faded by how far down the page you
 * are. They are the same field seen from two sides of a wall, which is why
 * they share a loop instead of being two effects.
 *
 * The loop stops dead when the tab is hidden. That matters more here than on
 * an ordinary page: the entire protocol is built on a hidden tab counting for
 * nothing, and a page that keeps burning CPU while nobody is looking would be
 * lying about its own premise.
 */

const STAR_COUNT = 190;
const SPARK_COUNT = 70;

/** Where the two populations trade places, as a share of total scroll. */
const STARS_FADE = [0.28, 0.54];
const SPARKS_FADE = [0.44, 0.68];

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 0 before `from`, 1 after `to`, straight line between. */
function ramp(value, [from, to]) {
  return clamp01((value - from) / (to - from));
}

function ink(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function startAtmosphere({ canvas, bands = [] }) {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;

  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const colours = {
    haze: ink("--haze", "#9C94BA"),
    dusk: ink("--dusk", "#4A4266"),
    ember: ink("--ember", "#FF7A34"),
    flame: ink("--flame", "#FFC24A")
  };

  let width = 0;
  let height = 0;
  let stars = [];
  const sparks = [];

  /**
   * A deterministic field: the same window size always yields the same sky, so
   * a resize does not reshuffle every star the reader had just settled into.
   */
  function seedStars() {
    let seed = 0x5eed;
    const next = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x100000000;
    };

    stars = Array.from({ length: STAR_COUNT }, () => ({
      x: next() * width,
      // Taller than the viewport, so parallax has somewhere to travel.
      y: next() * height * 1.6,
      size: next() > 0.86 ? 3 : next() > 0.5 ? 2 : 1,
      base: 0.25 + next() * 0.6,
      // Only a minority twinkle; a whole sky of it reads as static.
      blinks: next() > 0.85,
      phase: next() * Math.PI * 2,
      rate: 0.4 + next() * 0.9
    }));
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    seedStars();
  }

  function spawnSpark() {
    return {
      x: Math.random() * width,
      y: height + Math.random() * 60,
      rise: 0.25 + Math.random() * 0.7,
      drift: (Math.random() - 0.5) * 0.35,
      life: 0,
      span: 260 + Math.random() * 420,
      size: Math.random() > 0.75 ? 3 : 2,
      hot: Math.random() > 0.55
    };
  }

  function scrollProgress() {
    const travel = document.documentElement.scrollHeight - window.innerHeight;
    return travel > 0 ? clamp01(window.scrollY / travel) : 0;
  }

  function drawStars(alpha, offset, time) {
    if (alpha <= 0.01) return;
    const field = height * 1.6;

    for (const star of stars) {
      let y = star.y - offset;
      // Wrap through the field so the sky never runs out on a long page.
      y = ((y % field) + field) % field;
      if (y > height) continue;

      const twinkle = star.blinks && !still ? 0.55 + 0.45 * Math.sin(time * star.rate + star.phase) : 1;
      context.globalAlpha = alpha * star.base * twinkle;
      context.fillStyle = star.size > 1 ? colours.haze : colours.dusk;
      context.fillRect(Math.round(star.x), Math.round(y), star.size, star.size);
    }
  }

  function drawSparks(alpha, delta) {
    if (alpha <= 0.01) {
      // Nothing visible, so nothing is simulated: the cost of the section you
      // are not looking at is zero.
      sparks.length = 0;
      return;
    }

    while (sparks.length < SPARK_COUNT) sparks.push(spawnSpark());

    for (let i = sparks.length - 1; i >= 0; i--) {
      const spark = sparks[i];
      if (!still) {
        spark.life += delta;
        spark.y -= spark.rise * delta * 0.06;
        spark.x += spark.drift * delta * 0.06;
      }

      const age = still ? 0.4 : spark.life / spark.span;
      if (age >= 1 || spark.y < -10) {
        sparks[i] = spawnSpark();
        continue;
      }

      // Bright at once, then fading as it climbs — an ember cooling, not a dot.
      context.globalAlpha = alpha * (1 - age) * 0.85;
      context.fillStyle = spark.hot ? colours.flame : colours.ember;
      context.fillRect(Math.round(spark.x), Math.round(spark.y), spark.size, spark.size);
    }
  }

  function moveBands(offset, fade) {
    for (const { element, rate } of bands) {
      element.style.transform = `translate3d(${-(offset * rate * 0.35).toFixed(1)}px, ${(-offset * rate).toFixed(1)}px, 0)`;
      element.style.opacity = String(fade);
    }
  }

  let previous = performance.now();
  let running = false;

  function frame(now) {
    if (!running) return;
    const delta = Math.min(now - previous, 64);
    previous = now;

    context.clearRect(0, 0, width, height);

    const progress = scrollProgress();
    const starAlpha = 1 - ramp(progress, STARS_FADE);
    const sparkAlpha = ramp(progress, SPARKS_FADE);

    drawStars(starAlpha, window.scrollY * 0.15, now / 1000);
    drawSparks(sparkAlpha, delta);
    context.globalAlpha = 1;

    moveBands(window.scrollY, starAlpha * 0.9);

    requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    previous = performance.now();
    requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
  }

  resize();
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") start();
    else stop();
  });

  if (document.visibilityState === "visible") start();
}
