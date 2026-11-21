import { QUESTION_MAX_LENGTH } from "@/lib/agent/types";

const PARAM = "q";

const OPENING_ATTR = "data-question-link";

export const QUESTION_LINK_SCRIPT = `{const q=new URLSearchParams(location.search).getAll("${PARAM}");if(q.length===1&&q[0])document.documentElement.setAttribute("${OPENING_ATTR}","")}`;

export const questionLinkRead = () => document.documentElement.removeAttribute(OPENING_ATTR);

export const normalizeQuestion = (text: string): string => text.replace(/\s+/g, " ").trim();

export function questionIn(search: string): string | null {
  const fields = search.replace(/^\?/, "").split("&").filter((pair) => /^(?:q|%71)(?:=|$)/.test(pair));

  if (fields.length !== 1 || !fields[0].includes("=")) return null;
  const encoded = fields[0].slice(fields[0].indexOf("=") + 1);

  let raw: string;

  try {
    raw = decodeURIComponent(encoded.replaceAll("+", " "));
  } catch {
    return null;
  }

  if (raw.length > QUESTION_MAX_LENGTH || /\p{Cc}/u.test(raw)) return null;

  return normalizeQuestion(raw) || null;
}

export const addressQuestion = (): string | null => questionIn(window.location.search);

export const questionPath = (path: string, question: string): string => `${path}?${new URLSearchParams({ [PARAM]: question })}`;

export const questionLink = (question: string): string => questionPath(`${window.location.origin}${window.location.pathname}`, question);

const listeners = new Set<() => void>();

export function subscribeToAddress(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function setAddressQuestion(question: string | null, mode: "push" | "replace" = "push") {
  const { pathname, search } = window.location;

  if (question == null ? !new URLSearchParams(search).has(PARAM) : addressQuestion() === question) return;

  const url = question == null ? pathname : questionPath(pathname, question);

  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);

  for (const listener of listeners) listener();
}
