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
  QrCode,
  Bookmark,
  RefreshCw,
  FileCheck,
  ChevronRight,
  Brush,
  FileSearch,
} from "lucide-react";
import { UniversalUpdateModal } from "../modals/UniversalUpdateModal";

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
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  const helpRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Grouped Tabs
  const groups = [
    {
      items: [
        {
          id: "home",
          label: "Home",
          icon: <Home size={20} strokeWidth={2.5} />,
          desc: "Dashboard overview",
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
          desc: "Password manager",
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
          desc: "Metadata wiper",
        },
        {
          id: "shred",
          label: "Shred",
          icon: <Trash2 size={20} strokeWidth={2.5} />,
          desc: "Delete forever",
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

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (helpRef.current && !helpRef.current.contains(event.target as Node)) {
        setShowHelpMenu(false);
      }
      if (
        settingsRef.current &&
        !settingsRef.current.contains(event.target as Node)
      ) {
        setShowSettingsMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <>
      <div className="sidebar">
        {/* SCROLL AREA */}
        <div className="nav-links sidebar-scroll-area">
          {groups.map((group, index) => (
            <div key={index}>
              {/* Divider (Desktop Only - handled by CSS) */}
              {index > 0 && <div className="group-divider"></div>}

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
          ))}
        </div>

        {/* BOTTOM SECTION */}
        <div className="sidebar-bottom">
          {/* HELP MENU */}
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
            <button
              className={`nav-btn btn-split ${showHelpMenu ? "menu-open" : ""}`}
              onClick={() => {
                setShowHelpMenu(!showHelpMenu);
                setShowSettingsMenu(false);
              }}
            >
              <div className="btn-inner">
                <CircleHelp size={20} strokeWidth={2.5} />
                <span>Help</span>
              </div>
              {showHelpMenu && <ChevronRight size={16} className="chevron" />}
            </button>
          </div>

          {/* SETTINGS MENU */}
          <div
            style={{ position: "relative", width: "100%" }}
            ref={settingsRef}
          >
            {showSettingsMenu && (
              <div className="help-menu">
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowSettingsMenu(false);
                    onTheme();
                  }}
                >
                  <Monitor size={16} /> Theme
                </div>
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowSettingsMenu(false);
                    onBackup();
                  }}
                >
                  <Download size={16} /> Backup Keychain
                </div>
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowSettingsMenu(false);
                    onChangePassword();
                  }}
                >
                  <Key size={16} /> Change Password
                </div>
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowSettingsMenu(false);
                    onReset2FA();
                  }}
                >
                  <RotateCcw size={16} color="var(--warning)" /> Reset 2FA
                </div>
                <div className="dropdown-divider"></div>
                <div
                  className="dropdown-item"
                  onClick={() => {
                    setShowSettingsMenu(false);
                    setShowUpdateModal(true);
                  }}
                >
                  <RefreshCw size={16} /> Check for Updates
                </div>
                <div className="dropdown-divider"></div>
                <div
                  className="dropdown-item"
                  onClick={onLogout}
                  style={{ color: "var(--btn-danger)" }}
                >
                  <LogOut size={16} /> Log Out
                </div>
              </div>
            )}
            <button
              className={`nav-btn btn-split ${showSettingsMenu ? "menu-open" : ""}`}
              onClick={() => {
                setShowSettingsMenu(!showSettingsMenu);
                setShowHelpMenu(false);
              }}
            >
              <div className="btn-inner">
                <Settings size={20} strokeWidth={2.5} />
                <span>Settings</span>
              </div>
              {showSettingsMenu && (
                <ChevronRight size={16} className="chevron" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* UPDATE MODAL (Universal) */}
      {showUpdateModal && (
        <UniversalUpdateModal onClose={() => setShowUpdateModal(false)} />
      )}
    </>
  );
}
