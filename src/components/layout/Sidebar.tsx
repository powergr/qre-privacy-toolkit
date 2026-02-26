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
  RefreshCw,
  StickyNote,
  Radar,
  Eraser,
  ClipboardList,
  QrCode,
  Bookmark,
  FileCheck,
  ChevronRight,
  Brush,
  FileSearch,
} from "lucide-react";

interface SidebarProps {
  activeTab: string;
  setTab: (t: string) => void;
  // Kept for desktop popup menus (still work fine on desktop)
  onOpenHelpModal: () => void;
  onOpenAboutModal: () => void;
  onLogout: () => void;
  onTheme: () => void;
  onBackup: () => void;
  onChangePassword: () => void;
  onReset2FA: () => void;
  onUpdate: () => void;
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
  onUpdate,
}: SidebarProps) {
  const [menuState, setMenuState] = useState<"none" | "help" | "settings">(
    "none",
  );
  const helpRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Close menus when tab changes
  useEffect(() => {
    setMenuState("none");
  }, [activeTab]);

  // Click outside to close desktop menus
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        menuState === "help" &&
        helpRef.current &&
        !helpRef.current.contains(event.target as Node)
      ) {
        setMenuState("none");
      }
      if (
        menuState === "settings" &&
        settingsRef.current &&
        !settingsRef.current.contains(event.target as Node)
      ) {
        setMenuState("none");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuState]);

  // Grouped Tabs
  const groups = [
    {
      items: [
        {
          id: "home",
          label: "Home",
          icon: <Home size={20} strokeWidth={2.5} />,
          desc: "Dashboard",
        },
        {
          id: "files",
          label: "Files",
          icon: <Lock size={20} strokeWidth={2.5} />,
          desc: "Encrypt files",
        },
      ],
    },
    {
      items: [
        {
          id: "notes",
          label: "Notes",
          icon: <StickyNote size={20} strokeWidth={2.5} />,
          desc: "Secure notepad",
        },
        {
          id: "vault",
          label: "Passwords",
          icon: <Key size={20} strokeWidth={2.5} />,
          desc: "Credentials",
        },
        {
          id: "bookmarks",
          label: "Bookmarks",
          icon: <Bookmark size={20} strokeWidth={2.5} />,
          desc: "Private links",
        },
        {
          id: "clipboard",
          label: "Clipboard",
          icon: <ClipboardList size={20} strokeWidth={2.5} />,
          desc: "Copy history",
        },
      ],
    },
    {
      items: [
        {
          id: "breach",
          label: "Privacy",
          icon: <Radar size={20} strokeWidth={2.5} />,
          desc: "Leak check",
        },
        {
          id: "hash",
          label: "Integrity",
          icon: <FileCheck size={20} strokeWidth={2.5} />,
          desc: "Verify hashes",
        },
        {
          id: "sysclean",
          label: "Clean",
          icon: <Brush size={20} strokeWidth={2.5} />,
          desc: "System cleaner",
        },
        {
          id: "cleaner",
          label: "Meta",
          icon: <Eraser size={20} strokeWidth={2.5} />,
          desc: "Meta wiper",
        },
        {
          id: "shred",
          label: "Shred",
          icon: <Trash2 size={20} strokeWidth={2.5} />,
          desc: "Delete",
        },
        {
          id: "analyzer",
          label: "Analyzer",
          icon: <FileSearch size={20} strokeWidth={2.5} />,
          desc: "File analysis",
        },
        {
          id: "qr",
          label: "QR Code",
          icon: <QrCode size={20} strokeWidth={2.5} />,
          desc: "QR generator",
        },
      ],
    },
  ];

  return (
    <div className="sidebar">
      <div className="nav-links sidebar-scroll-area">
        {groups.map((group, index) => (
          <div key={index} className="nav-group-wrapper">
            <div className="nav-group">
              {group.items.map((t) => (
                <button
                  key={t.id}
                  className={`nav-btn ${activeTab === t.id ? "active" : ""}`}
                  onClick={() => setTab(t.id)}
                  title={t.desc}
                >
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="sidebar-bottom">
        {/* HELP — desktop: popup menu | mobile: navigate to help tab */}
        <div style={{ position: "relative" }} ref={helpRef}>
          {menuState === "help" && (
            <div className="desktop-popup-menu">
              <button
                className="dropdown-item"
                onClick={() => {
                  setMenuState("none");
                  onOpenHelpModal();
                }}
              >
                <BookOpen size={16} /> Help Topics
              </button>
              <div className="dropdown-divider" />
              <button
                className="dropdown-item"
                onClick={() => {
                  setMenuState("none");
                  onOpenAboutModal();
                }}
              >
                <Info size={16} /> About
              </button>
            </div>
          )}
          <button
            className={`nav-btn btn-split ${
              activeTab === "help" || menuState === "help" ? "menu-open" : ""
            }`}
            onClick={(e) => {
              e.stopPropagation();
              // Mobile: go to help tab. Desktop (has hover): open popup.
              if (window.matchMedia("(max-width: 600px)").matches) {
                setTab("help");
              } else {
                setMenuState(menuState === "help" ? "none" : "help");
              }
            }}
          >
            <div className="btn-inner">
              <CircleHelp size={20} strokeWidth={2.5} />
              <span>Help</span>
            </div>
            <ChevronRight size={16} className="chevron" />
          </button>
        </div>

        {/* SETTINGS — desktop: popup menu | mobile: navigate to settings tab */}
        <div style={{ position: "relative" }} ref={settingsRef}>
          {menuState === "settings" && (
            <div className="desktop-popup-menu">
              <button
                className="dropdown-item"
                onClick={() => {
                  setMenuState("none");
                  onTheme();
                }}
              >
                <Monitor size={16} /> Theme
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  setMenuState("none");
                  onBackup();
                }}
              >
                <Download size={16} /> Backup
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  setMenuState("none");
                  onChangePassword();
                }}
              >
                <Key size={16} /> Password
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  setMenuState("none");
                  onReset2FA();
                }}
              >
                <RotateCcw size={16} color="var(--warning)" /> Reset 2FA
              </button>
              <div className="dropdown-divider" />
              <button
                className="dropdown-item"
                onClick={() => {
                  setMenuState("none");
                  onUpdate();
                }}
              >
                <RefreshCw size={16} /> Updates
              </button>
              <div className="dropdown-divider" />
              <button
                className="dropdown-item"
                onClick={() => {
                  setMenuState("none");
                  onLogout();
                }}
                style={{ color: "var(--btn-danger)" }}
              >
                <LogOut size={16} /> Log Out
              </button>
            </div>
          )}
          <button
            className={`nav-btn btn-split ${
              activeTab === "settings" || menuState === "settings"
                ? "menu-open"
                : ""
            }`}
            onClick={(e) => {
              e.stopPropagation();
              // Mobile: go to settings tab. Desktop: open popup.
              if (window.matchMedia("(max-width: 600px)").matches) {
                setTab("settings");
              } else {
                setMenuState(menuState === "settings" ? "none" : "settings");
              }
            }}
          >
            <div className="btn-inner">
              <Settings size={20} strokeWidth={2.5} />
              <span>Settings</span>
            </div>
            <ChevronRight size={16} className="chevron" />
          </button>
        </div>
      </div>
    </div>
  );
}
