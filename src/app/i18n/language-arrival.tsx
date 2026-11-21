"use client";

import { useEffect } from "react";
import { decode } from "./decode";

export function LanguageArrival() {
  useEffect(() => {
    const arrival = window.__langArrival;

    if (!arrival) return;

    window.__langArrival = null;

    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) decode(document.body);

    arrival.transition?.skipTransition();
  }, []);

  return null;
}
