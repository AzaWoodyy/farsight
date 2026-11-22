"use client";

import "../zod-client";
import "./chat.css";
import { useChat } from "@ai-sdk/react";
import { UserButton, useUser } from "@clerk/nextjs";
import { DefaultChatTransport } from "ai";
import { z } from "zod";
import { type ReactNode, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CHAT_MESSAGE_MAX_LENGTH, type ChatCard, type ChatCardImage, type ChatUIMessage, DAILY_LIMIT_ERROR, type ShownAnswer } from "@/lib/agent/chat-types";
import type { Locale } from "@/lib/locale";
import { Mark } from "../brand/logo";
import { httpErrorMessage } from "../chat-engine";
import { EntityIcon } from "../entity-icon";
import { PlayerAvatar } from "../player-avatar";
import { SITE } from "../brand/site";
import { LANG_SWITCH_ATTR } from "../i18n/arrival";
import { CHAT, type ChatTexts } from "../i18n/chat";
import { UI } from "../i18n/ui";
import { decode } from "../i18n/decode";
import { LocaleProvider, useLocale } from "../i18n/locale-context";
import { CHAT_PATHS, LOCALE_NAME, LOCALES, PATHS } from "../i18n/locales";
import { SHELL } from "../i18n/shell";
import { ThemeToggle } from "../theme-toggle";
import { type Conversation, conversations, UNDO_MS } from "./conversations";
import { DATA_MODE_LABEL, DATA_MODES, type DataMode, dataMode, WORST_LOGIN } from "./worst-case";
import { HtmlFrame } from "./html-frame";

type Texts = ChatTexts["room"];

const DailyLimit = z.object({ error: z.literal(DAILY_LIMIT_ERROR), limit: z.number() });

const chatFetchIn = (locale: Locale) => async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const { errors } = UI[locale];
  let res: Response;

  try {
    res = await fetch(input, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error(errors.offline);
  }

  if (res.ok) return res;

  const limit = res.status === 429 ? DailyLimit.safeParse(await res.json().catch(() => null)) : null;

  throw new Error(limit?.success ? CHAT[locale].room.dailyLimit(limit.data.limit) : httpErrorMessage(res.status, errors));
};

const transports = new Map(
  LOCALES.map((locale) => [locale, new DefaultChatTransport<ChatUIMessage>({ api: "/api/chat", fetch: Object.assign(chatFetchIn(locale), { preconnect: fetch.preconnect }) })]),
);

const CARD_ROWS = 6;
const DAY_MS = 86_400_000;
const COMPOSER_MAX_HEIGHT = 200;
const NEAR_BOTTOM = 160;
const HASH_PREFIX = "#c=";
const DESKTOP = "(min-width: 48rem)";

const NO_MESSAGES: ChatUIMessage[] = [];

const subscribeNever = () => () => {};

let arrivedOn: { id: string | null } | null = null;

const arrivalConversation = () => (arrivedOn ??= { id: window.location.hash.startsWith(HASH_PREFIX) ? window.location.hash.slice(HASH_PREFIX.length) : null }).id;

function setAddressConversation(id: string | null) {
  window.history.replaceState(window.history.state, "", id ? `${HASH_PREFIX}${id}` : window.location.pathname + window.location.search);
}

export function ChatRoom({ locale, account }: { locale: Locale; account: string }) {
  return (
    <LocaleProvider locale={locale}>
      <Shell locale={locale} account={account} />
    </LocaleProvider>
  );
}

function Shell({ locale, account }: { locale: Locale; account: string }) {
  const t = CHAT[locale].room;
  const shell = SHELL[locale];
  const snapshot = useMemo(() => conversations.snapshotOf(account), [account]);
  const library = useSyncExternalStore(conversations.subscribe, snapshot, conversations.serverSnapshot);
  const saved = library.list;
  const linked = useSyncExternalStore(subscribeNever, arrivalConversation, () => null);
  const [chosen, setChosen] = useState<{ id: string | null } | null>(null);
  const [room, setRoom] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarMove, setSidebarMove] = useState<"opening" | "closing" | null>(null);
  const [removed, setRemoved] = useState<Conversation | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { user } = useUser();
  const stress = useSyncExternalStore(subscribeNever, dataMode, (): DataMode => "demo");
  const login = stress === "worst" ? WORST_LOGIN : (user?.username ?? user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? "");
  const linkedIsGone = chosen == null && linked != null && library.state === "ready" && !saved.some((c) => c.id === linked);
  const activeId = chosen ? chosen.id : linkedIsGone ? null : linked;
  const active = saved.find((c) => c.id === activeId);
  const awaited = (linked != null && chosen == null && library.state === "loading") || (active != null && active.messages == null);
  const unconfirmed = linked != null && chosen == null && !active && library.state === "failed";

  function open(id: string | null) {
    setChosen({ id });
    setAddressConversation(id);
    setRoom((n) => n + 1);
    closeMenu();
  }

  const refocus = useRef(false);

  function closeMenu() {
    if (!menuOpen) return;
    refocus.current = true;
    setMenuOpen(false);
  }

  useEffect(() => {
    if (menuOpen || !refocus.current) return;
    refocus.current = false;
    menuButton.current?.focus({ preventScroll: true });
  }, [menuOpen]);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape" && menuOpen) closeMenu();

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      open(null);
    }
  });

  useEffect(() => {
    const wide = window.matchMedia(DESKTOP);
    const onWide = () => wide.matches && setMenuOpen(false);

    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);

    return () => {
      window.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, []);

  const restored = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  useEffect(() => {
    const arrival = window.__langArrival;

    if (!restored || !arrival) return;

    window.__langArrival = null;

    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) decode(document.body);

    arrival.transition?.skipTransition();
  }, [restored]);

  useEffect(() => {
    const leave = () => {
      conversations.flush();
      setRemoved(null);
    };

    conversations.enter(account);
    window.addEventListener("pagehide", leave);

    return () => window.removeEventListener("pagehide", leave);
  }, [account]);

  useEffect(() => {
    if (active && active.messages == null && !active.unopened) void conversations.open(active.id);
  }, [active]);

  useEffect(() => {
    if (linkedIsGone) setAddressConversation(null);
  }, [linkedIsGone]);

  useEffect(() => {
    if (!removed) return;
    const id = window.setTimeout(() => setRemoved(null), UNDO_MS);

    return () => window.clearTimeout(id);
  }, [removed]);

  return (
    <div className="chat-shell fixed inset-x-0 top-0 flex h-dvh overflow-hidden bg-background">
      <a
        href="#message"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-40 focus-visible:border focus-visible:border-accent focus-visible:bg-background focus-visible:px-3 focus-visible:py-2 focus-visible:text-xs"
      >
        {t.skip}
      </a>
      {process.env.NODE_ENV === "development" && <DataToggle active={stress} />}
      <div aria-hidden data-open={menuOpen ? "" : undefined} onClick={closeMenu} className="chat-scrim fixed inset-0 z-20 bg-background/75 md:hidden" />
      <aside
        aria-label={t.history}
        data-open={menuOpen ? "" : undefined}
        data-collapsed={collapsed ? "" : undefined}
        className="chat-drawer fixed inset-y-0 left-0 z-30 w-72 max-w-[85vw] shrink-0 bg-background md:relative md:inset-auto md:w-64"
      >
        <div className="chat-drawer-panel flex h-full w-72 max-w-[85vw] flex-col border-r border-line bg-background pb-[env(safe-area-inset-bottom,0px)] md:absolute md:inset-y-0 md:left-0 md:w-64">
        <div className="flex items-center justify-between gap-2 px-3 pt-3 md:px-5 md:pt-8">
          <a href={PATHS.home[locale]} aria-label={shell.homeLabel} className="press inline-flex min-h-11 items-center gap-2.5 hover:text-accent">
            <Mark size={32} />
            <span translate="no" className="text-base font-semibold lowercase">
              {SITE.name}
            </span>
          </a>
          <button
            type="button"
            aria-label={t.closeMenu}
            onClick={closeMenu}
            className="press inline-flex size-11 items-center justify-center text-muted hover:text-accent md:hidden"
          >
            <span aria-hidden>×</span>
          </button>
        </div>
        <div className="px-3 pt-3">
          <button
            type="button"
            title={t.newChatKeys}
            onClick={() => open(null)}
            className="press flex min-h-11 w-full items-center gap-2 border border-line px-3 text-left text-xs hover:border-accent hover:text-accent sm:pointer-fine:min-h-9"
          >
            <span aria-hidden className="text-accent">
              +
            </span>
            {t.newChat}
          </button>
        </div>
        <nav aria-label={t.history} className="chat-scroll mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {saved.length === 0 ? (
            <p className="px-1 text-xs leading-relaxed text-muted">{library.state === "loading" ? t.loading : t.noHistory}</p>
          ) : (
            <History
              t={t}
              saved={saved}
              activeId={activeId}
              onOpen={open}
              onRemove={(id) => {
                setRemoved(conversations.remove(id));

                if (id === activeId) open(null);
              }}
            />
          )}
        </nav>
        <div aria-live="polite" className="px-3">
          {removed && (
            <p className="chat-in flex items-center justify-between gap-2 border border-line px-3 text-xs">
              {t.removed}
              <button
                type="button"
                onClick={() => {
                  conversations.restore(removed);
                  setRemoved(null);
                }}
                className="press inline-flex min-h-11 items-center text-accent underline decoration-line underline-offset-2 sm:pointer-fine:min-h-8"
              >
                {t.undo}
              </button>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 px-4 pt-2 pb-3">
          <UserButton />
          <p className="min-w-0 text-xs leading-relaxed">
            <span translate="no" title={login} className="block truncate">
              {login}
            </span>
            {(library.state === "unsaved" || library.state === "failed") && <span className="block text-warn">{t.unsaved}</span>}
          </p>
        </div>
        </div>
      </aside>

      <div inert={menuOpen} data-sidebar={sidebarMove ?? undefined} className="chat-main flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 pt-5 pb-3 sm:px-6 sm:pt-8 md:box-content md:h-11 md:px-5">
          <button
            type="button"
            aria-label={collapsed ? t.openMenu : t.closeMenu}
            title={collapsed ? t.openMenu : t.closeMenu}
            aria-expanded={!collapsed}
            onClick={() => {
              setSidebarMove(collapsed ? "opening" : "closing");
              setCollapsed(!collapsed);
            }}
            className="press hidden size-8 shrink-0 items-center justify-center border border-line text-muted hover:border-accent hover:text-accent pointer-coarse:size-11 md:inline-flex"
          >
            <span aria-hidden>{collapsed ? "»" : "«"}</span>
          </button>
          <button
            ref={menuButton}
            type="button"
            aria-label={t.openMenu}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            className="press inline-flex size-11 shrink-0 items-center justify-center border border-line text-muted hover:border-accent hover:text-accent md:hidden"
          >
            <span aria-hidden>≡</span>
          </button>
          <p title={active?.title.trim() || t.untitled} className="min-w-0 flex-1 truncate text-xs text-muted">
            <span aria-hidden>~/ </span>
            {active?.title.trim() || t.untitled}
          </p>
          {LOCALES.filter((other) => other !== locale).map((other) => (
            <a
              key={other}
              href={`${CHAT_PATHS[other]}${activeId ? `${HASH_PREFIX}${activeId}` : ""}`}
              hrefLang={other}
              lang={other}
              aria-label={LOCALE_NAME[other]}
              title={LOCALE_NAME[other]}
              {...{ [LANG_SWITCH_ATTR]: "" }}
              className="press inline-flex size-11 shrink-0 items-center justify-center border border-line text-xs text-muted uppercase hover:border-accent hover:text-accent sm:pointer-fine:size-8"
            >
              {other}
            </a>
          ))}
          <ThemeToggle toLight={shell.theme.toLight} toDark={shell.theme.toDark} />
        </header>
        {active?.unopened || unconfirmed ? (
          <div className="flex flex-wrap items-center gap-x-3 p-6 text-sm">
            <p role="alert" className="text-error">
              <span aria-hidden>xx</span> {t.openFailed}
            </p>
            <button
              type="button"
              onClick={() => (active ? void conversations.open(active.id) : conversations.reload())}
              className="press inline-flex min-h-11 items-center border border-line px-3 text-xs hover:border-accent hover:text-accent sm:pointer-fine:min-h-8"
            >
              {t.retry}
            </button>
          </div>
        ) : awaited ? (
          <p className="p-6 text-sm">
            <span className="t-shimmer" data-text={t.loading}>
              {t.loading}
            </span>
          </p>
        ) : (
        <Room
          key={room}
          id={activeId}
          title={active?.title.trim() || t.untitled}
          onStart={(id) => {
            setChosen({ id });
            setAddressConversation(id);
          }}
          locale={locale}
          t={t}
          initial={active?.messages ?? NO_MESSAGES}
        />
        )}
      </div>
    </div>
  );
}

function DataToggle({ active }: { active: DataMode }) {
  return (
    <nav aria-label="Test data" className="fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 gap-0.5 overflow-x-auto rounded-md bg-neutral-300 p-0.5 font-sans text-[11px] text-neutral-700 shadow">
      {DATA_MODES.map((mode) => (
        <a key={mode} href={mode === "demo" ? "?" : `?data=${mode}`} aria-current={mode === active ? "true" : undefined} className={`rounded px-2 py-1 whitespace-nowrap ${mode === active ? "bg-white text-black" : ""}`}>
          {DATA_MODE_LABEL[mode]}
        </a>
      ))}
    </nav>
  );
}

function History({ t, saved, activeId, onOpen, onRemove }: { t: Texts; saved: Conversation[]; activeId: string | null; onOpen: (id: string) => void; onRemove: (id: string) => void }) {
  const [now] = useState(() => Date.now());

  const groups = [
    { label: t.groups.today, items: saved.filter((c) => now - c.updatedAt < DAY_MS) },
    { label: t.groups.week, items: saved.filter((c) => now - c.updatedAt >= DAY_MS && now - c.updatedAt < 7 * DAY_MS) },
    { label: t.groups.older, items: saved.filter((c) => now - c.updatedAt >= 7 * DAY_MS) },
  ].filter((g) => g.items.length > 0);

  return groups.map((group) => (
    <section key={group.label} className="mb-4">
      <h2 className="px-1 text-xs text-muted">{group.label}</h2>
      <ul className="mt-1">
        {group.items.map((c) => (
          <li key={c.id} className={`group/item flex items-center border-l-2 ${c.id === activeId ? "border-accent" : "border-transparent hover:border-line"}`}>
            <button
              type="button"
              aria-current={c.id === activeId ? "page" : undefined}
              onClick={() => onOpen(c.id)}
              title={c.title.trim() || t.untitled}
              className={`press min-h-11 min-w-0 flex-1 truncate px-2 text-left text-xs hover:text-accent sm:pointer-fine:min-h-8 ${c.id === activeId ? "text-foreground" : "text-muted"}`}
            >
              {c.title.trim() || t.untitled}
            </button>
            <button
              type="button"
              aria-label={t.remove(c.title.trim() || t.untitled)}
              onClick={() => onRemove(c.id)}
              className="press inline-flex size-11 shrink-0 items-center justify-center text-muted hover:text-error focus-visible:opacity-100 sm:pointer-fine:size-8 md:pointer-fine:opacity-0 md:pointer-fine:group-hover/item:opacity-100 md:pointer-fine:group-focus-within/item:opacity-100"
            >
              <span aria-hidden>×</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  ));
}

function Room({ id, title, onStart, locale, t, initial }: { id: string | null; title: string; onStart: (id: string) => void; locale: Locale; t: Texts; initial: ChatUIMessage[] }) {
  const [opened] = useState(initial);
  const { messages, sendMessage, status, error, stop } = useChat<ChatUIMessage>({ transport: transports.get(locale), messages: opened });
  const own = useRef(id);
  const running = status === "submitted" || status === "streaming";
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const last = messages.at(-1);
  const shownParts = messages.length + (last?.parts.length ?? 0);

  useEffect(() => {
    if (!running && own.current && messages.length > 0 && messages !== opened) conversations.save(own.current, messages);
  }, [running, messages, opened]);

  useLayoutEffect(() => {
    const node = scroller.current;

    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [shownParts, running, last]);

  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) field.current?.focus({ preventScroll: true });
  }, []);

  function resize() {
    const node = field.current;

    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }

  function toBottom() {
    const node = scroller.current;

    if (!node) return;
    pinned.current = true;
    setAway(false);
    node.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function ask(raw: string) {
    const text = raw.replace(/[^\S\n]+/g, " ").trim().slice(0, CHAT_MESSAGE_MAX_LENGTH);

    if (!text || running) return;

    if (field.current) field.current.value = "";
    resize();
    pinned.current = true;
    setAway(false);

    if (!own.current) {
      own.current = crypto.randomUUID();
      onStart(own.current);
    }

    void sendMessage({ text }, { body: { locale, conversationId: own.current } });
  }

  const waiting = running && last?.role === "user";
  const fresh = (message: ChatUIMessage) => !opened.includes(message);

  return (
    <>
      <p role="status" className="sr-only">
        {running ? t.thinking : messages.length > opened.length ? t.answered : ""}
      </p>
      <div
        ref={scroller}
        onScroll={(e) => {
          const node = e.currentTarget;
          const near = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM;

          pinned.current = near;

          if (near === away) setAway(!near);
        }}
        className="chat-scroll min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 sm:px-6">
          {messages.length === 0 ? (
            <div className="my-auto py-10">
              <h1 className="max-w-3xl text-xl leading-snug font-semibold text-balance sm:text-3xl">
                <span aria-hidden className="text-accent">
                  &gt;{" "}
                </span>
                {t.heading}
                <span aria-hidden className="cursor ml-1 inline-block h-[1em] w-[0.55em] translate-y-[0.15em] bg-accent" />
              </h1>
              <ul className="mt-8 flex flex-wrap gap-2">
                {t.examples.map((example) => (
                  <li key={example} className="flex min-w-0">
                    <button
                      type="button"
                      onClick={() => ask(example)}
                      className="press inline-flex min-h-11 items-center gap-x-2 border border-line px-3 py-1.5 text-left text-[13px] hover:border-accent hover:text-accent sm:pointer-fine:min-h-10"
                    >
                      <span aria-hidden className="text-accent">
                        &gt;
                      </span>
                      {example}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <h1 className="sr-only">{title}</h1>
              <ol className="flex flex-col gap-5 py-6">
                {messages.map((message) =>
                  message.role === "user" ? (
                    <li key={message.id} className={`flex justify-end ${fresh(message) ? "chat-in" : ""}`}>
                      <Asked message={message} you={t.you} />
                    </li>
                  ) : (
                    <li key={message.id} className="flex flex-col items-start gap-3">
                      <Reply message={message} t={t} live={running && message === last} animated={fresh(message)} />
                    </li>
                  ),
                )}
                {waiting && (
                  <li>
                    <Status label={t.thinking} />
                  </li>
                )}
                {error && (
                  <li>
                    <p role="alert" className="text-sm text-error">
                      <span aria-hidden>xx</span> {error.message}
                    </p>
                  </li>
                )}
              </ol>
            </>
          )}
        </div>
      </div>

      <div className="relative shrink-0 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] sm:px-6">
        <div aria-hidden className="chat-edge pointer-events-none absolute inset-x-0 -top-6 h-6" />
        <div className="relative mx-auto w-full max-w-4xl">
          <button
            type="button"
            aria-label={t.bottom}
            title={t.bottom}
            data-hidden={away ? undefined : ""}
            tabIndex={away ? 0 : -1}
            onClick={toBottom}
            className="chat-jump press absolute -top-12 left-1/2 inline-flex size-10 -translate-x-1/2 items-center pointer-coarse:-top-14 pointer-coarse:size-11 justify-center border border-line bg-background text-muted hover:border-accent hover:text-accent"
          >
            <span aria-hidden>↓</span>
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(field.current?.value ?? "");
            }}
            className="flex items-end gap-2 border border-line bg-background py-1 pr-1 pl-3 has-[textarea:focus-visible]:border-accent has-[textarea:focus-visible]:shadow-[0_0_0_1px_var(--accent)]"
          >
            <span aria-hidden className="pb-2.5 text-accent">
              &gt;
            </span>
            <label htmlFor="message" className="sr-only">
              {t.label}
            </label>
            <textarea
              ref={field}
              id="message"
              name="message"
              rows={1}
              maxLength={CHAT_MESSAGE_MAX_LENGTH}
              placeholder={t.placeholder}
              autoComplete="off"
              enterKeyHint="send"
              onInput={resize}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                ask(e.currentTarget.value);
              }}
              className="min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-base leading-relaxed caret-accent outline-none placeholder:text-muted sm:pointer-fine:text-sm"
            />
            {running ? (
              <button
                type="button"
                onClick={() => void stop()}
                className="press min-h-11 shrink-0 border border-line px-4 text-[13px] tracking-wider uppercase hover:border-error hover:text-error sm:pointer-fine:min-h-9"
              >
                {t.stop}
              </button>
            ) : (
              <button
                type="submit"
                className="press min-h-11 shrink-0 border border-line px-4 text-[13px] tracking-wider uppercase hover:border-accent hover:text-accent sm:pointer-fine:min-h-9"
              >
                {t.send}
              </button>
            )}
          </form>
        </div>
      </div>
    </>
  );
}

function Asked({ message, you }: { message: ChatUIMessage; you: string }) {
  return (
    <p dir="auto" className="chat-prose max-w-[85%] border border-line px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere">
      <span className="sr-only">{you} : </span>
      {message.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ")}
    </p>
  );
}

function Status({ label }: { label: string }) {
  return (
    <p className="text-sm">
      <span className="t-shimmer" data-text={label}>
        {label}
      </span>
    </p>
  );
}

function Card({ children, animated }: { children: ReactNode; animated: boolean }) {
  return <div className={`w-full max-w-2xl border border-line px-3 py-3 sm:px-4 ${animated ? "chat-in" : ""}`}>{children}</div>;
}

function CardTitle({ title }: { title: string }) {
  return (
    <h2 className="text-sm font-semibold text-balance">
      <span aria-hidden className="text-accent">
        #{" "}
      </span>
      {title}
    </h2>
  );
}

function CardImage({ name, image, size }: { name: string; image: ChatCardImage; size: number }) {
  return image.photo ? <PlayerAvatar name={name} photo={{ url: image.src, year: null, source: image.src }} size={size} /> : <EntityIcon src={image.src} size={size} tone={image.tone} />;
}

const FIGURE = { maximumFractionDigits: 2, useGrouping: false } as const;

const FIGURES: Record<Locale, Intl.NumberFormat> = { fr: new Intl.NumberFormat("fr", FIGURE), en: new Intl.NumberFormat("en", FIGURE) };

function shownCell(cell: string | number | null, locale: Locale): string {
  if (cell == null) return "–";

  const figure = z.number().safeParse(cell);

  return figure.success ? FIGURES[locale].format(figure.data) : String(cell);
}

function ResultCard({ t, shown, card, animated }: { t: Texts; shown: ShownAnswer; card: ChatCard; animated: boolean }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const table = card.table;
  const rows = table ? (open ? table.rows : table.rows.slice(0, CARD_ROWS)) : [];

  return (
    <Card animated={animated}>
      <CardTitle title={card.title} />
      {(card.subjects?.length ?? 0) > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {card.subjects?.map((subject) => (
            <li key={subject.name} className="flex min-w-0 items-center gap-2.5">
              {subject.image && <CardImage name={subject.name} image={subject.image} size={subject.image.photo ? 40 : 28} />}
              <span className="min-w-0">
                <span translate="no" dir="auto" className="block text-sm font-semibold wrap-anywhere">
                  {subject.name}
                </span>
                {subject.line && (
                  <span title={subject.line} className="block truncate text-xs text-muted">
                    {subject.line}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {card.stats.length > 0 && (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {card.stats.map((s) => (
            <div key={s.label}>
              <dt className="text-xs text-muted">{s.label}</dt>
              <dd className="text-sm font-semibold tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.bars && (
        <ul className="mt-3 grid gap-1.5">
          {card.bars.map((b) => (
            <li key={b.label} className="grid grid-cols-[minmax(5rem,30%)_1fr_auto] items-center gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                {card.icons?.[b.label] && <CardImage name={b.label} image={card.icons[b.label]} size={18} />}
                <span dir="auto" title={b.label} className="truncate">
                  {b.label}
                </span>
              </span>
              <span aria-hidden className="relative block h-2 bg-line/60">
                <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${Math.min(100, Math.max(0, b.value)).toFixed(1)}%` }} />
              </span>
              <span className="text-right text-muted tabular-nums">{b.text}</span>
            </li>
          ))}
        </ul>
      )}
      {table && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-xs tabular-nums">
            <thead>
              <tr>
                {table.columns.map((c, i) => (
                  <th key={c} scope="col" className={`border-b border-line py-1.5 pr-4 text-xs font-normal tracking-wider whitespace-nowrap text-muted uppercase last:pr-0 ${table.numeric[i] ? "text-right" : "text-left"}`}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} className={`border-b border-dashed border-line py-1.5 pr-4 align-top last:pr-0 ${table.numeric[i] ? "text-right whitespace-nowrap" : "min-w-28 break-words"} ${cell == null ? "text-muted" : ""}`}>
                      {cell != null && card.icons?.[String(cell)] ? (
                        <span className="inline-flex items-center gap-2">
                          <CardImage name={String(cell)} image={card.icons[String(cell)]} size={18} />
                          {cell}
                        </span>
                      ) : (
                        shownCell(cell, locale)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-4 text-xs text-muted">
        {table && table.rows.length > CARD_ROWS && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="press inline-flex min-h-11 items-center underline decoration-line underline-offset-2 hover:text-accent sm:pointer-fine:min-h-8"
          >
            {open ? t.less : t.more(table.rows.length)}
          </button>
        )}
        {table && open && table.total > table.rows.length && <span>{t.truncated(table.rows.length, table.total)}</span>}
        {shown.sources.length > 0 && (
          <details data-how className="min-w-0">
            <summary className="press inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 hover:text-accent sm:pointer-fine:min-h-8">
              <span aria-hidden data-chevron className="inline-block">
                ›
              </span>
              {t.sources}
            </summary>
            <ul className="pb-1 leading-6">
              {shown.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-accent">
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

function Reply({ message, t, live, animated }: { message: ChatUIMessage; t: Texts; live: boolean; animated: boolean }) {
  const shownCalls = new Set(message.parts.flatMap((p) => (p.type === "data-answer" || p.type === "data-html" ? (p.id ?? []) : [])));

  const lastWork = message.parts.findLastIndex((p) => p.type.startsWith("tool-") || p.type.startsWith("data-"));
  const lastPart = message.parts.at(-1);
  const writing = lastPart?.type === "text" && lastPart.text.trim() !== "" && message.parts.length - 1 > lastWork;

  const busy = message.parts.some(
    (p) =>
      (p.type === "data-answer" && p.data.pending) ||
      ((p.type === "tool-ask_data" || p.type === "tool-run_sql" || p.type === "tool-render_html") && !shownCalls.has(p.toolCallId) && p.state !== "output-error" && p.state !== "output-available"),
  );

  const status = (key: string, label: string) => <Status key={key} label={label} />;

  const shown = message.parts.map((part, i) => {
    const key = `${message.id}-${i}`;

    if (part.type === "text" && i < lastWork) return null;

    if (part.type === "text")
      return part.text.trim() ? (
        <p key={key} dir="auto" className={`chat-prose max-w-full text-sm whitespace-pre-wrap wrap-anywhere sm:max-w-[68ch] ${animated ? "chat-in" : ""}`}>
          {part.text.trim()}
        </p>
      ) : null;

    if (part.type === "data-html")
      return (
        <Card key={key} animated={animated}>
          <HtmlFrame title={part.data.title} html={part.data.html} />
        </Card>
      );

    if (part.type === "data-answer") {
      if (part.data.pending) return live ? status(key, t.asking) : null;

      return part.data.card ? <ResultCard key={key} t={t} shown={part.data} card={part.data.card} animated={animated} /> : null;
    }

    if (part.type === "tool-ask_data" || part.type === "tool-run_sql" || part.type === "tool-render_html") {
      if (shownCalls.has(part.toolCallId)) return null;

      if (part.state === "output-error")
        return (
          <p key={key} className="text-xs text-warn">
            <span aria-hidden>!!</span> {part.errorText}
          </p>
        );

      if (!live || part.state === "output-available") return null;

      return status(key, part.type === "tool-ask_data" ? t.thinking : part.type === "tool-run_sql" ? t.querying : t.drawing);
    }

    return null;
  });

  return (
    <>
      {shown}
      {live && !busy && !writing && <Status label={t.thinking} />}
    </>
  );
}
