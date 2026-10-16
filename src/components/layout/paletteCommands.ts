import type { ReactNode } from "react";

/** One thing the jump bar can do: open a tool, or run an action such as locking the app. */
export interface PaletteCommand {
  id: string;
  label: string;
  /** The section it is listed under when nothing has been typed. */
  section: string;
  /** Extra words that also find it. */
  keywords?: string[];
  icon?: ReactNode;
  /** A short hint shown on the right, such as the group name. */
  hint?: string;
  run: () => void;
}

/**
 * Picks the commands that match what was typed, best match first.
 *
 * Every word typed must match, in any order, ignoring case. A word matches anywhere in
 * the label, but only at the start of a keyword, so "sh" finds the Shredder and not Home
 * (whose hidden keyword is "dashboard"). A label that starts with the text ranks first,
 * then a word that starts with it, then any other match in the label, then a match in the
 * keywords only. Commands that rank the same keep the order they were given in.
 */
export function filterCommands<T extends PaletteCommand>(commands: ReadonlyArray<T>, query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];

  const scored: Array<{ command: T; score: number; index: number }> = [];
  commands.forEach((command, index) => {
    const label = command.label.toLowerCase();
    const keywordWords = (command.keywords ?? []).flatMap((k) => k.toLowerCase().split(/[\s-]+/));
    if (!words.every((w) => label.includes(w) || keywordWords.some((k) => k.startsWith(w)))) return;

    const labelWords = label.split(/[\s-]+/);
    let score = 3;
    if (words.every((w) => label.includes(w))) {
      if (label.startsWith(words[0])) score = 0;
      else if (words.every((w) => labelWords.some((lw) => lw.startsWith(w)))) score = 1;
      else score = 2;
    }
    scored.push({ command, score, index });
  });

  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((s) => s.command);
}
