# Accessibility Statement

Farsight ([askfarsight.com](https://askfarsight.com)) is an open-source research agent over League of Legends esports data, available in French and English. This statement describes the project's accessibility goals, what is currently in place, known limitations, and how to report barriers.

## Standards and goals

Farsight aims to follow **WCAG 2.1 Level AA** across its web interface (`/` and `/en`, `/how` and `/en/how`, legal pages, and the invitation-only `/chat` surface). The project is maintained independently and has not undergone a formal third-party accessibility audit; accessibility is improved iteratively as issues are found.

## What is currently supported

- **Color contrast and themes:** Light and dark themes follow the system `prefers-color-scheme` setting and can be toggled manually. Text color tokens are chosen to meet WCAG AA contrast (4.5:1) against the page background, and team logos that match the page tone are placed on a contrasting plate.
- **Keyboard navigation and focus:** Pages include a skip-to-main-content link (and a skip-to-message-field link on `/chat`), a consistent `:focus-visible` indicator across controls, and native interactive elements (`button`, `a`, `<details>/<summary>`). Sortable table columns expose `aria-sort`, toggle groups use `aria-pressed`, and disclosures use `aria-expanded`.
- **Reduced motion:** `prefers-reduced-motion: reduce` disables transitions, blinking cursors, view transitions, language-switch text animations, and scrolling example marquees. On the home page, rotating previews and example rows pause on hover, keyboard focus, or via explicit pause controls, and unwrap into static rows under keyboard focus or reduced motion.
- **Touch targets:** On coarse pointers (`@media (pointer: coarse)`), standalone controls expand to at least 44×44 px tap targets.
- **Semantics and assistive technology:** Each language uses a static `<html lang>` attribute (`fr` or `en`), standard page landmarks (`header`, `main`, `footer`), visually hidden labels for icon-only or prompt-styled controls, and `role="status"` / `role="alert"` live regions for loading progress, feedback confirmation, and errors. Game timeline charts include an SVG `role="img"` summary label, a `<figcaption>`, and a chronological list of key events below the chart.

## Supported environments

Farsight is developed and manually tested on current desktop and mobile versions of Chromium, Firefox, and Safari, with keyboard navigation and system preferences for color scheme and reduced motion. Regular screen reader testing (VoiceOver, NVDA, JAWS) is not yet automated, so feedback from assistive-technology users is especially valuable.

## Known limitations

- **Dense data tables:** Scoreboards, multi-column statistics tables, champion/rune grids, and head-to-head views can require horizontal scrolling on narrow screens or high zoom levels.
- **Timeline gold chart:** Individual minute-by-minute data points on the SVG gold-difference graph rely on SVG `<title>` tooltips. While a summary label, caption, and key-events list are provided, the minute-by-minute gold series is not yet exposed as a keyboard-navigable table.
- **Model-composed views in `/chat`:** The invitation-only `/chat` surface can render HTML composed by the language model inside a sandboxed `<iframe>`. Heading structure or ARIA semantics in those generated views may be less consistent than in the hand-crafted views.
- **Third-party authentication UI:** Sign-in on `/chat` uses Clerk components, whose accessibility depends on Clerk's widgets.
- **No automated accessibility test suite:** Frontend accessibility checks are currently manual rather than enforced in CI.

## Reporting an accessibility issue

If you run into a barrier or something that is difficult to use, please report it in English or French:

- **GitHub Issues:** [github.com/AzaWoodyy/farsight/issues](https://github.com/AzaWoodyy/farsight/issues) (apply the `accessibility` label if available).
- **Direct contact:** Contact options are listed at [enzoneault.dev](https://www.enzoneault.dev).

You do not need to share personal or medical information. When helpful, include:

- The page URL or question asked.
- What you were trying to do and what happened instead.
- Your browser, operating system, and assistive technology, if relevant.

## Expectations for contributors

When changing or adding UI components, please:

- Use native semantic elements, landmarks, and proper heading hierarchy.
- Keep all interactive flows usable by keyboard alone with a visible focus ring.
- Maintain at least 4.5:1 contrast for text in both light and dark themes.
- Respect `prefers-reduced-motion: reduce` for any animation or transition.
- Provide accessible labels (`aria-label`, `sr-only`, `alt`, `aria-sort`, `aria-pressed`, `aria-expanded`) in both French and English.
