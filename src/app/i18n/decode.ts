const DURATION = 480;
const TICK = 40;
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const pick = (set: string) => set[Math.floor(Math.random() * set.length)];

function shuffled(char: string): string {
  if (char.toLowerCase() === char.toUpperCase()) return char;

  return char === char.toLowerCase() ? pick(LOWER) : pick(UPPER);
}

type Line = { read: () => string | null; write: (value: string) => void; connected: () => boolean; text: string; shown: string; at: number[] };

const timings = (text: string) => Array.from(text, (_, i) => DURATION * (0.15 + 0.85 * ((i / text.length) * 0.65 + Math.random() * 0.35)));

function onScreen(element: Element): boolean {
  if (!element.checkVisibility()) return false;

  const box = element.getBoundingClientRect();

  return box.bottom >= 0 && box.top <= innerHeight;
}

export function decode(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lines: Line[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const parent = node.parentElement;

    if (!(node instanceof Text) || !text.trim() || !parent || parent.closest("script, style, .sr-only, header a")) continue;

    if (!onScreen(parent)) continue;

    lines.push({
      read: () => node.nodeValue,
      write: (value) => {
        node.nodeValue = value;
      },
      connected: () => node.isConnected,
      text,
      shown: text,
      at: timings(text),
    });
  }

  for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[placeholder], textarea[placeholder]")) {
    const text = field.placeholder;

    if (!text.trim() || !onScreen(field)) continue;

    lines.push({
      read: () => field.placeholder,
      write: (value) => {
        field.placeholder = value;
      },
      connected: () => field.isConnected,
      text,
      shown: text,
      at: timings(text),
    });
  }

  const start = performance.now();
  let last = -TICK;

  function frame(now: number) {
    const elapsed = now - start;

    if (elapsed - last >= TICK || elapsed >= DURATION) {
      last = elapsed;

      for (const line of lines) {
        if (!line.connected() || line.read() !== line.shown) continue;

        line.shown = elapsed >= DURATION ? line.text : Array.from(line.text, (char, i) => (elapsed >= line.at[i] ? char : shuffled(char))).join("");
        line.write(line.shown);
      }
    }

    if (elapsed < DURATION) requestAnimationFrame(frame);
  }

  frame(start);
}
