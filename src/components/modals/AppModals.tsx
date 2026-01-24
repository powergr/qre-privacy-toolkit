import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import {
  X,
  Info,
  AlertTriangle,
  Key,
  Trash2,
  Archive,
  Monitor,
  Sun,
  Moon,
  XCircle,
  Download,
  CheckCircle,
  FileX, // <--- ADDED THIS IMPORT
} from "lucide-react";
import { PasswordInput } from "../common/PasswordInput";

// --- INFO MODAL (Success) ---
export function InfoModal({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 100002 }}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div
          className="modal-header"
          style={{ borderBottomColor: "var(--btn-success)" }}
        >
          <CheckCircle size={20} color="var(--btn-success)" />
          <h2 style={{ color: "var(--btn-success)" }}>Success</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>
        <div className="modal-body">
          <p
            style={{
              color: "var(--text-main)",
              whiteSpace: "pre-wrap",
              fontSize: "0.9rem",
              lineHeight: "1.5",
              textAlign: "center",
            }}
          >
            {message}
          </p>
          <div style={{ marginTop: 15 }}>
            <button
              className="auth-btn"
              style={{ width: "100%", background: "var(--btn-success)" }}
              onClick={onClose}
            >
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- BACKUP MODAL ---
export function BackupModal({
  onProceed,
  onCancel,
}: {
  onProceed: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Download size={20} color="var(--accent)" />
          <h2>Backup Keychain</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onCancel} />
        </div>
        <div className="modal-body">
          <p style={{ color: "var(--text-main)", marginBottom: 10 }}>
            You are about to export your secure Keychain.
          </p>
          <ul
            style={{
              color: "var(--text-dim)",
              fontSize: "0.85rem",
              paddingLeft: 20,
              lineHeight: "1.4",
              marginBottom: 15,
            }}
          >
            <li>Save this file to a safe place (USB Drive, Cloud).</li>
            <li>If your computer crashes, this file restores access.</li>
            <li style={{ color: "#ff9e64", marginTop: 5 }}>
              <strong>WARNING:</strong> You will still need your Master Password
              to use this backup.
            </li>
          </ul>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              className="auth-btn"
              style={{ flex: 1 }}
              onClick={onProceed}
            >
              Save Backup...
            </button>
            <button
              className="secondary-btn"
              style={{ flex: 1 }}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- BACKUP REMINDER MODAL ---
export function BackupReminderModal({
  onBackup,
  onCancel,
}: {
  onBackup: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-overlay" style={{ zIndex: 100005 }}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div
          className="modal-header"
          style={{ borderBottomColor: "var(--warning)" }}
        >
          <AlertTriangle size={20} color="var(--warning)" />
          <h2 style={{ color: "var(--warning)" }}>Security Reminder</h2>
        </div>
        <div className="modal-body">
          <p style={{ color: "var(--text-main)", lineHeight: "1.5" }}>
            You have successfully encrypted your first file.
          </p>
          <p
            style={{
              color: "var(--text-dim)",
              fontSize: "0.9rem",
              lineHeight: "1.4",
            }}
          >
            If you lose your password or your hard drive fails, your data will
            be <strong>gone forever</strong> unless you have a backup of your
            Keychain.
          </p>

          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <button
              className="auth-btn"
              style={{ flex: 1, backgroundColor: "var(--accent)" }}
              onClick={onBackup}
            >
              Backup Now
            </button>
            <button
              className="secondary-btn"
              style={{ flex: 1 }}
              onClick={onCancel}
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- ERROR MODAL ---
export function ErrorModal({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 100002 }}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div
          className="modal-header"
          style={{ borderBottomColor: "var(--btn-danger)" }}
        >
          <XCircle size={20} color="var(--btn-danger)" />
          <h2 style={{ color: "var(--btn-danger)" }}>Error</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>
        <div className="modal-body">
          <p
            style={{
              color: "var(--text-main)",
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word",
              fontSize: "0.9rem",
              lineHeight: "1.5",
            }}
          >
            {message}
          </p>
          <div style={{ marginTop: 15 }}>
            <button
              className="secondary-btn"
              style={{ width: "100%" }}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- PROCESSING MODAL ---
export function ProcessingModal({
  status,
  percentage,
}: {
  status: string;
  percentage: number;
}) {
  return (
    <div className="modal-overlay" style={{ zIndex: 100000 }}>
      <div
        className="auth-card"
        style={{ width: 350, textAlign: "center", padding: 30 }}
      >
        <h3 style={{ marginTop: 0, color: "var(--text-main)" }}>
          Processing...
        </h3>

        <p
          style={{
            color: "var(--text-dim)",
            fontSize: "0.9rem",
            margin: "10px 0",
            height: "20px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {status}
        </p>

        <div className="progress-container">
          <div
            className="progress-fill"
            style={{ width: `${percentage}%` }}
          ></div>
        </div>
        <p
          style={{ marginTop: 10, fontWeight: "bold", color: "var(--accent)" }}
        >
          {percentage}%
        </p>
      </div>
    </div>
  );
}

// --- THEME MODAL ---
interface ThemeModalProps {
  currentTheme: string;
  onSave: (theme: string) => void;
  onCancel: () => void;
}
export function ThemeModal({
  currentTheme,
  onSave,
  onCancel,
}: ThemeModalProps) {
  const [selected, setSelected] = useState(currentTheme);

  const options = [
    { id: "system", label: "System Default", icon: <Monitor size={20} /> },
    { id: "light", label: "Light Mode", icon: <Sun size={20} /> },
    { id: "dark", label: "Dark Mode", icon: <Moon size={20} /> },
  ];

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Monitor size={20} color="var(--accent)" />
          <h2>App Theme</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onCancel} />
        </div>
        <div className="modal-body">
          <p style={{ color: "var(--text-main)", marginBottom: 10 }}>
            Select appearance:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {options.map((opt) => (
              <div
                key={opt.id}
                onClick={() => setSelected(opt.id)}
                style={{
                  padding: 12,
                  borderRadius: 6,
                  border: `1px solid ${
                    selected === opt.id ? "var(--accent)" : "var(--border)"
                  }`,
                  background:
                    selected === opt.id
                      ? "rgba(0, 122, 204, 0.1)"
                      : "transparent",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  color: "var(--text-main)",
                }}
              >
                {opt.icon}
                <span
                  style={{
                    fontWeight: selected === opt.id ? "bold" : "normal",
                  }}
                >
                  {opt.label}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <button
              className="auth-btn"
              style={{ flex: 1 }}
              onClick={() => onSave(selected)}
            >
              Save
            </button>
            <button
              className="secondary-btn"
              style={{ flex: 1 }}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- ENTRY DELETE MODAL (For Vault/Notes) ---
export function EntryDeleteModal({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="modal-overlay"
      onClick={onCancel}
      style={{ zIndex: 100005 }}
    >
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Trash2 size={20} color="var(--btn-danger)" />
          <h2 style={{ color: "var(--btn-danger)" }}>Delete Item</h2>
        </div>
        <div className="modal-body">
          <p style={{ color: "var(--text-main)", textAlign: "center" }}>
            Are you sure you want to delete <br />
            <strong>"{title}"</strong>?
          </p>
          <p
            style={{
              color: "var(--text-dim)",
              fontSize: "0.85rem",
              textAlign: "center",
              marginTop: "-10px",
            }}
          >
            This action cannot be undone.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <button
              className="auth-btn danger-btn"
              style={{ flex: 1 }}
              onClick={onConfirm}
            >
              Delete
            </button>
            <button
              className="secondary-btn"
              style={{ flex: 1 }}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- DELETE CONFIRM MODAL (For Files) ---
interface DeleteConfirmModalProps {
  items: string[];
  onTrash: () => void;
  onShred: () => void;
  onCancel: () => void;
}
export function DeleteConfirmModal({
  items,
  onTrash,
  onShred,
  onCancel,
}: DeleteConfirmModalProps) {
  const count = items.length;
  const displayName =
    count === 1 ? items[0].split(/[/\\]/).pop() : `${count} items`;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Trash2 size={20} color="var(--btn-danger)" />
          <h2>Delete {count > 1 ? "Items" : "Item"}</h2>
        </div>
        <div className="modal-body">
          <p style={{ color: "var(--text-main)" }}>
            Are you sure you want to permanently delete <br />
            <strong>{displayName}</strong>?
          </p>
          <p
            style={{
              color: "var(--text-dim)",
              fontSize: "0.8rem",
              marginTop: "-10px",
            }}
          >
            This action cannot be undone.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            {/* Trash */}
            <button
              className="secondary-btn"
              onClick={onTrash}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: 12,
                borderColor: "var(--border)",
              }}
            >
              <Trash2 size={18} />
              <span>Move to Trash</span>
            </button>

            {/* Shred */}
            <button
              className="auth-btn danger-btn"
              onClick={onShred}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: 12,
              }}
            >
              <FileX size={18} />
              <span>Secure Shred</span>
            </button>
          </div>

          <div style={{ marginTop: 15, textAlign: "center" }}>
            <span
              style={{
                color: "var(--text-dim)",
                fontSize: "0.8rem",
                cursor: "pointer",
                textDecoration: "underline",
              }}
              onClick={onCancel}
            >
              Cancel
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- COMPRESSION MODAL ---
interface CompressionModalProps {
  current: string;
  onSave: (mode: string) => void;
  onCancel: () => void;
}
export function CompressionModal({
  current,
  onSave,
  onCancel,
}: CompressionModalProps) {
  const [selected, setSelected] = useState(current);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Archive size={20} color="var(--accent)" />
          <h2>Zip Options</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onCancel} />
        </div>
        <div className="modal-body">
          <p style={{ color: "var(--text-main)", marginBottom: 10 }}>
            Select compression mode:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              {
                id: "auto",
                label: "Auto (Smart)",
                desc: "Best balance. Fast for video, compressed for docs.",
              },
              {
                id: "extreme",
                label: "Extreme (Slow)",
                desc: "Maximum compression (Level 19). Takes longer.",
              },
              {
                id: "store",
                label: "Store (None)",
                desc: "No compression. Instant.",
              },
            ].map((opt) => (
              <div
                key={opt.id}
                onClick={() => setSelected(opt.id)}
                style={{
                  padding: 10,
                  borderRadius: 6,
                  border: `1px solid ${
                    selected === opt.id ? "var(--accent)" : "var(--border)"
                  }`,
                  background:
                    selected === opt.id
                      ? "rgba(0, 122, 204, 0.1)"
                      : "transparent",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <span style={{ color: "var(--text-main)", fontWeight: "bold" }}>
                  {opt.label}
                </span>
                <span style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>
                  {opt.desc}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <button
              className="auth-btn"
              style={{ flex: 1 }}
              onClick={() => onSave(selected)}
            >
              Save
            </button>
            <button
              className="secondary-btn"
              style={{ flex: 1 }}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- ABOUT MODAL ---
export function AboutModal({ onClose }: { onClose: () => void }) {
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    async function loadVer() {
      try {
        const v = await getVersion();
        setAppVersion(v);
      } catch (e) {
        setAppVersion("2.5.2");
      }
    }
    loadVer();
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Info size={20} color="var(--accent)" />
          <h2>About QRE Toolkit</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>
        <div className="modal-body" style={{ textAlign: "center" }}>
          <p>
            <strong>Version {appVersion}</strong>
          </p>
          <p
            style={{
              color: "var(--text-dim)",
              fontSize: "0.9rem",
              lineHeight: "1.5",
            }}
          >
            The local-first privacy suite.
            <br />
            Secure Encryption • Password Vault • File Shredder
          </p>

          <p
            style={{
              color: "var(--accent)",
              cursor: "pointer",
              textDecoration: "underline",
              marginTop: 15,
              fontWeight: "bold",
            }}
            onClick={() =>
              invoke("plugin:opener|open", { path: "https://projectqre.com/" })
            }
          >
            Visit projectqre.com
          </p>

          <button
            className="secondary-btn"
            onClick={onClose}
            style={{ marginTop: 20 }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// --- RESET CONFIRM MODAL ---
export function ResetConfirmModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <AlertTriangle size={20} color="var(--warning)" />
          <h2>Reset Recovery Code?</h2>
        </div>
        <div className="modal-body">
          <p style={{ color: "var(--text-main)" }}>
            This will invalidate your old code immediately. You must print/save
            the new one.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="auth-btn danger-btn" onClick={onConfirm}>
              Confirm Reset
            </button>
            <button
              className="secondary-btn"
              style={{ flex: 1 }}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- CHANGE PASSWORD MODAL ---
interface ChangePassProps {
  pass: string;
  setPass: (s: string) => void;
  confirm: string;
  setConfirm: (s: string) => void;
  onUpdate: () => void;
  onCancel: () => void;
}
export function ChangePassModal({
  pass,
  setPass,
  confirm,
  setConfirm,
  onUpdate,
  onCancel,
}: ChangePassProps) {
  return (
    <div className="modal-overlay">
      <div className="auth-card">
        <div className="modal-header">
          <Key size={20} color="var(--accent)" />
          <h2>Change Password</h2>
        </div>
        <div className="modal-body">
          {/* New Password Input with Strength & Generator */}
          <PasswordInput
            value={pass}
            onChange={setPass}
            placeholder="New Password"
            showStrength={true}
            allowGenerate={true}
            autoFocus
          />

          <PasswordInput
            value={confirm}
            onChange={setConfirm}
            placeholder="Confirm Password"
          />

          <div style={{ display: "flex", gap: 10 }}>
            <button className="auth-btn" style={{ flex: 1 }} onClick={onUpdate}>
              Update
            </button>
            <button
              className="secondary-btn"
              style={{ flex: 1 }}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- TIMEOUT WARNING MODAL ---
export function TimeoutWarningModal({
  seconds,
  onStay,
}: {
  seconds: number;
  onStay: () => void;
}) {
  return (
    <div className="modal-overlay" style={{ zIndex: 100001 }}>
      <div
        className="auth-card"
        style={{ width: 400, border: "1px solid var(--warning)" }}
      >
        <div
          className="modal-header"
          style={{ borderBottomColor: "var(--warning)" }}
        >
          <AlertTriangle size={20} color="var(--warning)" />
          <h2 style={{ color: "var(--warning)" }}>Session Expiring</h2>
        </div>
        <div className="modal-body">
          <p
            style={{
              color: "var(--text-main)",
              textAlign: "center",
              fontSize: "1.1rem",
            }}
          >
            You will be logged out in
          </p>
          <div
            style={{
              fontSize: "3rem",
              fontWeight: "bold",
              textAlign: "center",
              color: "var(--text-main)",
              margin: "10px 0",
            }}
          >
            {seconds}
          </div>
          <p
            style={{
              color: "var(--text-dim)",
              textAlign: "center",
              fontSize: "0.9rem",
            }}
          >
            Move your mouse or click below to stay logged in.
          </p>

          <div style={{ marginTop: 20 }}>
            <button
              className="auth-btn"
              style={{
                width: "100%",
                background: "var(--warning)",
                color: "#000",
              }}
              onClick={onStay}
            >
              I'm still here
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
