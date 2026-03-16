import {
  Lock,
  Unlock,
  RefreshCw,
  Key,
  ShieldAlert,
  SlidersHorizontal,
  Usb,
  Plus,
  LockOpen,
  Check,
  Archive,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { PortableDriveState } from "../../hooks/usePortableVault";

interface ToolbarProps {
  onLock: () => void;
  onUnlock: () => void;
  onNavigate: (path: string) => void; // <--- NEW PROP

  // Encryption Settings
  keyFile: string | null;
  setKeyFile: (path: string | null) => void;
  selectKeyFile: () => void;
  isParanoid: boolean;
  setIsParanoid: (v: boolean) => void;

  compressionMode: string;
  onOpenCompression: () => void;

  // Portable USB Settings
  portable: {
    drives: PortableDriveState[];
    isScanning: boolean;
    scanDrives: () => void;
    lockVault: (p: string) => void;
  };
  onInitDrive: (p: string) => void;
  onUnlockDrive: (p: string) => void;
}

export function Toolbar(props: ToolbarProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showUsb, setShowUsb] = useState(false);
  const advancedRef = useRef<HTMLDivElement>(null);
  const usbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        advancedRef.current &&
        !advancedRef.current.contains(event.target as Node)
      )
        setShowAdvanced(false);
      if (usbRef.current && !usbRef.current.contains(event.target as Node))
        setShowUsb(false);
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

      <div style={{ flex: 1 }}></div>

      {/* RIGHT GROUP: Advanced & USB Settings */}
      <div style={{ display: "flex", gap: 6 }}>
        {/* FIX 2: Redundant standalone Refresh icon has been removed */}

        {/* --- USB PORTABLE MENU --- */}
        <div className="dropdown-container" ref={usbRef}>
          <button
            className={`tool-btn ${showUsb ? "active-settings" : ""}`}
            onClick={() => {
              setShowUsb(!showUsb);
              setShowAdvanced(false);
              if (!showUsb) props.portable.scanDrives();
            }}
            title="Portable USB Vaults"
          >
            <Usb
              size={24}
              className="icon-default"
              color={
                props.portable.drives.some((d) => d.isUnlocked)
                  ? "var(--btn-success)"
                  : "currentColor"
              }
              strokeWidth={2}
            />
          </button>

          {showUsb && (
            <div className="dropdown-menu" style={{ width: 300, right: 0 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                  padding: "0 5px",
                }}
              >
                <h4 style={{ margin: 0, color: "var(--text-main)" }}>
                  Portable Drives
                </h4>
                <button
                  className="icon-btn-ghost"
                  onClick={() => props.portable.scanDrives()}
                  disabled={props.portable.isScanning}
                >
                  <RefreshCw
                    size={14}
                    className={props.portable.isScanning ? "spin" : ""}
                  />
                </button>
              </div>

              <div className="dropdown-divider"></div>

              {props.portable.drives.length === 0 && (
                <p
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--text-dim)",
                    textAlign: "center",
                    padding: "10px 0",
                  }}
                >
                  No removable drives detected.
                </p>
              )}

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                  maxHeight: "300px",
                  overflowY: "auto",
                }}
              >
                {props.portable.drives.map((d) => (
                  <div
                    key={d.drive.path}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "rgba(0,0,0,0.2)",
                      padding: "8px",
                      borderRadius: 6,
                    }}
                  >
                    <div style={{ overflow: "hidden", flex: 1 }}>
                      {/* FIX 2: Make the drive name clickable to navigate there immediately */}
                      <div
                        style={{
                          fontSize: "0.9rem",
                          fontWeight: "bold",
                          cursor: d.isUnlocked ? "pointer" : "default",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                        onClick={() => {
                          if (d.isUnlocked) {
                            // Automatically jump to the Secure_Locker folder!
                            props.onNavigate(d.drive.path + "Secure_Locker");
                            setShowUsb(false);
                          }
                        }}
                      >
                        <span
                          style={{
                            color: d.isUnlocked
                              ? "var(--accent)"
                              : "var(--text-main)",
                            textDecoration: d.isUnlocked ? "underline" : "none",
                          }}
                        >
                          {d.drive.name || d.drive.path}
                        </span>
                        {d.isUnlocked && (
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: "var(--btn-success)",
                              display: "inline-block",
                            }}
                          ></span>
                        )}
                      </div>

                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--text-dim)",
                          marginTop: 2,
                        }}
                      >
                        {d.drive.path} •{" "}
                        {d.isUnlocked
                          ? "Unlocked"
                          : d.drive.is_qre_portable
                            ? "Locked Vault"
                            : "Unformatted"}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 5 }}>
                      {!d.drive.is_qre_portable && (
                        <button
                          className="icon-btn-ghost"
                          title="Format as Vault"
                          onClick={() => {
                            setShowUsb(false);
                            props.onInitDrive(d.drive.path);
                          }}
                        >
                          <Plus size={16} />
                        </button>
                      )}
                      {d.drive.is_qre_portable && !d.isUnlocked && (
                        <button
                          className="icon-btn-ghost"
                          title="Unlock"
                          onClick={() => {
                            setShowUsb(false);
                            props.onUnlockDrive(d.drive.path);
                          }}
                        >
                          <LockOpen size={16} />
                        </button>
                      )}
                      {d.isUnlocked && (
                        <button
                          className="icon-btn-ghost"
                          title="Lock"
                          style={{ color: "var(--btn-danger)" }}
                          onClick={() => props.portable.lockVault(d.drive.path)}
                        >
                          <Lock size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* --- ADVANCED MENU --- */}
        <div className="dropdown-container" ref={advancedRef}>
          <button
            className={`tool-btn ${props.keyFile || props.isParanoid || props.compressionMode !== "auto" ? "active-settings" : ""}`}
            onClick={() => {
              setShowAdvanced(!showAdvanced);
              setShowUsb(false);
            }}
          >
            <SlidersHorizontal
              size={24}
              className="icon-default"
              strokeWidth={2}
            />
            {(props.keyFile ||
              props.isParanoid ||
              props.compressionMode !== "auto") && (
              <div className="indicator-dot"></div>
            )}
          </button>

          {showAdvanced && (
            <div className="dropdown-menu" style={{ right: 0 }}>
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
      </div>
    </div>
  );
}
