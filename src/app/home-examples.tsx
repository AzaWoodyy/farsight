"use client";

import { useContext, useState } from "react";
import { AskContext } from "./ask-link";
import { type Example, exampleRows } from "./home-examples-data";
import { useLocale, useUi } from "./i18n/locale-context";

type AskProps = { onAsk: (question: string) => void };

function Chips({ examples, onAsk, copy }: AskProps & { examples: Example[]; copy?: boolean }) {
  return examples.map((e) => (
    <li key={e.question} data-copy={copy ? "" : undefined} aria-hidden={copy || undefined} className="mr-2 flex shrink-0">
      <button
        type="button"
        tabIndex={copy ? -1 : undefined}
        onClick={() => onAsk(e.question)}
        className="press inline-flex min-h-11 items-center gap-x-2 border border-line px-3 py-1.5 text-sm whitespace-nowrap hover:border-accent hover:text-accent sm:pointer-fine:min-h-10"
      >
        {e.question}
      </button>
    </li>
  ));
}

export function HomeExamples() {
  const ask = useContext(AskContext);
  const onAsk = (question: string) => ask?.(question);
  const locale = useLocale();
  const ui = useUi();
  const [paused, setPaused] = useState(false);

  return (
    <section aria-labelledby="examples" className="mt-10 sm:mt-12">
      <div className="flex items-center justify-between gap-4">
        <h2 id="examples" className="text-base font-semibold">
          {ui.examples.heading}
        </h2>
        <button type="button" onClick={() => setPaused((p) => !p)} className="marquee-toggle press tap text-xs text-muted hover:text-accent">
          {paused ? ui.examples.resume : ui.examples.pause}
        </button>
      </div>
      <div className="marquees mt-4" data-paused={paused ? "" : undefined}>
        {exampleRows(locale).map((examples, row) => (
          <div key={row} className="marquee">
            <ul className="marquee-track">
              <Chips examples={examples} onAsk={onAsk} />
              <Chips examples={examples} onAsk={onAsk} copy />
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
