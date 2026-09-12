"use client";

import { Moon, Sun } from "lucide-react";

/**
 * No state and no effect: the current theme lives on <html data-theme>, and CSS
 * decides which icon shows. That keeps the button identical on server and
 * client, so there is nothing to hydrate and nothing to flash.
 */
export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const current =
      root.dataset.theme ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* private mode: the toggle still works for this page view */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Switch between light and dark theme"
      className="grid size-11 place-items-center rounded-[var(--radius)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
    >
      <Moon size={16} className="theme-icon-moon" />
      <Sun size={16} className="theme-icon-sun" />
    </button>
  );
}
