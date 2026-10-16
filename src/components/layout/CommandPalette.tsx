import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useShortcut } from "../../hooks/useShortcut";
import { useFocusTrap } from "../ui/useFocusTrap";
import { filterCommands, type PaletteCommand } from "./paletteCommands";
import "./CommandPalette.css";

interface CommandPaletteProps {
  commands: ReadonlyArray<PaletteCommand>;
  onClose: () => void;
}

/**
 * The jump bar (Ctrl K). Type a few letters, press Enter, and the tool opens or the action
 * runs. It lists tools and actions only. It never looks inside passwords or notes.
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const searching = query.trim().length > 0;

  // Escape closes it. Pressing Ctrl K again closes it too.
  useEscapeKey(onClose);
  useShortcut("k", onClose, { allowInDialog: true });
  useFocusTrap(panel, true);

  // A new search starts at the best match.
  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view while moving with the arrow keys.
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active, results]);

  function run(command: PaletteCommand | undefined) {
    if (!command) return;
    // Close first, so an action that opens a dialog is not closed along with this bar.
    onClose();
    command.run();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length) setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;
  let lastSection = "";

  return (
    <div
      className="modal-overlay palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panel} className="palette" role="dialog" aria-modal="true" aria-label="Jump to a tool or action" tabIndex={-1}>
        <div className="palette__search">
          <Search size={18} aria-hidden="true" />
          <input
            data-autofocus
            className="palette__input"
            placeholder="Jump to a tool or action"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? optionId(active) : undefined}
            aria-label="Jump to a tool or action"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div ref={list} id={listId} className="palette__list" role="listbox" aria-label="Results">
          {results.length === 0 && (
            <p className="palette__empty" role="status">
              Nothing matches “{query.trim()}”. Try a tool name, or a word like “password” or “wifi”.
            </p>
          )}
          {results.map((c, i) => {
            const heading = !searching && c.section !== lastSection ? c.section : null;
            lastSection = c.section;
            return (
              <div key={c.id} role="presentation">
                {heading && (
                  <div className="palette__section" role="presentation">
                    {heading}
                  </div>
                )}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  className={`palette__row ${i === active ? "palette__row--active" : ""}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => run(c)}
                >
                  <span className="palette__icon" aria-hidden="true">
                    {c.icon}
                  </span>
                  <span className="palette__label">{c.label}</span>
                  {(c.hint || searching) && <span className="palette__hint">{searching ? c.section : c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="palette__foot" aria-hidden="true">
          <span>
            <kbd className="ui-kbd">↑</kbd> <kbd className="ui-kbd">↓</kbd> move
          </span>
          <span>
            <kbd className="ui-kbd">Enter</kbd> open
          </span>
          <span>
            <kbd className="ui-kbd">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
