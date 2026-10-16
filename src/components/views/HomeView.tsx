import { ChevronRight, Fingerprint, Search, ShieldCheck } from "lucide-react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ShortcutHint } from "../ui/ShortcutHint";
import { TOOLS, TOOL_GROUPS, toolsInGroup, groupHue, type ToolGroupId } from "../layout/tools";
import "./HomeView.css";

interface HomeViewProps {
  setTab: (tab: string) => void;
  /** Opens the jump bar. The search button is left out when this is not given. */
  onOpenPalette?: () => void;
  /** Whether the current keychain has been backed up. The protection panel is left out when unknown. */
  backupDone?: boolean;
  onBackup?: () => void;
  /** Tool ids opened since the app was unlocked, newest first. */
  recent?: string[];
}

// How each tool is introduced on this screen.
const COPY: Record<string, { title: string; desc: string }> = {
  files: { title: "Encrypt Files", desc: "AES-256-GCM encryption." },
  notes: { title: "Secure Notes", desc: "Encrypted private notepad." },
  vault: { title: "Passwords", desc: "Offline credential vault." },
  bookmarks: { title: "Bookmarks", desc: "Private encrypted links." },
  clipboard: { title: "Clipboard", desc: "Secure copy & history." },
  breach: { title: "Privacy Check", desc: "Check leaks & IP exposure." },
  hash: { title: "Integrity Check", desc: "Verify file hashes." },
  sysclean: { title: "System Clean", desc: "Clear temp & cache." },
  cleaner: { title: "Metadata Cleaner", desc: "Strip hidden metadata from any file." },
  shred: { title: "Shredder", desc: "Permanently destroy files." },
  analyzer: { title: "File Analyzer", desc: "Detect fake extensions." },
  qr: { title: "QR Generator", desc: "Offline QR creation." },
};

/** A greeting for the time of day, such as "Good evening". */
export function greeting(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

export function HomeView({ setTab, onOpenPalette, backupDone, onBackup, recent = [] }: HomeViewProps) {
  const recentTools = recent
    .map((id) => TOOLS.find((t) => t.id === id))
    .filter((t): t is (typeof TOOLS)[number] => t !== undefined)
    .slice(0, 3);
  const showProtection = backupDone !== undefined;

  function group(id: ToolGroupId) {
    const info = TOOL_GROUPS.find((g) => g.id === id)!;
    const tools = toolsInGroup(id);
    return (
      <section className="home-group" aria-labelledby={`home-group-${id}`}>
        <div className="home-group__head" style={{ ["--tile-hue" as string]: groupHue(id) }}>
          <i className="home-group__dot" aria-hidden="true" />
          <h2 id={`home-group-${id}`} className="home-group__title">
            {info.label}
          </h2>
          <span className="home-group__blurb">{info.blurb}</span>
        </div>
        <div className="home-group__tiles">
          {tools.map((t) => {
            const copy = COPY[t.id] ?? { title: t.label, desc: t.desc };
            return (
              <button
                key={t.id}
                className="home-card home-tile"
                style={{ ["--tile-hue" as string]: groupHue(t.group) }}
                // The tooltip keeps the description available when a short window hides it.
                title={copy.desc}
                onClick={() => setTab(t.id)}
              >
                <span className="home-tile__icon" aria-hidden="true">
                  <t.Icon size={22} />
                </span>
                <span className="home-tile__text">
                  <span className="home-tile__title" role="heading" aria-level={3}>
                    {copy.title}
                  </span>
                  <span className="home-tile__desc">{copy.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <div className="home">
      <div className="home__inner">
        <header className="home__hero">
          <div className="home__brand">
            <div className="home__logo" aria-hidden="true">
              <Fingerprint size={30} strokeWidth={2} />
            </div>
            <div>
              <h1 className="home__title">QRE Privacy Toolkit</h1>
              <p className="home__subtitle">{greeting()}. Everything is stored on this device.</p>
            </div>
          </div>

          {onOpenPalette && (
            <button className="home__jump" onClick={onOpenPalette} aria-label="Jump to a tool or action">
              <Search size={16} aria-hidden="true" />
              <span className="home__jump-label">Jump to a tool or action</span>
              <ShortcutHint shortcut="Mod+K" />
            </button>
          )}
        </header>

        {/* Three columns of equal tiles. The block is centred in the window, and the tiles
            grow with its height. */}
        <div className="home__columns">
          <div className="home__col">{group("protect")}</div>

          <div className="home__col">
            {group("inspect")}
            {group("create")}
            <Card as="section" padding="sm" className="home-panel home-recent-panel" aria-labelledby="home-recent">
              <h2 id="home-recent" className="home-panel__title">
                Pick up where you left off
              </h2>
              {recentTools.length === 0 ? (
                <p className="home-panel__empty">
                  The tools you open appear here. The list is kept in memory only and is cleared when the app locks.
                </p>
              ) : (
                <ul className="home-panel__list">
                  {recentTools.map((t) => (
                    <li key={t.id}>
                      <button
                        className="home-recent"
                        style={{ ["--tile-hue" as string]: groupHue(t.group) }}
                        onClick={() => setTab(t.id)}
                      >
                        <span className="home-tile__icon home-tile__icon--small" aria-hidden="true">
                          <t.Icon size={16} />
                        </span>
                        <span className="home-panel__text">{COPY[t.id]?.title ?? t.label}</span>
                        <ChevronRight size={16} aria-hidden="true" className="home-recent__go" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="home__col">
            {group("clean")}
            {showProtection && (
              <Card as="section" padding="sm" className="home-panel home-protection" aria-labelledby="home-protection">
                <div className="home-panel__head">
                  <h2 id="home-protection" className="home-panel__title">
                    <ShieldCheck size={16} aria-hidden="true" /> Protection
                  </h2>
                  {backupDone ? <Badge tone="ok">All set</Badge> : <Badge tone="warn">1 to do</Badge>}
                </div>
                <ul className="home-panel__list">
                  <li className="home-panel__row">
                    <Badge tone={backupDone ? "ok" : "warn"}>{backupDone ? "Done" : "To do"}</Badge>
                    <span className="home-panel__text">
                      {backupDone ? "Keychain backed up" : "Back up your keychain"}
                    </span>
                    {!backupDone && onBackup && (
                      <Button size="sm" variant="primary" onClick={onBackup}>
                        Back up now
                      </Button>
                    )}
                  </li>
                  <li className="home-panel__row">
                    <Badge tone="ok">On</Badge>
                    <span className="home-panel__text">Locks after 15 minutes of inactivity</span>
                  </li>
                  <li className="home-panel__row">
                    <Badge tone="ok">On</Badge>
                    <span className="home-panel__text">Copied secrets are wiped after 30 seconds</span>
                  </li>
                </ul>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
