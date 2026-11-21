const DURATION = 480;
const TICK = 40;
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const pick = (set: string) => set[Math.floor(Math.random() * set.length)];

function shuffled(char: string): string {
  if (char.toLowerCase() === char.toUpperCase()) return char;

  return char === char.toLowerCase() ? pick(LOWER) : pick(UPPER);
}

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
        if (!line.node.isConnected || line.node.nodeValue !== line.shown) continue;

        line.shown = elapsed >= DURATION ? line.text : Array.from(line.text, (char, i) => (elapsed >= line.at[i] ? char : shuffled(char))).join("");
        line.node.nodeValue = line.shown;
      }
    }

    if (elapsed < DURATION) requestAnimationFrame(frame);
  }

  frame(start);
}
