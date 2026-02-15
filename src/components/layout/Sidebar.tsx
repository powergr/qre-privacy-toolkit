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
import { UpdateModal } from "../modals/UpdateModal";

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

  // Grouped Tabs with Descriptions for Tooltips
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
          desc: "Encrypt and decrypt files",
        },
      ],
    },
    {
      items: [
        {
          id: "notes",
          label: "Notes",
          icon: <StickyNote size={20} strokeWidth={2.5} />,
          desc: "Secure encrypted notepad",
        },
        {
          id: "vault",
          label: "Passwords",
          icon: <Key size={20} strokeWidth={2.5} />,
          desc: "Manage logins and secrets",
        },
        {
          id: "bookmarks",
          label: "Bookmarks",
          icon: <Bookmark size={20} strokeWidth={2.5} />,
          desc: "Private encrypted links",
        },
        {
          id: "clipboard",
          label: "Clipboard",
          icon: <ClipboardList size={20} strokeWidth={2.5} />,
          desc: "Secure copy/paste history",
        },
      ],
    },
    {
      items: [
        {
          id: "breach",
          label: "Privacy Check",
          icon: <Radar size={20} strokeWidth={2.5} />,
          desc: "Check for data leaks and IP exposure",
        },
        {
          id: "hash",
          label: "Integrity Check",
          icon: <FileCheck size={20} strokeWidth={2.5} />,
          desc: "Verify file hashes",
        },
        {
          id: "sysclean",
          label: "System Clean",
          icon: <Brush size={20} strokeWidth={2.5} />,
          desc: "Clear temp files and history",
        },
        {
          id: "cleaner",
          label: "Meta Cleaner",
          icon: <Eraser size={20} strokeWidth={2.5} />,
          desc: "Remove metadata from photos/docs",
        },
        {
          id: "shred",
          label: "Shredder",
          icon: <Trash2 size={20} strokeWidth={2.5} />,
          desc: "Permanently delete files",
        },
        {
          id: "analyzer",
          label: "File Analyzer",
          icon: <FileSearch size={20} strokeWidth={2.5} />,
          desc: "Detect fake extensions & malware types",
        },
        {
          id: "qr",
          label: "QR Generator",
          icon: <QrCode size={20} strokeWidth={2.5} />,
          desc: "Generate secure QR codes offline",
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
      <div className="sidebar" style={{ width: "220px", padding: "15px 10px" }}>
        {/* NAVIGATION LIST */}
        <div
          className="nav-links"
          style={{ overflowY: "auto", flex: 1, paddingBottom: 10 }}
        >
          {groups.map((group, index) => (
            <div key={index}>
              {/* Spacer/Divider between groups */}
              {index > 0 && (
                <div
                  style={{
                    height: 1,
                    background: "var(--border)",
                    margin: "10px 10px 10px 10px",
                    opacity: 0.3,
                  }}
                ></div>
              )}

              {/* Safe Mapping: Now we are guaranteed 'group.items' exists */}
              {group.items.map((t) => (
                <button
                  key={t.id}
                  className={`nav-btn ${activeTab === t.id ? "active" : ""}`}
                  onClick={() => setTab(t.id)}
                  title={t.desc}
                  style={{
                    fontSize: "0.85rem",
                    padding: "8px 12px",
                    marginBottom: 2,
                  }}
                >
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* BOTTOM SECTION */}
        <div
          className="sidebar-bottom"
          style={{
            marginTop: 10,
            borderTop: "1px solid var(--border)",
            paddingTop: 10,
          }}
        >
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
              {showHelpMenu && (
                <ChevronRight
                  size={16}
                  style={{ opacity: 0.7 }}
                  className="chevron"
                />
              )}
            </button>
          </div>

          {/* 2. SETTINGS MENU */}
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
                <ChevronRight
                  size={16}
                  style={{ opacity: 0.7 }}
                  className="chevron"
                />
              )}
            </button>
          </div>
        </div>
      </div>

      {showUpdateModal && (
        <UpdateModal onClose={() => setShowUpdateModal(false)} />
      )}
    </>
  );
}
