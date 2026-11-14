const PERSONAL = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // email
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, // IPv4
  /\b(?:[\da-f]{1,4}:){4,7}[\da-f]{1,4}\b/gi, // IPv6
  /(?:\+|\b)\d(?:[ .-]?\d){8,13}\b/g, // phone number: 9 to 14 digits, single separators (a period such as "2019 - 2026" is kept)
];

/** What replaces a masked value. */
export const MASKED = "[masqué]";

/**
 * A visitor can type anything in a question: emails, IP addresses and phone
 * numbers are blanked out of whatever goes to the traces.
 */
export const maskPersonalData = (text: string): string => PERSONAL.reduce((masked, pattern) => masked.replace(pattern, MASKED), text);
