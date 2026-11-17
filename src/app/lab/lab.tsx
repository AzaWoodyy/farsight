"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Answer, StepName, StepPart } from "@/lib/agent/types";
import { HowIFoundIt, Progress } from "../agent-console";
import { AnswerView, Feedback } from "../answer-view";
import { LocaleProvider } from "../i18n/locale-context";
import { LAB_FIXTURES, LAB_VARIANTS, type LabState } from "./catalog";
import { LabMenu } from "./lab-menu";

type Fixture = { question: string; steps: StepPart[]; answer: Answer | null; error: string | null };

type Loaded = Fixture | "missing";

const cache = new Map<string, Promise<Loaded>>();

async function fetchFixture(id: string): Promise<Loaded> {
  try {
    const res = await fetch(`${LAB_FIXTURES}/${id}.json`);

    if (!res.ok) return "missing";

    // Written by scripts/lab/build.ts from the agent's own Answer, in the same deployment.
    const fixture: Fixture = await res.json();

    return fixture;
  } catch {
    cache.delete(id);

    return "missing";
  }
}

/** A variant's fixture, fetched once: flipping back to a variant already seen is instant. */
function load(id: string) {
  const hit = cache.get(id);

  if (hit) return hit;

  const request = fetchFixture(id);

  cache.set(id, request);

  return request;
}

/** The variant on screen is the `?v=` of the address: a reload or a shared link opens the same one. */
const URL_EVENT = "farsight:lab-url";

function subscribeUrl(onChange: () => void) {
  window.addEventListener(URL_EVENT, onChange);
  window.addEventListener("popstate", onChange);

  return () => {
    window.removeEventListener(URL_EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

const urlVariant = () => new URLSearchParams(window.location.search).get("v");

export function Lab() {
  // The server and the first client render show the first variant; the address takes over right after.
  const id = useSyncExternalStore(subscribeUrl, urlVariant, () => null);
  const index = Math.max(0, LAB_VARIANTS.findIndex((v) => v.id === id));
  const [shown, setShown] = useState<{ id: string; fixture: Loaded } | null>(null);
  const variant = LAB_VARIANTS[index];

  const select = useCallback((next: number) => {
    const i = (next + LAB_VARIANTS.length) % LAB_VARIANTS.length;
    const url = new URL(window.location.href);

    url.searchParams.set("v", LAB_VARIANTS[i].id);
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new Event(URL_EVENT));
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    let current = true;

    void load(variant.id).then((fixture) => {
      if (current) setShown({ id: variant.id, fixture });
    });

    // The neighbours are fetched ahead: the arrow keys never wait.
    for (const d of [1, -1]) void load(LAB_VARIANTS[(index + d + LAB_VARIANTS.length) % LAB_VARIANTS.length].id);

    return () => {
      current = false;
    };
  }, [variant.id, index]);

  const fixture = shown?.id === variant.id ? shown.fixture : null;

  // A follow-up that is itself in the catalogue opens that variant; the others have no answer here.
  const onAsk = (q: string) => {
    const i = LAB_VARIANTS.findIndex((v) => !v.state && v.question.toLowerCase() === q.toLowerCase());

    if (i >= 0) select(i);
  };

  return (
    <LocaleProvider locale="fr">
    <section>
      <h1 className="sr-only">Lab des affichages : {variant.groupTitle}, {variant.label}</h1>
      {/* The console's question field, as it sits above an answer; inert here. */}
      <div
        aria-hidden
        className="mt-6 flex items-center gap-2 border border-line bg-background py-1 pr-1 pl-3"
      >
        <span className="text-accent">&gt;</span>
        <span className="flex min-h-11 min-w-0 flex-1 items-center text-base text-muted sm:text-sm">Faker contre Chovy</span>
        <span className="inline-flex min-h-11 shrink-0 items-center border border-line px-4 text-xs tracking-wider uppercase opacity-40 sm:pointer-fine:min-h-9">
          Demander
        </span>
      </div>
      <div className={`mt-8 ${variant.state?.startsWith("loading") ? "min-h-svh" : ""}`}>
        <div className="flex flex-wrap items-start justify-between gap-x-4">
          <p className="min-w-0 flex-1 basis-40 pt-2.5 text-sm sm:pt-1">
            <span aria-hidden className="text-muted">
              ?
            </span>{" "}
            {variant.question}
          </p>
          <span className="inline-flex min-h-11 shrink-0 items-center text-xs text-muted underline decoration-line underline-offset-2 sm:pointer-fine:min-h-8">
            Nouvelle conversation
          </span>
        </div>
        {fixture === "missing" ? (
          <p className="mt-6 text-sm text-warn">
            Fixture absente pour « {variant.id} » : lancer <code>bun run lab:build</code>, puis recharger.
          </p>
        ) : (
          // Keyed: a variant starts from its own initial state (sort order, open tabs), and entrances replay.
          fixture && <Variant key={variant.id} fixture={fixture} state={variant.state} onAsk={onAsk} />
        )}
      </div>
      <LabMenu index={index} onSelect={select} />
    </section>
    </LocaleProvider>
  );
}

const stepMap = (steps: StepPart[]) => new Map<StepName, StepPart>(steps.map((s) => [s.step, s]));

/** The steps as they stand while `last` is still running: the earlier ones done, the later ones not started. */
function runningAt(steps: StepPart[], last: StepName) {
  const until = steps.findIndex((s) => s.step === last);

  return stepMap(steps.slice(0, until + 1).map((s) => (s.step === last ? { ...s, state: "running" as const } : s)));
}

function Variant({ fixture, state, onAsk }: { fixture: Fixture; state?: LabState; onAsk: (q: string) => void }) {
  const { answer, steps } = fixture;

  if (state === "loading-start" || state === "loading-retry") {
    const running = runningAt(steps, state === "loading-start" ? "understand" : "execute");

    return (
      <>
        <Progress steps={running} />
        <HowIFoundIt steps={running} running />
      </>
    );
  }

  if (state === "error")
    return (
      <p role="alert" className="mt-4 text-sm text-error">
        <span aria-hidden>xx</span> Erreur interne.
      </p>
    );

  if (state === "load-failed") {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-x-3 text-sm">
        <p role="alert" className="text-error">
          <span aria-hidden>xx</span> Chargement impossible : vérifie ta connexion, puis réessaie.
        </p>
        <button
          type="button"
          className="press inline-flex min-h-11 items-center border border-line px-3 text-xs hover:border-accent hover:text-accent sm:pointer-fine:min-h-8"
        >
          Réessayer
        </button>
      </div>
    );
  }

  if (!answer)
    return (
      <p role="alert" className="mt-4 text-sm text-error">
        <span aria-hidden>xx</span> L&apos;agent a échoué au build des fixtures : {fixture.error}
      </p>
    );

  return (
    <>
      <AnswerView answer={answer} onAsk={onAsk} />
      <HowIFoundIt steps={stepMap(steps)} running={false} />
      {/* A made-up trace: the buttons are the real ones, the rating is refused by /api/feedback. */}
      {state === "feedback" && <Feedback traceId="lab" token="lab" />}
    </>
  );
}
