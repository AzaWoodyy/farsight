const DURATION = 480;
const TICK = 40;
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const pick = (set: string) => set[Math.floor(Math.random() * set.length)];

/** A letter becomes another letter of the same case. Spaces, punctuation and figures stay: a year is data. */
function shuffled(char: string): string {
  if (char.toLowerCase() === char.toUpperCase()) return char;

  return char === char.toLowerCase() ? pick(LOWER) : pick(UPPER);
}

/**
 * Every text on screen starts as shuffled letters and settles left to right into what it says. The page is set
 * in a monospace font, so a shuffled line is exactly as wide as the real one and nothing moves. The links of
 * the header (the site name, the language switch) are left alone: they are what the visitor is looking at.
 */
export function decode(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lines: { node: Text; text: string; shown: string; at: number[] }[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const parent = node.parentElement;

    if (!(node instanceof Text) || !text.trim() || !parent || parent.closest("script, style, .sr-only, header a")) continue;

    if (!parent.checkVisibility()) continue;

    const box = parent.getBoundingClientRect();

    if (box.bottom < 0 || box.top > innerHeight) continue;

    // Each character settles at its own time: mostly its place in the line, a little chance.
    const at = Array.from(text, (_, i) => DURATION * (0.15 + 0.85 * ((i / text.length) * 0.65 + Math.random() * 0.35)));

    lines.push({ node, text, shown: text, at });
  }

  const start = performance.now();
  let last = -TICK;

  function frame(now: number) {
    const elapsed = now - start;

    if (elapsed - last >= TICK || elapsed >= DURATION) {
      last = elapsed;

      for (const line of lines) {
        // React wrote something else in the meantime (an example rotated): the text is its own again.
        if (!line.node.isConnected || line.node.nodeValue !== line.shown) continue;

        line.shown = elapsed >= DURATION ? line.text : Array.from(line.text, (char, i) => (elapsed >= line.at[i] ? char : shuffled(char))).join("");
        line.node.nodeValue = line.shown;
      }
    }

    if (elapsed < DURATION) requestAnimationFrame(frame);
  }

  frame(start);
}
