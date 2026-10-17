import { Home, Lock, Key, LayoutGrid, Ellipsis, type LucideIcon } from "lucide-react";
import "./BottomBar.css";

interface BottomBarProps {
  activeTab: string;
  setTab: (tab: string) => void;
}

interface Destination {
  id: string;
  label: string;
  Icon: LucideIcon;
  /** Tab ids this destination counts as being on. */
  covers: (tab: string) => boolean;
}

/** The five places a thumb can reach on a phone. Every other tool is under Tools. */
const MAIN = ["home", "files", "vault"];
const MORE = ["settings", "help"];

const DESTINATIONS: ReadonlyArray<Destination> = [
  { id: "home", label: "Home", Icon: Home, covers: (t) => t === "home" },
  { id: "files", label: "Files", Icon: Lock, covers: (t) => t === "files" },
  { id: "vault", label: "Passwords", Icon: Key, covers: (t) => t === "vault" },
  {
    id: "tools",
    label: "Tools",
    Icon: LayoutGrid,
    covers: (t) => !MAIN.includes(t) && !MORE.includes(t),
  },
  { id: "settings", label: "More", Icon: Ellipsis, covers: (t) => MORE.includes(t) },
];

/**
 * The phone's navigation: five large buttons at the bottom of the screen. Tools opens the
 * list of the remaining tools and stays marked while any of them is open.
 */
export function BottomBar({ activeTab, setTab }: BottomBarProps) {
  return (
    <nav className="bottom-bar" aria-label="Main">
      {DESTINATIONS.map(({ id, label, Icon, covers }) => {
        const active = covers(activeTab);
        return (
          <button
            key={id}
            type="button"
            className={`bottom-bar__item${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            <Icon size={22} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
