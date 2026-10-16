import { useState, useRef, useEffect } from "react";
import {
  Key,
  CircleHelp,
  BookOpen,
  Info,
  LogOut,
  Settings,
  Monitor,
  Download,
  RotateCcw,
  RefreshCw,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useShortcut } from "../../hooks/useShortcut";
import { HOME_TOOL, TOOL_GROUPS, toolsInGroup, groupHue, type Tool } from "./tools";

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
}

const COLLAPSED_KEY = "qre_sidebar_collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
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
  // On a computer the sidebar can shrink to icons. The choice is remembered.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // The collapse button changes place when the sidebar collapses. If it was the button that
  // was pressed, it gets focus back in its new place, so keyboard use is not interrupted.
  const collapseRef = useRef<HTMLButtonElement>(null);
  const refocusCollapse = useRef(false);
  useEffect(() => {
    if (refocusCollapse.current) {
      refocusCollapse.current = false;
      collapseRef.current?.focus();
    }
  }, [collapsed]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // The choice just will not be remembered.
    }
  }
  useShortcut("b", toggleCollapsed);

  const [menuState, setMenuState] = useState<"none" | "help" | "settings">(
    "none",
  );
  const helpRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMenuState("none");
  }, [activeTab]);

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

  const navButton = (t: Tool) => (
    <button
      key={t.id}
      className={`nav-btn ${activeTab === t.id ? "active" : ""}`}
      onClick={() => setTab(t.id)}
      title={t.desc}
      style={{ ["--nav-hue" as string]: groupHue(t.group) }}
    >
      <t.Icon size={20} strokeWidth={2.5} />
      <span>{t.label}</span>
    </button>
  );

  const collapseButton = (
    <button
      key="collapse"
      ref={collapseRef}
      className="sidebar-collapse"
      onClick={() => {
        refocusCollapse.current = true;
        toggleCollapsed();
      }}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand sidebar (Ctrl B)" : "Collapse sidebar (Ctrl B)"}
    >
      {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
    </button>
  );

  return (
    <div className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      {/* Open: Home on the left, the collapse button on the right. Collapsed, the buttons
          stack and the collapse button comes first, so it is always at the very top. The
          order in the page follows the order on screen. */}
      <div className="sidebar-top">
        {collapsed && collapseButton}
        {navButton(HOME_TOOL)}
        {!collapsed && collapseButton}
      </div>

      <nav className="nav-links sidebar-scroll-area" aria-label="Tools">
        {TOOL_GROUPS.map((group) => (
          <div
            key={group.id}
            className="nav-group-wrapper"
            style={{ ["--count" as string]: toolsInGroup(group.id).length }}
          >
            <div className="sidebar-group-divider" />
            <div className="nav-group" role="group" aria-label={group.label}>
              <div
                className="nav-group-label"
                style={{ ["--nav-hue" as string]: groupHue(group.id) }}
                aria-hidden="true"
              >
                <i />
                {group.label}
              </div>
              {toolsInGroup(group.id).map(navButton)}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar-bottom">
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
            className={`nav-btn btn-split ${activeTab === "help" || menuState === "help" ? "menu-open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (window.matchMedia("(max-width: 600px)").matches)
                setTab("help");
              else setMenuState(menuState === "help" ? "none" : "help");
            }}
          >
            <div className="btn-inner">
              <CircleHelp size={20} strokeWidth={2.5} />
              <span>Help</span>
            </div>
            <ChevronRight size={16} className="chevron" />
          </button>
        </div>

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
            className={`nav-btn btn-split ${activeTab === "settings" || menuState === "settings" ? "menu-open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (window.matchMedia("(max-width: 600px)").matches)
                setTab("settings");
              else setMenuState(menuState === "settings" ? "none" : "settings");
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
