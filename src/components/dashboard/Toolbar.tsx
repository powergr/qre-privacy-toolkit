import { useState, useRef, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Lock,
  Unlock,
  Sliders,
  Settings,
  Key,
  LogOut,
  Info,
  RotateCcw,
  ShieldAlert,
  Check,
  CircleHelp,
  BookOpen,
  Archive,
  Monitor,
  Download,
} from "lucide-react";
interface ToolbarProps {
  onLock: () => void;
  onUnlock: () => void;
  onRefresh: () => void;
  onLogout: () => void;

  keyFile: string | null;
  setKeyFile: (path: string | null) => void;
  selectKeyFile: () => void;
  isParanoid: boolean;
  setIsParanoid: (v: boolean) => void;

  compressionMode: string;
  onOpenCompression: () => void;

  onChangePassword: () => void;
  onReset2FA: () => void;
  onTheme: () => void;
  onAbout: () => void;
  onHelp: () => void;
  onBackup: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const advancedRef = useRef<HTMLDivElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
      if (
        advancedRef.current &&
        !advancedRef.current.contains(event.target as Node)
      ) {
        setShowAdvanced(false);
      }
      if (helpRef.current && !helpRef.current.contains(event.target as Node)) {
        setShowHelp(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="toolbar" style={{ justifyContent: "space-between" }}>
      {/* LEFT GROUP: Lock/Unlock Actions */}
      <div style={{ display: "flex", gap: 10 }}>
        <button className="tool-btn success" onClick={props.onLock}>
          <Lock size={26} color="#16a34a" strokeWidth={2.5} />
          <span style={{ fontWeight: 600, color: "var(--text-main)" }}>
            Lock
          </span>
        </button>

        <button className="tool-btn danger" onClick={props.onUnlock}>
          <Unlock size={26} color="#dc2626" strokeWidth={2.5} />
          <span style={{ fontWeight: 600, color: "var(--text-main)" }}>
            Unlock
          </span>
        </button>
      </div>

      {/* RIGHT GROUP: Settings & Help */}
      <div style={{ display: "flex", gap: 6 }}>
        {/* 1. OPTIONS */}
        <div className="dropdown-container" ref={menuRef}>
          <button className="tool-btn" onClick={() => setShowMenu(!showMenu)}>
            <Settings size={24} className="icon-default" strokeWidth={2} />
            <span style={{ fontSize: "0.7rem" }}>Options</span>
          </button>
          {showMenu && (
            <div className="dropdown-menu">
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowMenu(false);
                  props.onTheme();
                }}
              >
                <Monitor size={16} /> Theme
              </div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowMenu(false);
                  props.onBackup();
                }}
              >
                <Download size={16} /> Backup Keychain
              </div>
              <div className="dropdown-divider"></div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowMenu(false);
                  props.onChangePassword();
                }}
              >
                <Key size={16} /> Change Password
              </div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowMenu(false);
                  props.onReset2FA();
                }}
              >
                <RotateCcw size={16} color="var(--warning)" /> Reset 2FA Code
              </div>
              <div className="dropdown-divider"></div>
              <div className="dropdown-item danger" onClick={props.onLogout}>
                <LogOut size={16} /> Log Out
              </div>
            </div>
          )}
        </div>

        {/* 2. ADVANCED */}
        <div className="dropdown-container" ref={advancedRef}>
          <button
            className={`tool-btn ${
              props.keyFile ||
              props.isParanoid ||
              props.compressionMode !== "normal"
                ? "active-settings"
                : ""
            }`}
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <Sliders size={24} className="icon-default" strokeWidth={2} />
            <span style={{ fontSize: "0.7rem" }}>Advanced</span>
            {(props.keyFile ||
              props.isParanoid ||
              props.compressionMode !== "normal") && (
              <div className="indicator-dot"></div>
            )}
          </button>

          {showAdvanced && (
            <div className="dropdown-menu">
              <div
                className="dropdown-item"
                onClick={() => {
                  props.selectKeyFile();
                  setShowAdvanced(false);
                }}
              >
                <Key
                  size={16}
                  color={props.keyFile ? "var(--btn-success)" : "currentColor"}
                />
                {props.keyFile ? "Keyfile Active" : "Select Keyfile"}
              </div>
              {props.keyFile && (
                <div
                  className="dropdown-item danger"
                  onClick={() => props.setKeyFile(null)}
                  style={{ fontSize: "0.8rem", paddingLeft: "36px" }}
                >
                  Clear Keyfile
                </div>
              )}
              <div className="dropdown-divider"></div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowAdvanced(false);
                  props.onOpenCompression();
                }}
              >
                <Archive size={16} />
                <span>Zip Options</span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "0.7rem",
                    color: "var(--accent)",
                  }}
                >
                  {props.compressionMode.toUpperCase()}
                </span>
              </div>
              <div className="dropdown-divider"></div>
              <div
                className="dropdown-item"
                onClick={() => props.setIsParanoid(!props.isParanoid)}
              >
                <ShieldAlert
                  size={16}
                  color={props.isParanoid ? "var(--accent)" : "currentColor"}
                />
                <span>Paranoid Mode</span>
                {props.isParanoid && (
                  <Check
                    size={16}
                    color="var(--accent)"
                    style={{ marginLeft: "auto" }}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* 3. HELP (Moved closer) */}
        <div className="dropdown-container" ref={helpRef}>
          <button className="tool-btn" onClick={() => setShowHelp(!showHelp)}>
            <CircleHelp size={24} className="icon-default" strokeWidth={2} />
            <span style={{ fontSize: "0.7rem" }}>Help</span>
          </button>
          {showHelp && (
            <div className="dropdown-menu" style={{ right: 0 }}>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowHelp(false);
                  props.onHelp();
                }}
              >
                <BookOpen size={16} /> Help Topics
              </div>
              <div
                className="dropdown-item"
                onClick={async () => {
                  setShowHelp(false);
                  await openUrl("https://github.com/powergr/quantum-locker/");
                }}
              >
                <GithubIcon size={16} /> GitHub Page
              </div>
              <div className="dropdown-divider"></div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setShowHelp(false);
                  props.onAbout();
                }}
              >
                <Info size={16} /> About
              </div>
            </div>
          )}
        </div>
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
