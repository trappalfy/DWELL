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
  const reveal = () => onceVisible(headings, 0.6, (heading) => heading.classList.add("is-visible"));

  if (still()) {
    reveal();
    return;
  }

  const arm = () => {
    for (const heading of headings) {
      const text = heading.querySelector(".term-text");
      // Measured, not counted in ch: the pixel faces are not guaranteed to be
      // monospaced, and a character count would end the animation in the
      // wrong place for any face that is not.
      if (text) heading.style.setProperty("--type-width", `${text.getBoundingClientRect().width}px`);
      // Marked only now: without JS the heading must stay fully written out.
      heading.classList.add("will-type");
    }
    reveal();
  };

  // Measuring before the faces land would size the animation to the fallback.
  const fonts = document.fonts;
  if (fonts && fonts.ready) fonts.ready.then(arm, arm);
  else arm();
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
