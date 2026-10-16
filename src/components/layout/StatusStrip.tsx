import { useEffect, useState, type MutableRefObject } from "react";
import { Lock, LockOpen, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "../ui/Button";
import "./StatusStrip.css";

interface StatusStripProps {
  /**
   * When the app will lock itself, as a time in milliseconds (Date.now() scale), or 0
   * when no countdown is running. A ref, so the countdown can tick every second here
   * without re-rendering the whole app.
   */
  idleDeadlineRef: MutableRefObject<number>;
  /** True when the current keychain has been backed up. */
  backupDone: boolean;
  onBackup: () => void;
  onLock: () => void;
}

/** Whole seconds left, never below zero. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** 905 seconds becomes "15:05". */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(s / 60);
  return `${minutes}:${String(s % 60).padStart(2, "0")}`;
}

/** A thin bar above every screen that keeps the state of the vault in view. */
export function StatusStrip({ idleDeadlineRef, backupDone, onBackup, onLock }: StatusStripProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const deadline = idleDeadlineRef.current;
  const left = deadline > 0 ? secondsLeft(deadline, now) : null;

  return (
    <div className="status-strip" role="region" aria-label="Vault status">
      <span className="status-strip__item">
        <LockOpen size={14} aria-hidden="true" />
        Unlocked
      </span>

      {left !== null && (
        <span className="status-strip__item status-strip__timer" role="timer" aria-live="off">
          Auto-lock in <b>{formatCountdown(left)}</b>
        </span>
      )}

      <span className="status-strip__spacer" />

      {backupDone ? (
        <span className="status-strip__item status-strip__ok">
          <ShieldCheck size={14} aria-hidden="true" />
          Keychain backed up
        </span>
      ) : (
        <button className="status-strip__backup" onClick={onBackup} title="Save a copy of your keychain">
          <ShieldAlert size={14} aria-hidden="true" />
          Keychain not backed up
          <span className="status-strip__backup-action">Back up now</span>
        </button>
      )}

      <Button size="sm" variant="ghost" icon={<Lock size={14} />} onClick={onLock} title="Lock the app now">
        Lock
      </Button>
    </div>
  );
}
