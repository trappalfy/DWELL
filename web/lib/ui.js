/**
 * Page behaviour that has nothing to do with the protocol: reveals, the
 * typing headings, the accordion, the two things you can page through.
 *
 * Everything here starts from markup that already works. The headings are
 * readable before JS arms them, the accordion's answers are real <dd>
 * elements, and the first slide's copy is in the HTML — script only takes
 * over presentation, it never supplies the content.
 */

const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Fires once per element and then forgets it; nothing re-animates on the way back up. */
function onceVisible(elements, threshold, apply) {
  if (!("IntersectionObserver" in window)) {
    elements.forEach(apply);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        apply(entry.target);
        observer.unobserve(entry.target);
      }
    },
    { threshold }
  );

  elements.forEach((element) => observer.observe(element));
}

export function armReveals() {
  const targets = [...document.querySelectorAll(".section, .countdown")];
  if (!still()) targets.forEach((element) => element.classList.add("reveal"));
  onceVisible(targets, 0.2, (element) => element.classList.add("is-visible"));
}

export function armTypewriters() {
  const headings = [...document.querySelectorAll(".term")];
  // Marked only now: without JS the heading must stay fully written out.
  if (!still()) headings.forEach((heading) => heading.classList.add("will-type"));
  onceVisible(headings, 0.6, (heading) => heading.classList.add("is-visible"));
}

export function wireAccordion(list) {
  if (!list) return;

  for (const button of list.querySelectorAll("button[aria-controls]")) {
    button.addEventListener("click", () => {
      const answer = document.getElementById(button.getAttribute("aria-controls"));
      if (!answer) return;

      const open = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!open));
      answer.hidden = open;

      const sign = button.querySelector(".sign");
      if (sign) sign.textContent = open ? "+" : "−";
    });
  }
}

const SLIDES = [
  {
    name: "HOLD",
    text:
      "Your wallet balance is the whole rig. Keep 100,000 $DWELL and the protocol counts " +
      "you in. It reads your balance and can never move it: no deposit, no lockup, no " +
      "withdrawal queue."
  },
  {
    name: "TEND",
    text:
      "Every ten seconds this page tells the hearth you are still here. Hide the tab and " +
      "it stops at once. Presence is the work; there is nothing else to do."
  },
  {
    name: "BURN",
    text:
      "Every five minutes the reserve releases a slice of itself and splits it among " +
      "everyone present, weighted by balance. Nobody present, nothing burned — the " +
      "reserve waits."
  },
  {
    name: "CLAIM",
    text:
      "Your total is written into a Merkle root on-chain every half hour. One claim " +
      "collects everything you have ever earned. Nothing expires."
  }
];

export function wireCarousel(carousel) {
  if (!carousel) return;

  const copy = carousel.querySelector(".slide-copy");
  const name = carousel.querySelector(".slide-name");
  const text = carousel.querySelector(".slide-text");
  const thumbs = [...carousel.querySelectorAll(".thumb")];
  let index = 0;

  function show(next) {
    const target = (next + SLIDES.length) % SLIDES.length;
    if (target === index) return;
    index = target;

    carousel.dataset.slide = String(index);
    thumbs.forEach((thumb, i) => thumb.classList.toggle("is-active", i === index));

    // Out, swap, back in — the copy slides rather than popping.
    const swap = () => {
      name.textContent = SLIDES[index].name;
      text.textContent = SLIDES[index].text;
      copy.classList.remove("is-turning");
    };

    if (still()) {
      swap();
      return;
    }
    copy.classList.add("is-turning");
    setTimeout(swap, 220);
  }

  for (const chevron of carousel.querySelectorAll(".chev[data-step]")) {
    chevron.addEventListener("click", () => show(index + Number(chevron.dataset.step)));
  }
  thumbs.forEach((thumb, i) => thumb.addEventListener("click", () => show(i)));

  // Arrow keys work once the section has focus, as they would in any gallery.
  carousel.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") show(index + 1);
    if (event.key === "ArrowLeft") show(index - 1);
  });
}

export function wireTimeline(section) {
  const track = section?.querySelector(".track");
  if (!track) return;

  for (const [selector, direction] of [
    [".chev-left", -1],
    [".chev-right", 1]
  ]) {
    section.querySelector(selector)?.addEventListener("click", () => {
      track.scrollBy({ left: direction * track.clientWidth * 0.6, behavior: still() ? "auto" : "smooth" });
    });
  }
}
