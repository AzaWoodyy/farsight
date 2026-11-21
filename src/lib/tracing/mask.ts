import { isIP } from "node:net";

/** What replaces a masked value. */
export const MASKED = "[masqué]";

/**
 * A run of the characters an IPv6 address is written with, letters included so
 * a word is one run. A single period followed by a digit joins (an IPv4 tail);
 * anything else ends a run: a zone id (`%eth0`, the address before it is
 * masked whatever the zone holds), an underscore (`_2001:db8::1_`), an ellipsis
 * between two addresses, a period before a word (`2001:db8::1.Merci`).
 */
const RUN = /[a-z\d:]+(?:\.\d[a-z\d:]*)*\.?/gi;

/** The longest IPv6 address: six full groups and an IPv4 tail. */
const IPV6_MAX = 45;

const isIpv6 = (text: string) => text.length <= IPV6_MAX && /[\da-f]/i.test(text) && isIP(text) === 6;

/**
 * The longest IPv6 address starting at `start`: it ends at the run's end,
 * before its punctuation (of which it may keep a `::`), or before a period or
 * a colon (`2001:db8::1.2e question`, `2001:db8::1:OK`). The longest is tried first, so an IPv4 tail is
 * never cut.
 */
function addressAt(run: string, start: number, end: number): string | null {
  if (end - start <= IPV6_MAX) {
    const rest = run.slice(start, end + 2);
    const dots = rest.replace(/\.+$/, "");

    for (const core of new Set([dots, rest, dots.replace(/:$/, ""), rest.replace(/[.:]+$/, "")])) if (isIpv6(core)) return core;
  }

  for (let at = Math.min(start + IPV6_MAX, end - 1); at > start; at--) {
    if (!".:".includes(run[at])) continue;
    const core = run.slice(start, at);

    if (core.includes(":") && isIpv6(core)) return core;
  }

  return null;
}

/**
 * An IPv6 address in any of its forms (full, compressed with `::`, IPv4-mapped)
 * is masked inside its run, every one of them. It starts at the run's start or
 * after a colon or a period, so a label (`ip:2001:db8::1`) and the punctuation
 * after it (`::1.`, `2001:db8::: exemple`) stay. Node validates each candidate,
 * so a game clock ("12:34"), a score ("3:2") or a ratio ("5:1:7") is never
 * taken for one. The bare `::` names no one and stays.
 */
function maskIpv6(text: string): string {
  return text.replace(RUN, (run) => {
    if (!run.includes(":")) return run;
    let end = run.length;

    while (end > 0 && ".:".includes(run[end - 1])) end--;
    let masked = "";
    let done = 0;

    for (let start = 0; start < end; start++) {
      if (start > done && !".:".includes(run[start - 1])) continue;
      const core = addressAt(run, start, end);

      if (!core) continue;
      masked += `${run.slice(done, start)}${MASKED}`;
      done = start + core.length;
      start = done - 1;
    }

    return masked + run.slice(done);
  });
}

const PERSONAL: ((text: string) => string)[] = [
  (text) => text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, MASKED), // email
  maskIpv6, // before IPv4 and phone numbers, so an IPv4-mapped address goes as a whole
  (text) => text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, MASKED), // IPv4
  (text) => text.replace(/(?:\+|\b)\d(?:[ .-]?\d){8,13}\b/g, MASKED), // phone number: 9 to 14 digits, single separators (a period such as "2019 - 2026" is kept)
];

/**
 * A visitor can type anything in a question: emails, IP addresses and phone
 * numbers are blanked out of whatever goes to the traces.
 */
export const maskPersonalData = (text: string): string => PERSONAL.reduce((masked, mask) => mask(masked), text);
