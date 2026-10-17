import { useId, type ReactNode } from "react";
import {
  Monitor,
  Download,
  Key,
  RotateCcw,
  RefreshCw,
  LogOut,
  BookOpen,
  Info,
  ChevronRight,
} from "lucide-react";
import "./SettingsView.css";

interface SettingsViewProps {
  onTheme: () => void;
  onBackup: () => void;
  onChangePassword: () => void;
  onReset2FA: () => void;
  onUpdate: () => void;
  onLogout: () => void;
  /** On a phone these live here too, since the bottom bar has no Help button. */
  onHelp?: () => void;
  onAbout?: () => void;
}

interface RowProps {
  icon: ReactNode;
  label: string;
  /** One line on what the row does. Read out as the button's description. */
  hint: string;
  onClick: () => void;
  danger?: boolean;
}

function SettingsRow({ icon, label, hint, onClick, danger }: RowProps) {
  const hintId = useId();
  return (
    <button
      type="button"
      className={`settings-row${danger ? " settings-row--danger" : ""}`}
      // The label alone is the name; the hint is a description, so tests and screen readers
      // can find the button by what it is called.
      aria-label={label}
      aria-describedby={hintId}
      onClick={onClick}
    >
      <span className="settings-row__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="settings-row__text" aria-hidden="true">
        <strong>{label}</strong>
        <small id={hintId}>{hint}</small>
      </span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-view__group" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

export function SettingsView({
  onTheme,
  onBackup,
  onChangePassword,
  onReset2FA,
  onUpdate,
  onLogout,
  onHelp,
  onAbout,
}: SettingsViewProps) {
  return (
    <div className="settings-view">
      <h2 className="settings-view__title">Settings</h2>

      <Group title="Appearance">
        <SettingsRow
          icon={<Monitor size={20} />}
          label="Theme"
          hint="Light, dark, or follow your device."
          onClick={onTheme}
        />
      </Group>

      <Group title="Security">
        <SettingsRow
          icon={<Download size={20} />}
          label="Backup"
          hint="Save a copy of your keychain."
          onClick={onBackup}
        />
        <SettingsRow
          icon={<Key size={20} />}
          label="Change Password"
          hint="Choose a new master password."
          onClick={onChangePassword}
        />
        <SettingsRow
          icon={<RotateCcw size={20} />}
          label="Reset 2FA"
          hint="Turn off two-factor sign-in and set it up again."
          onClick={onReset2FA}
        />
      </Group>

      <Group title="App">
        <SettingsRow
          icon={<RefreshCw size={20} />}
          label="Check Updates"
          hint="See whether a newer version is available."
          onClick={onUpdate}
        />
        {onHelp && (
          <SettingsRow
            icon={<BookOpen size={20} />}
            label="Help Topics"
            hint="How each tool works."
            onClick={onHelp}
          />
        )}
        {onAbout && (
          <SettingsRow
            icon={<Info size={20} />}
            label="About"
            hint="Version and licence."
            onClick={onAbout}
          />
        )}
      </Group>

      <div className="settings-view__session">
        <SettingsRow
          icon={<LogOut size={20} />}
          label="Log Out"
          hint="Lock the vault and return to the sign-in screen."
          onClick={onLogout}
          danger
        />
      </div>
    </div>
  );
}
