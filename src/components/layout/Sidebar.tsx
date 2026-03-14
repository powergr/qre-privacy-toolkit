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
  Usb,
  LockOpen,
  RefreshCw as RefreshIcon,
  Plus,
} from "lucide-react";
import type { PortableDriveState } from "../../hooks/usePortableVault";

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
  onUpdate: () => void;
  // --- Portable Vault (Phase 3) ---
  portableDrives: PortableDriveState[];
  isScanning: boolean;
  onScanDrives: () => void;
  onInitDrive: (drivePath: string) => void;
  onUnlockDrive: (drivePath: string) => void;
  onLockDrive: (drivePath: string) => void;
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
  portableDrives,
  isScanning,
  onScanDrives,
  onInitDrive,
  onUnlockDrive,
  onLockDrive,
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
          label: "Encrypt Files",
          icon: <Lock size={20} strokeWidth={2.5} />,
          desc: "Encrypt files",
        },
      ],
    },
    {
      items: [
        {
          id: "notes",
          label: "Secure Notes",
          icon: <StickyNote size={20} strokeWidth={2.5} />,
          desc: "Secure notepad",
        },
        {
          id: "vault",
          label: "Passwords Vault",
          icon: <Key size={20} strokeWidth={2.5} />,
          desc: "Offline credential vault ",
        },
        {
          id: "bookmarks",
          label: "Bookmarks Vault",
          icon: <Bookmark size={20} strokeWidth={2.5} />,
          desc: "Private encrypted links",
        },
        {
          id: "clipboard",
          label: "Secure Clipboard",
          icon: <ClipboardList size={20} strokeWidth={2.5} />,
          desc: "Secure copy and history",
        },
      ],
    },
    {
      items: [
        {
          id: "breach",
          label: "Privacy Check",
          icon: <Radar size={20} strokeWidth={2.5} />,
          desc: "Check leaks and IP exposure",
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
          desc: "Clear temp and cache",
        },
        {
          id: "cleaner",
          label: "Meta Cleaner",
          icon: <Eraser size={20} strokeWidth={2.5} />,
          desc: "Remove EXIF/GPS data",
        },
        {
          id: "shred",
          label: "Shredder",
          icon: <Trash2 size={20} strokeWidth={2.5} />,
          desc: "Permanetly destroy files",
        },
        {
          id: "analyzer",
          label: "File Analyzer",
          icon: <FileSearch size={20} strokeWidth={2.5} />,
          desc: "Detect fake extensions",
        },
        {
          id: "qr",
          label: "QR Generator",
          icon: <QrCode size={20} strokeWidth={2.5} />,
          desc: "Offline QR creation",
        },
      ],
    },
  ];

  return (
    <div className="sidebar">
      <div className="nav-links sidebar-scroll-area">
        {groups.map((group, index) => (
          <div key={index} className="nav-group-wrapper">
            {index > 0 && <div className="sidebar-group-divider" />}
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

        {/* ── Portable Drives ─────────────────────────────────────────────── */}
        {/* SECURITY: Scan is triggered only by explicit user action (clicking  */}
        {/* Refresh), never on mount or a polling interval. Auto-scanning leaks */}
        {/* portable vault presence over the IPC bridge (S-09).                */}
        <div className="sidebar-group-divider" />
        <div className="nav-group">
          <div className="portable-drives-header">
            <Usb size={14} />
            <span>Portable Drives</span>
            <button
              className="portable-scan-btn"
              onClick={onScanDrives}
              title="Refresh drive list"
              disabled={isScanning}
            >
              <RefreshIcon size={13} className={isScanning ? "spin" : ""} />
            </button>
          </div>

          {portableDrives.length === 0 && (
            <p className="portable-empty">
              {isScanning ? "Scanning…" : "No drives found"}
            </p>
          )}

          {portableDrives.map((d) => (
            <div key={d.drive.path} className="portable-drive-row">
              <div className="portable-drive-info">
                <Usb
                  size={14}
                  color={
                    d.isUnlocked ? "var(--btn-success)" : "var(--text-dim)"
                  }
                />
                <span className="portable-drive-name" title={d.drive.path}>
                  {d.drive.name || d.drive.path}
                </span>
                {d.isUnlocked && (
                  <span className="portable-unlocked-badge">●</span>
                )}
              </div>
              <div className="portable-drive-actions">
                {!d.drive.is_qre_portable && (
                  <button
                    className="portable-action-btn"
                    title="Format as QRE vault"
                    onClick={() => onInitDrive(d.drive.path)}
                  >
                    <Plus size={13} />
                  </button>
                )}
                {d.drive.is_qre_portable && !d.isUnlocked && (
                  <button
                    className="portable-action-btn"
                    title="Unlock vault"
                    onClick={() => onUnlockDrive(d.drive.path)}
                  >
                    <LockOpen size={13} />
                  </button>
                )}
                {d.drive.is_qre_portable && d.isUnlocked && (
                  <button
                    className="portable-action-btn danger"
                    title="Lock vault"
                    onClick={() => onLockDrive(d.drive.path)}
                  >
                    <Lock size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
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
