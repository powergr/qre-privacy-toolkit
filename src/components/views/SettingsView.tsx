import {
  Monitor,
  Download,
  Key,
  RotateCcw,
  RefreshCw,
  LogOut,
  ChevronRight,
} from "lucide-react";

interface SettingsViewProps {
  onTheme: () => void;
  onBackup: () => void;
  onChangePassword: () => void;
  onReset2FA: () => void;
  onUpdate: () => void;
  onLogout: () => void;
}

interface RowProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function SettingsRow({ icon, label, onClick, danger }: RowProps) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px",
        background: "var(--panel-bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        cursor: "pointer",
        width: "100%",
        fontFamily: "inherit",
        fontSize: "1rem",
        color: danger ? "var(--btn-danger)" : "var(--text-main)",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {icon} {label}
      </span>
      <ChevronRight
        size={16}
        color={danger ? "var(--btn-danger)" : "var(--text-dim)"}
      />
    </button>
  );
}

export function SettingsView({
  onTheme,
  onBackup,
  onChangePassword,
  onReset2FA,
  onUpdate,
  onLogout,
}: SettingsViewProps) {
  return (
    <div
      style={{
        padding: "24px 16px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <h2
        style={{
          margin: "0 0 12px",
          fontSize: "1.2rem",
          color: "var(--text-main)",
        }}
      >
        Settings
      </h2>

      <SettingsRow
        icon={<Monitor size={20} />}
        label="Theme"
        onClick={onTheme}
      />
      <SettingsRow
        icon={<Download size={20} />}
        label="Backup"
        onClick={onBackup}
      />
      <SettingsRow
        icon={<Key size={20} />}
        label="Change Password"
        onClick={onChangePassword}
      />
      <SettingsRow
        icon={<RotateCcw size={20} />}
        label="Reset 2FA"
        onClick={onReset2FA}
      />
      <SettingsRow
        icon={<RefreshCw size={20} />}
        label="Check Updates"
        onClick={onUpdate}
      />

      <div
        style={{
          height: 1,
          background: "var(--border)",
          margin: "6px 0",
          opacity: 0.4,
        }}
      />

      <SettingsRow
        icon={<LogOut size={20} />}
        label="Log Out"
        onClick={onLogout}
        danger
      />
    </div>
  );
}
