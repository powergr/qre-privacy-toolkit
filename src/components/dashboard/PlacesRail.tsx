import { useEffect, useState, type ReactNode } from "react";
import { Home, Monitor, FileText, Download } from "lucide-react";
import { homeDir, desktopDir, documentDir, downloadDir } from "@tauri-apps/api/path";
import "./PlacesRail.css";

interface Place {
  id: string;
  label: string;
  path: string;
  icon: ReactNode;
}

interface PlacesRailProps {
  /** The folder being shown, so its place can be marked. */
  currentPath: string;
  onNavigate: (path: string) => void;
}

/** Same folder whatever the slashes, trailing separator or letter case (Windows paths). */
export function samePlace(a: string, b: string): boolean {
  const clean = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return clean(a) === clean(b) && clean(a) !== "";
}

const SOURCES: { id: string; label: string; icon: ReactNode; resolve: () => Promise<string> }[] = [
  { id: "home", label: "Home", icon: <Home size={16} />, resolve: homeDir },
  { id: "desktop", label: "Desktop", icon: <Monitor size={16} />, resolve: desktopDir },
  { id: "documents", label: "Documents", icon: <FileText size={16} />, resolve: documentDir },
  { id: "downloads", label: "Downloads", icon: <Download size={16} />, resolve: downloadDir },
];

/**
 * A short list of the folders people open most, so getting there is one click instead of
 * typing a path. A folder the system cannot name is left out rather than shown dead.
 */
export function PlacesRail({ currentPath, onNavigate }: PlacesRailProps) {
  const [places, setPlaces] = useState<Place[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      SOURCES.map(async (s): Promise<Place | null> => {
        try {
          const path = await s.resolve();
          return path ? { id: s.id, label: s.label, path, icon: s.icon } : null;
        } catch {
          return null;
        }
      }),
    ).then((found) => {
      if (!cancelled) setPlaces(found.filter((p): p is Place => p !== null));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (places.length === 0) return null;

  return (
    <nav className="places-rail" aria-label="Places">
      <div className="places-rail__title">Places</div>
      {places.map((p) => {
        const active = samePlace(p.path, currentPath);
        return (
          <button
            key={p.id}
            type="button"
            className={`places-rail__item${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => onNavigate(p.path)}
          >
            {p.icon}
            <span>{p.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
