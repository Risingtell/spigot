"use client";

import { useEffect } from "react";

/**
 * Reveals anything carrying `.rv` as it enters the viewport, then stops watching
 * it. Elements stay visible if the observer is unavailable or motion is reduced,
 * so nothing can leave content permanently hidden.
 */
export function Reveal() {
  useEffect(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>(".rv"));
    if (!items.length) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof IntersectionObserver === "undefined") {
      for (const el of items) el.classList.add("in");
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );

    for (const el of items) io.observe(el);
    return () => io.disconnect();
  }, []);

  return null;
}
