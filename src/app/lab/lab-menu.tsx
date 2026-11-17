"use client";

import "../zod-client";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { LAB_GROUPS, LAB_VARIANTS } from "./catalog";
import "./lab.css";

/**
 * The lab's floating menu: harness chrome, not part of the design under review. A dark glass pill at the
 * bottom of the screen (same on a light or a dark page, so it never reads as the product), with the list of
 * every tool and variation above it, and a notes pad kept in this browser.
 *
 *   ← →      previous / next variation        /   open the list and search
 *   N        notes on this variation          Esc close
 *   H        hide / show the menu (it floats over the end of the page)
 */
const NOTES_KEY = "farsight-lab-notes";

const Notes = z.record(z.string(), z.string());

type Notes = z.infer<typeof Notes>;

const NOTES_EVENT = "farsight:lab-notes";

// The notes as stored (a JSON string), also kept here so they survive a browser that refuses localStorage.
let stored: string | null = null;

function storedNotes() {
  if (stored == null) {
    try {
      stored = localStorage.getItem(NOTES_KEY) ?? "{}";
    } catch {
      stored = "{}";
    }
  }

  return stored;
}

function saveNotes(notes: Notes) {
  stored = JSON.stringify(notes);

  try {
    localStorage.setItem(NOTES_KEY, stored);
  } catch {
    // Private window or full storage: the notes live until the page is closed.
  }

  window.dispatchEvent(new Event(NOTES_EVENT));
}

function subscribeNotes(onChange: () => void) {
  window.addEventListener(NOTES_EVENT, onChange);

  return () => window.removeEventListener(NOTES_EVENT, onChange);
}

function parseNotes(raw: string): Notes {
  try {
    return Notes.safeParse(JSON.parse(raw)).data ?? {};
  } catch {
    return {};
  }
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Every note, as a list to paste back: the variation, its address in the lab, the question, the remark. */
const notesMarkdown = (notes: Notes) =>
  LAB_VARIANTS.filter((v) => notes[v.id]?.trim())
    .map((v) => `- **${v.groupTitle} · ${v.label}** (\`/lab?v=${v.id}\`, « ${v.question} »)\n${notes[v.id].trim().replace(/^/gm, "  ")}`)
    .join("\n");

export function LabMenu({ index, onSelect }: { index: number; onSelect: (i: number) => void }) {
  const [panel, setPanel] = useState<"list" | "notes" | null>(null);
  const [query, setQuery] = useState("");
  const raw = useSyncExternalStore(subscribeNotes, storedNotes, () => "{}");
  const notes = useMemo(() => parseNotes(raw), [raw]);
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const pad = useRef<HTMLTextAreaElement>(null);
  const variant = LAB_VARIANTS[index];
  const noted = Object.values(notes).filter((n) => n.trim()).length;

  // Opening a panel puts the caret where typing is expected; the list also scrolls to the variation on screen.
  useEffect(() => {
    if (panel === "list") {
      search.current?.focus();
      root.current?.querySelector("[data-active]")?.scrollIntoView({ block: "center" });
    }

    if (panel === "notes") pad.current?.focus();
  }, [panel]);

  const groups = useMemo(() => {
    const q = fold(query.trim());

    return LAB_GROUPS.map((g) => ({
      ...g,
      variants: g.variants.filter((v) => !q || fold(`${g.title} ${g.id} ${v.label} ${v.question} ${v.id}`).includes(q)),
    })).filter((g) => g.variants.length > 0);
  }, [query]);

  const pick = (id: string) => {
    onSelect(LAB_VARIANTS.findIndex((v) => v.id === id));
    setPanel(null);
    setQuery("");
  };

  const write = (text: string) => {
    const next = { ...notes, [variant.id]: text };

    if (!text.trim()) delete next[variant.id];
    saveNotes(next);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(notesMarkdown(notes));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape" && panel) {
      setPanel(null);

      return;
    }

    const el = e.target instanceof HTMLElement ? e.target : null;

    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;

    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "ArrowRight") onSelect(index + 1);
    else if (e.key === "ArrowLeft") onSelect(index - 1);
    else if (e.key === "/" && !hidden) {
      e.preventDefault();
      setPanel("list");
    } else if (e.key === "h" || e.key === "H") {
      setPanel(null);
      setHidden(!hidden);
    } else if (hidden) {
      return;
    } else if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      setPanel("notes");
    }
  });

  const onOutside = useEffectEvent((e: PointerEvent) => {
    if (panel && e.target instanceof Node && !root.current?.contains(e.target)) setPanel(null);
  });

  useEffect(() => {
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, []);

  return (
    <div ref={root} className="lab-menu" hidden={hidden}>
      {panel === "list" && (
        <div className="lab-panel" role="dialog" aria-label="Outils et variations">
          <div className="lab-search">
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && groups[0]) pick(groups[0].variants[0].id);
              }}
              placeholder="Chercher un outil, une variation, une question…"
              aria-label="Chercher une variation"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="lab-count">
              {groups.reduce((n, g) => n + g.variants.length, 0)} / {LAB_VARIANTS.length}
            </span>
          </div>
          <div className="lab-list">
            {groups.map((g) => (
              <section key={g.id}>
                <h2>
                  {g.title}
                  {g.id !== "states" && <code>{g.id}</code>}
                </h2>
                <div className="lab-chips">
                  {g.variants.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className="lab-item"
                      data-active={v.id === variant.id ? "" : undefined}
                      aria-current={v.id === variant.id ? "true" : undefined}
                      title={v.question}
                      onClick={() => pick(v.id)}
                    >
                      {v.label}
                      {notes[v.id]?.trim() && <span className="lab-dot" aria-label="noté" />}
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {groups.length === 0 && <p className="lab-empty">Aucune variation pour « {query} ».</p>}
          </div>
          <p className="lab-keys">
            <kbd>←</kbd>
            <kbd>→</kbd> variation <kbd>/</kbd> chercher <kbd>N</kbd> note <kbd>H</kbd> masquer <kbd>Esc</kbd> fermer
          </p>
        </div>
      )}
      {panel === "notes" && (
        <div className="lab-panel lab-notes" role="dialog" aria-label="Notes">
          <label htmlFor="lab-note">
            Retour sur <strong>{variant.groupTitle} · {variant.label}</strong>
          </label>
          <textarea
            id="lab-note"
            ref={pad}
            value={notes[variant.id] ?? ""}
            onChange={(e) => write(e.target.value)}
            placeholder="Ce qui gêne, ce qui manque, ce qui est de trop…"
            rows={5}
          />
          <div className="lab-notes-actions">
            <span>
              {noted === 0 ? "Aucune note" : `${noted} variation${noted > 1 ? "s" : ""} notée${noted > 1 ? "s" : ""}`}, gardées dans ce navigateur
            </span>
            <button type="button" className="lab-item lab-solid" disabled={noted === 0} onClick={copy}>
              {copied ? "Copié" : "Copier tous les retours"}
            </button>
          </div>
        </div>
      )}
      <nav className="lab-pill" aria-label="Lab des affichages">
        <button type="button" className="lab-item lab-arrow" aria-label="Variation précédente (←)" onClick={() => onSelect(index - 1)}>
          ‹
        </button>
        <button
          type="button"
          className="lab-item lab-current"
          aria-expanded={panel === "list"}
          data-active={panel === "list" ? "" : undefined}
          onClick={() => setPanel(panel === "list" ? null : "list")}
        >
          <span className="lab-group">{variant.groupTitle}</span>
          <span className="lab-label">{variant.label}</span>
          <span className="lab-position">
            {index + 1}/{LAB_VARIANTS.length}
          </span>
        </button>
        <button type="button" className="lab-item lab-arrow" aria-label="Variation suivante (→)" onClick={() => onSelect(index + 1)}>
          ›
        </button>
        <span className="lab-divider" aria-hidden />
        <button
          type="button"
          className="lab-item"
          aria-expanded={panel === "notes"}
          data-active={panel === "notes" ? "" : undefined}
          onClick={() => setPanel(panel === "notes" ? null : "notes")}
        >
          Notes
          {notes[variant.id]?.trim() && <span className="lab-dot" aria-label="cette variation est notée" />}
          {noted > 0 && <span className="lab-position">{noted}</span>}
        </button>
      </nav>
    </div>
  );
}
