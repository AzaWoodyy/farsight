import { isIP } from "node:net";

export const MASKED = "[masqué]";

const RUN = /[a-z\d:]+(?:\.\d[a-z\d:]*)*\.?/gi;

const IPV6_MAX = 45;

const isIpv6 = (text: string) => text.length <= IPV6_MAX && /[\da-f]/i.test(text) && isIP(text) === 6;

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
  (text) => text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, MASKED),
  maskIpv6,
  (text) => text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, MASKED),
  (text) => text.replace(/(?:\+|\b)\d(?:[ .-]?\d){8,13}\b/g, MASKED),
];

export const maskPersonalData = (text: string): string => PERSONAL.reduce((masked, mask) => mask(masked), text);
