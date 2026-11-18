"use client";

import { useEffect } from "react";
import { decode } from "./decode";

/**
 * Plays the arrival in a new language: the letters of the page shuffle, then settle into the translation.
 * It waits for hydration, since React owns the text from there, and then ends the view transition that kept
 * the previous language on screen (see ARRIVAL_SCRIPT). With reduced motion the page is simply shown.
 */
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
