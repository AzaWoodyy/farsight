import { isIP } from "node:net";

/** What replaces a masked value. */
export const MASKED = "[masqué]";

/** A run of the characters an IPv6 address (with its zone) is written with, letters included so a word is one run. */
const RUN = /[\w.:%]+/g;

/** The longest IPv6 address: eight full groups, an IPv4 tail or a zone id add up to less. */
const IPV6_MAX = 64;

const isIpv6 = (text: string) => text.length <= IPV6_MAX && /[\da-f]/i.test(text) && isIP(text) === 6;

/**
 * An IPv6 address in any of its forms (full, compressed with `::`, IPv4-mapped,
 * with a zone id) is masked inside its run. The run may start with a label
 * (`ip:2001:db8::1`) and end with punctuation (`::1.`), which stay. Node
 * validates each candidate, so a game clock ("12:34"), a score ("3:2") or a
 * ratio ("5:1:7") is never taken for one.
 */
function maskIpv6(text: string): string {
  return text.replace(RUN, (run) => {
    if (!run.includes(":")) return run;

    for (let start = 0; start < run.length; start = run.indexOf(":", start) + 1) {
      const rest = run.slice(start);

      for (const core of new Set([rest.replace(/\.+$/, ""), rest, rest.replace(/[.:]+$/, "")])) {
        if (isIpv6(core)) return `${run.slice(0, start)}${MASKED}${rest.slice(core.length)}`;
      }

      if (!rest.includes(":")) break;
    }

    return run;
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
