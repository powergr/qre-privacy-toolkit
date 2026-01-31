import { useState, useRef, useEffect } from "react";
import {
  Lock,
  Trash2,
  Key,
  Home,
  CircleHelp,
  BookOpen,
  Info,
  LogOut,
  Settings,
  Monitor,
  Download,
  RotateCcw,
  StickyNote,
  Radar,
  Eraser,
  ClipboardList,
  ChevronRight,
  QrCode,
  Bookmark,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

interface SidebarProps {
  activeTab: string;
  setTab: (t: string) => void;
  onOpenHelpModal: () => void;
  onOpenAboutModal: () => void;
  onLogout: () => void;

  onTheme: () => void;
  onBackup: () => void;
  onChangePassword: () => void;
  onReset2FA: () => void;
}

export function Sidebar({
  activeTab,
  setTab,
  onOpenHelpModal,
  onOpenAboutModal,
  onLogout,
  onTheme,
  onBackup,
  onChangePassword,
  onReset2FA,
}: SidebarProps) {
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);

  const helpRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);

  const tabs = [
    { id: "home", label: "Home", icon: <Home size={22} strokeWidth={2.5} /> },
    { id: "files", label: "Files", icon: <Lock size={22} strokeWidth={2.5} /> },
    {
      id: "notes",
      label: "Notes",
      icon: <StickyNote size={22} strokeWidth={2.5} />,
    },
    {
      id: "vault",
      label: "Passwords",
      icon: <Key size={22} strokeWidth={2.5} />,
    },
    {
      id: "bookmarks",
      label: "Bookmarks",
      icon: <Bookmark size={22} strokeWidth={2.5} />,
    },
    {
      id: "clipboard",
      label: "Clipboard",
      icon: <ClipboardList size={22} strokeWidth={2.5} />,
    },
    {
      id: "breach",
      label: "Privacy Check",
      icon: <Radar size={22} strokeWidth={2.5} />,
    },
    {
      id: "cleaner",
      label: "Cleaner",
      icon: <Eraser size={22} strokeWidth={2.5} />,
    },
    {
      id: "shred",
      label: "Shredder",
      icon: <Trash2 size={22} strokeWidth={2.5} />,
    },
    {
      id: "qr",
      label: "QR Gen",
      icon: <QrCode size={22} strokeWidth={2.5} />,
    },
  ];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (helpRef.current && !helpRef.current.contains(event.target as Node)) {
        setShowHelpMenu(false);
      }
      if (
        optionsRef.current &&
        !optionsRef.current.contains(event.target as Node)
      ) {
        setShowOptionsMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="sidebar">
      {/* --- TOP NAVIGATION --- */}
      <div className="nav-links">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`nav-btn ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: "auto" }}></div>

      {/* --- BOTTOM SECTION --- */}
      <div className="sidebar-bottom">
        {/* 1. HELP MENU */}
        <div style={{ position: "relative", width: "100%" }} ref={helpRef}>
          {showHelpMenu && (
            <div className="help-menu">
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowHelpMenu(false);
                  onOpenHelpModal();
                }}
              >
                <BookOpen size={16} /> Help Topics
              </div>
              <div
                className="dropdown-item"
                onClick={async () => {
                  setShowHelpMenu(false);
                  try {
                    await openUrl(
                      "https://github.com/powergr/qre-privacy-toolkit/",
                    );
                  } catch (e) {
                    console.error(e);
                  }
                }}
              >
                <GithubIcon size={16} /> GitHub Page
              </div>
              <div className="dropdown-divider"></div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowHelpMenu(false);
                  onOpenAboutModal();
                }}
              >
                <Info size={16} /> About
              </div>
            </div>
          )}

          {/* FIX: Removed inline style, added 'btn-split' class, replaced inline inner div style with class */}
          <button
            className={`nav-btn btn-split ${showHelpMenu ? "menu-open" : ""}`}
            onClick={() => {
              setShowHelpMenu(!showHelpMenu);
              setShowOptionsMenu(false);
            }}
          >
            <div className="btn-inner">
              <CircleHelp size={22} strokeWidth={2.5} />
              <span>Help</span>
            </div>
            {showHelpMenu && (
              <ChevronRight
                size={16}
                style={{ opacity: 0.7 }}
                className="chevron"
              />
            )}
          </button>
        </div>

        {/* 2. OPTIONS MENU */}
        <div style={{ position: "relative", width: "100%" }} ref={optionsRef}>
          {showOptionsMenu && (
            <div className="help-menu">
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowOptionsMenu(false);
                  onTheme();
                }}
              >
                <Monitor size={16} /> Theme
              </div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowOptionsMenu(false);
                  onBackup();
                }}
              >
                <Download size={16} /> Backup Keychain
              </div>
              <div className="dropdown-divider"></div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowOptionsMenu(false);
                  onChangePassword();
                }}
              >
                <Key size={16} /> Change Password
              </div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowOptionsMenu(false);
                  onReset2FA();
                }}
              >
                <RotateCcw size={16} color="var(--warning)" /> Reset 2FA Code
              </div>
            </div>
          )}

          {/* FIX: Removed inline style, added 'btn-split' class */}
          <button
            className={`nav-btn btn-split ${showOptionsMenu ? "menu-open" : ""}`}
            onClick={() => {
              setShowOptionsMenu(!showOptionsMenu);
              setShowHelpMenu(false);
            }}
          >
            <div className="btn-inner">
              <Settings size={22} strokeWidth={2.5} />
              <span>Options</span>
            </div>
            {showOptionsMenu && (
              <ChevronRight
                size={16}
                style={{ opacity: 0.7 }}
                className="chevron"
              />
            )}
          </button>
        </div>

        {/* 3. LOG OUT */}
        <button
          className="nav-btn"
          onClick={onLogout}
          style={{ color: "#d94040" }}
        >
          <LogOut size={22} strokeWidth={2.5} />
          <span>Log Out</span>
        </button>
      </div>
    </div>
  );
}

function GithubIcon({
  size = 24,
  color = "currentColor",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}
