"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Answer, STEPS, type StepName, type StepPart, type TraceStatus } from "@/lib/agent/types";
import type { ChatControls, ChatState } from "./chat-engine";
import { HomeExamples } from "./home-examples";

// The chat (AI SDK, zod) and the answer views (tables, comparison, scoreboard...) weigh more than the home page
// itself: they are not part of its first load. They load once the page is idle, or as soon as the visitor
// focuses the field or asks a question, whichever comes first. Kept in state rather than behind next/dynamic:
// a Suspense boundary held each answer back about 300 ms after the stream had ended.
type Modules = { chat: typeof import("./chat-engine"); views: typeof import("./answer-view") };

let loading: Promise<Modules> | null = null;

const loadModules = () =>
  (loading ??= Promise.all([import("./chat-engine"), import("./answer-view")]).then(([chat, views]) => ({ chat, views })));

const IDLE: ChatState = { messages: [], status: "ready", error: undefined };

/** What the visitor reads while a step runs: what the agent is doing, in plain words. */
const PROGRESS: Record<StepName, string> = {
  understand: "Je repère les joueurs, équipes et compétitions…",
  build: "Je prépare la recherche…",
  execute: "Je cherche dans les matchs…",
  format: "Je mets la réponse en forme…",
};

const STATUS: Record<TraceStatus, { mark: string; cls: string }> = {
  ok: { mark: "ok", cls: "text-ok" },
  warn: { mark: "!!", cls: "text-warn" },
  error: { mark: "xx", cls: "text-error" },
  fix: { mark: "~>", cls: "text-fix" },
};

const STEP_LABEL: Record<StepName, string> = {
  understand: "1 comprendre",
  build: "2 construire",
  execute: "3 exécuter",
  format: "4 mettre en forme",
};

export function AgentConsole() {
  const [question, setQuestion] = useState("");
  // Anonymous id of this conversation: a random UUID made up at its first question and kept in the page,
  // so a reload or "nouvelle conversation" starts another. It groups the traces of the conversation, and
  // says nothing of the visitor.
  const sessionId = useRef<string | null>(null);

  const chat = useRef<ChatControls>(null);
  // The latest question asked; the chat, loaded with the first one, sends that one when it mounts.
  const [first, setFirst] = useState<{ text: string; sessionId: string } | null>(null);
  const [{ messages, status, error }, setChatState] = useState<ChatState>(IDLE);
  const onChatChange = useCallback((state: ChatState) => setChatState(state), []);
  const waiting = first != null && messages.length === 0 && !error;
  const running = waiting || status === "submitted" || status === "streaming";
  const [modules, setModules] = useState<Modules | null>(null);
  const preload = useCallback(() => void loadModules().then(setModules), []);

  useEffect(() => {
    const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(preload) : setTimeout(preload, 200));

    if (document.readyState === "complete") idle();
    else window.addEventListener("load", idle, { once: true });

    return () => window.removeEventListener("load", idle);
  }, [preload]);

  function ask(q: string) {
    const text = q.trim();

    if (!text) return;

    preload();
    setQuestion("");
    sessionId.current ??= crypto.randomUUID();

    // Also the question shown until the chat has taken it in (the chat reads `first` only when it mounts).
    setFirst({ text, sessionId: sessionId.current });
    chat.current?.ask(text, sessionId.current);
  }

  function restart() {
    chat.current?.reset();
    // The chat unmounts with `first`: its last state would otherwise stay on screen.
    setFirst(null);
    setChatState(IDLE);
    setQuestion("");
    sessionId.current = null;
  }

  const asked = messages.findLast((m) => m.role === "user");
  const reply = messages.findLast((m) => m.role === "assistant");
  const steps = new Map<StepName, StepPart>();
  let answer: Answer | null = null;
  let trace: { traceId: string; token: string } | null = null;

  for (const part of reply?.parts ?? []) {
    if (part.type === "data-step") steps.set(part.data.step, part.data);

    if (part.type === "data-answer") answer = part.data;

    if (part.type === "data-trace") trace = part.data;
  }

  const askedText = asked ? asked.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") : waiting ? first.text : undefined;

  return (
    <section>
      {first && modules && <modules.chat.ChatEngine controls={chat} onChange={onChatChange} first={first} />}
      {askedText ? (
        <h1 className="sr-only">{askedText}</h1>
      ) : (
        <div className="mt-10 sm:mt-16">
          <h1 className="max-w-3xl text-xl leading-snug font-semibold text-balance sm:text-3xl">
            <span aria-hidden className="text-accent">
              &gt;{" "}
            </span>
            Pose une question sur l&apos;esport League of Legends.
            <span aria-hidden className="cursor ml-1 inline-block h-[1em] w-[0.55em] translate-y-[0.15em] bg-accent" />
          </h1>
          <p className="mt-4 max-w-[68ch] border-l border-dashed border-line pl-3 text-sm leading-relaxed text-pretty text-muted">
            Minimap cherche dans les résultats et les matchs pros (Worlds, MSI, LCK, LPL, LEC, LCS…) et répond
            avec un tableau, une phrase de résumé et les pages d&apos;où viennent les chiffres.
          </p>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className={`${askedText ? "mt-6" : "mt-8"} flex items-center gap-2 border border-line bg-background py-1 pr-1 pl-3 has-[input:focus]:border-accent has-[input:focus]:shadow-[0_0_0_1px_var(--accent)]`}
      >
        <span aria-hidden className="text-accent">
          &gt;
        </span>
        <label htmlFor="question" className="sr-only">
          Ta question
        </label>
        <input
          id="question"
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          onFocus={preload}
          placeholder="Faker contre Chovy"
          autoComplete="off"
          enterKeyHint="search"
          className="min-h-11 min-w-0 flex-1 bg-transparent text-base caret-accent outline-none placeholder:text-muted sm:text-sm"
        />
        <button
          type="submit"
          disabled={running || !question.trim()}
          className="press min-h-11 shrink-0 border border-line px-4 text-xs tracking-wider uppercase hover:border-accent hover:text-accent disabled:opacity-40 sm:pointer-fine:min-h-9"
        >
          {running ? "…" : "Demander"}
        </button>
      </form>

      {!askedText && (
        <div className="mt-8">
          <HomeExamples onAsk={ask} />
          <p className="mt-6 max-w-[70ch] text-xs leading-relaxed text-muted">
            Résultats, compositions et stats de partie :{" "}
            <a className="underline decoration-line underline-offset-2 hover:text-accent" href="https://lol.fandom.com" target="_blank" rel="noreferrer">
              Leaguepedia
            </a>{" "}
            (CC BY-SA 3.0). Noms et icônes des champions, objets et runes :{" "}
            <a
              className="underline decoration-line underline-offset-2 hover:text-accent"
              href="https://developer.riotgames.com/docs/lol#data-dragon"
              target="_blank"
              rel="noreferrer"
            >
              Riot Data Dragon
            </a>
            . Chaque réponse cite ses pages.
          </p>
        </div>
      )}

      {/* At least a screen tall: the footer stays below the fold instead of sliding under the growing answer. */}
      {askedText && (
        <div className="mt-8 min-h-svh">
          {/* A long question takes the whole line and pushes the button under it, instead of a narrow column. */}
          <div className="flex flex-wrap items-start justify-between gap-x-4">
            <p className="min-w-0 flex-1 basis-48 pt-2.5 text-sm sm:pt-1">
              <span aria-hidden className="text-muted">
                ?
              </span>{" "}
              {askedText}
            </p>
            <button
              type="button"
              onClick={restart}
              className="press inline-flex min-h-11 shrink-0 items-center text-xs text-muted underline decoration-line underline-offset-2 hover:text-accent sm:pointer-fine:min-h-8"
            >
              Nouvelle conversation
            </button>
          </div>
          {/* Nothing on screen moves while the answer comes (CLS was 0.6): the progress line stays on top, the
              steps stream in under it, and the trace folds where it is when the answer appears under it. */}
          {running && <Progress steps={steps} />}
          {steps.size > 0 && <HowIFoundIt steps={steps} running={running} />}
          {error && !answer && (
            <p role="alert" className="mt-4 text-sm text-error">
              <span aria-hidden>xx</span> {error.message}
            </p>
          )}
          {/* The chat and the views load together: an answer always has its views. */}
          {answer && modules && <modules.views.AnswerView answer={answer} onAsk={ask} />}
          {answer && trace && modules && <modules.views.Feedback key={trace.traceId} traceId={trace.traceId} token={trace.token} />}
        </div>
      )}
    </section>
  );
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A braille spinner, fast so the wait feels short; a still dot when the visitor asks for reduced motion. */
function Spinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);

    return () => window.clearInterval(id);
  }, []);

  return (
    <span aria-hidden className="inline-block w-4 text-accent">
      {SPINNER[frame]}
    </span>
  );
}

/** The one line shown while the agent works, read from the step that is running. */
function Progress({ steps }: { steps: Map<StepName, StepPart> }) {
  // The latest step started; once it is done and before the next one streams, the next one is what comes.
  const lastIndex = STEPS.findLastIndex((name) => steps.has(name));
  const last = lastIndex < 0 ? undefined : STEPS[lastIndex];
  const current = last && steps.get(last)?.state === "done" ? (STEPS[lastIndex + 1] ?? last) : last;
  const retrying = current === "execute" && steps.get("execute")?.entries.some((e) => e.status === "fix");
  const label = !current ? "Je lis ta question…" : retrying ? "Je réessaie autrement…" : PROGRESS[current];

  return (
    <p className="mt-6 flex items-center gap-2 text-sm">
      <Spinner />
      <span role="status">{label}</span>
    </p>
  );
}

/**
 * The technical trace (steps, decisions, SQL, retries): open while the agent works, so the visitor sees it
 * progress, folded once the answer is in. The visitor can still open or close it by hand.
 */
function HowIFoundIt({ steps, running }: { steps: Map<StepName, StepPart>; running: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);

  // A run starting opens the trace, a run ending folds it. Set on the element after commit and left
  // uncontrolled otherwise: mirroring the toggle event into state raced with the fold (the browser's
  // toggle for the opening could land after it and reopen the trace).
  useLayoutEffect(() => {
    if (ref.current) ref.current.open = running;
  }, [running]);

  return (
    <details ref={ref} data-how className="mt-4 border-t border-dashed border-line pt-2">
      <summary className="press inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-muted hover:text-accent sm:pointer-fine:min-h-8">
        <span aria-hidden data-chevron className="inline-block">
          ›
        </span>
        {running ? "Comment je cherche" : "Voir comment j\u2019ai trouvé"}
      </summary>
      <Steps steps={steps} running={running} />
    </details>
  );
}

function Steps({ steps, running }: { steps: Map<StepName, StepPart>; running: boolean }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <ol className="space-y-2 text-xs">
        {STEPS.map((name, i) => {
          const part = steps.get(name);
          const branch = i === STEPS.length - 1 ? "└─" : "├─";

          if (!part)
            return (
              <li key={name} className="flex gap-2 text-muted">
                <span aria-hidden>{branch}</span>
                <span className="w-5 shrink-0">··</span>
                <span className="w-32 shrink-0">{STEP_LABEL[name]}</span>
                <span>{running ? "en attente" : "non exécutée"}</span>
              </li>
            );
          const interrupted = part.state === "running" && !running;
          const active = part.state === "running" && running;
          const s = STATUS[interrupted ? "error" : part.status];

          return (
            <li key={name}>
              <div className="flex gap-2">
                <span aria-hidden className="text-muted">
                  {branch}
                </span>
                <span className={`${active ? "animate-pulse text-muted" : s.cls} w-5 shrink-0`}>
                  {active ? ".." : s.mark}
                </span>
                <span className="w-32 shrink-0 text-muted">{STEP_LABEL[name]}</span>
                <span className="min-w-0">{interrupted ? "interrompue" : part.title}</span>
              </div>
              <ul className="mt-1 ml-[4.5rem] space-y-0.5 border-l border-line pl-3">
                {part.entries.map((e, j) => (
                  <li key={`${e.at}-${j}`}>
                    <details className="group">
                      <summary className="flex min-h-6 cursor-pointer list-none items-center gap-2 marker:hidden pointer-coarse:min-h-11">
                        <span className={`${STATUS[e.status].cls} w-5 shrink-0`}>{STATUS[e.status].mark}</span>
                        <span className="min-w-0">
                          {e.title}
                          {e.level && (
                            <span className="ml-2 text-muted">
                              [{e.level}
                              {e.confidence != null && ` ${e.confidence.toFixed(2)}`}]
                            </span>
                          )}
                          {e.detail && <span className="ml-2 text-muted group-open:hidden">[+]</span>}
                        </span>
                      </summary>
                      {e.detail && (
                        <pre className="mt-1 mb-2 ml-7 overflow-x-auto text-xs leading-relaxed text-muted">
                          {e.detail}
                        </pre>
                      )}
                    </details>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
