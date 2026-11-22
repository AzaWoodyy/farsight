"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const THEME_ATTRIBUTE = "data-theme";
const MAX_HEIGHT = 1600;

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function documentAround(fragment: string): string {
  const root = document.documentElement;
  const sheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((l) => `<link rel="stylesheet" href="${escapeAttribute(l.href)}">`);
  const inline = [...document.querySelectorAll("style")].map((s) => `<style>${(s.textContent ?? "").replace(/<\/style/gi, "")}</style>`);
  const theme = root.getAttribute(THEME_ATTRIBUTE);

  return (
    `<!doctype html><html lang="${escapeAttribute(root.lang)}" class="${escapeAttribute(root.className)} kit-document"${theme ? ` ${THEME_ATTRIBUTE}="${escapeAttribute(theme)}"` : ""}>` +
    `<head><meta charset="utf-8">${sheets.join("")}${inline.join("")}</head><body><div class="kit" id="kit">${fragment}</div></body></html>`
  );
}

export function HtmlFrame({ title, html }: { title: string; html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setSrcDoc(documentAround(html)));

    return () => cancelAnimationFrame(id);
  }, [html]);

  const watch = useMemo(
    () => () => {
      const inner = frame.current?.contentDocument;
      const kit = inner?.getElementById("kit");

      if (!inner || !kit) return () => {};

      const measure = () => setHeight(Math.min(MAX_HEIGHT, Math.ceil(kit.getBoundingClientRect().height) + 4));
      const sized = new ResizeObserver(measure);

      sized.observe(kit);
      measure();

      const themed = new MutationObserver(() => {
        const theme = document.documentElement.getAttribute(THEME_ATTRIBUTE);

        if (theme) inner.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
        else inner.documentElement.removeAttribute(THEME_ATTRIBUTE);
      });

      themed.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTRIBUTE] });

      return () => {
        sized.disconnect();
        themed.disconnect();
      };
    },
    [],
  );

  const stop = useRef<() => void>(() => {});

  useEffect(() => () => stop.current(), []);

  return (
    <figure>
      <figcaption className="text-sm font-semibold text-balance">
        <span className="text-accent">#</span> {title}
      </figcaption>
      {srcDoc && (
        <iframe
          ref={frame}
          title={title}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          onLoad={() => {
            stop.current();
            stop.current = watch();
          }}
          style={{ height }}
          className="mt-3 block w-full border-0"
        />
      )}
    </figure>
  );
}
