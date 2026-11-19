import { QUESTION_MAX_LENGTH } from "@/lib/agent/types";

/**
 * The link to an answer: the question on screen is the `q` of the home page's address (`/?q=…`, `/en?q=…`).
 * The console reads and writes the address in the browser only, and a link runs its question through the same
 * POST /api/ask as a typed one (BotID, rate limit, length limit). The server reads `q` once, when a link is
 * opened: for the metadata of its preview (answer-metadata), computed without the model.
 */
const PARAM = "q";

/** Set on `<html>` before the first paint of a page opened on a link, removed once the console has read it. */
const OPENING_ATTR = "data-question-link";

/**
 * Runs in `<head>`. The static HTML of a home page is the home screen; on a link the visitor came for an
 * answer, so the console stays hidden until it has read the address (see globals.css) instead of flashing
 * the home screen first.
 */
export const QUESTION_LINK_SCRIPT = `if(/[?&]${PARAM}=[^&]/.test(location.search))document.documentElement.setAttribute("${OPENING_ATTR}","")`;

export const questionLinkRead = () => document.documentElement.removeAttribute(OPENING_ATTR);

/** A question as the console asks it: one line, no space around it. */
export const normalizeQuestion = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The question a query string carries, or null: no `q`, an empty one, or one the field could not hold (longer
 * than it accepts, a control character, a broken percent-escape). Decoded strictly, where URLSearchParams
 * would let a broken escape through as text; a literal percent sign is `%25`.
 */
export function questionIn(search: string): string | null {
  const encoded = search
    .replace(/^\?/, "")
    .split("&")
    .find((pair) => pair.startsWith(`${PARAM}=`))
    ?.slice(PARAM.length + 1);

  if (!encoded) return null;

  let raw: string;

  try {
    raw = decodeURIComponent(encoded.replaceAll("+", " "));
  } catch {
    return null;
  }

  if (raw.length > QUESTION_MAX_LENGTH || /\p{Cc}/u.test(raw)) return null;

  return normalizeQuestion(raw) || null;
}

/** The question of the page's address. */
export const addressQuestion = (): string | null => questionIn(window.location.search);

/** A question on a home page: the page showing it, or the other language's. */
export const questionPath = (path: string, question: string): string => `${path}?${new URLSearchParams({ [PARAM]: question })}`;

/** The absolute link to a question, for the clipboard. */
export const questionLink = (question: string): string => questionPath(`${window.location.origin}${window.location.pathname}`, question);

const listeners = new Set<() => void>();

/** For useSyncExternalStore: the address changed, by the console or by back / forward. */
export function subscribeToAddress(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/**
 * Makes the address say what is on screen: a question, or the home screen (null). A new history entry, so
 * back and forward walk through the questions asked; `replace` corrects the entry instead (a `q` nobody can
 * ask). Nothing is requested from the server: Next takes the native History API in.
 */
export function setAddressQuestion(question: string | null, mode: "push" | "replace" = "push") {
  const { pathname, search } = window.location;

  if (question == null ? !new URLSearchParams(search).has(PARAM) : addressQuestion() === question) return;

  const url = question == null ? pathname : questionPath(pathname, question);

  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);

  for (const listener of listeners) listener();
}
