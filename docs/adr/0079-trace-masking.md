# Masking personal data before it reaches a trace

A visitor can type anything in a question, so `maskPersonalData` in `src/lib/tracing/mask.ts` blanks emails, IP addresses and phone numbers out of whatever goes to the traces. The hard part is IPv6: esports questions are full of colons (a game clock, a score) that must not be masked, and an address can be glued to punctuation or to another address.

## Rules

- Order of the masks (`PERSONAL`): email, then IPv6, then IPv4, then phone numbers. IPv6 runs before IPv4 and phone numbers so an IPv4-mapped address (`::ffff:192.168.1.20`) goes as a whole, not as a masked tail after a leftover prefix.
- IPv6 candidates are found in runs (`RUN`): the characters an address is written with, letters included so that a word is one run. A single period followed by a digit joins the run (an IPv4 tail); anything else ends it: a zone id (`%eth0`; the address before it is masked whatever the zone holds), an underscore (`_2001:db8::1_`), an ellipsis between two addresses, a period before a word (`2001:db8::1.Merci`).
- Inside a run, every address is masked, not only the first. An address starts at the run's start or after a colon or a period, so a label (`ip:2001:db8::1`) and the punctuation after it (`::1.`, `2001:db8::: exemple`) stay in the text.
- `addressAt` returns the longest address starting at a position: it ends at the run's end, before the run's trailing punctuation (of which it may keep a `::`), or before a period or a colon inside the run (`2001:db8::1.2e question`, `2001:db8::1:OK`). The longest is tried first so an IPv4 tail is never cut.
- Node validates each candidate (`isIP(text) === 6`), which is why a game clock ("12:34"), a score ("3:2") or a ratio ("5:1:7") is never taken for an address. The bare `::` names no one and stays (a candidate needs at least one hex digit).
- `IPV6_MAX` is 45 characters: the longest IPv6 address, six full groups and an IPv4 tail. Longer candidates are not tested.
- A phone number is 9 to 14 digits with single separators (space, period or hyphen). A separator of several characters ends it, so a period of years such as "2019 - 2026" is kept.
