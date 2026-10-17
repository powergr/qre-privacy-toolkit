import { useState, useRef, useEffect } from "react";
import { Shield, Copy, Check } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ViewState } from "../../types";
import { PasswordInput } from "../common/PasswordInput";
import "./AuthOverlay.css";

interface AuthOverlayProps {
  view: ViewState;
  password: string;
  setPassword: (s: string) => void;
  confirmPass: string;
  setConfirmPass: (s: string) => void;
  recoveryCode: string;
  setRecoveryCode: (s: string) => void;
  onLogin: () => void;
  onInit: () => void;
  onRestoreBackup: () => void;
  onRecovery: () => void;
  onAckRecoveryCode: () => void;
  onSwitchToRecovery: () => void;
  onCancelRecovery: () => void;
}

export function AuthOverlay(props: AuthOverlayProps) {
  const { view, password, recoveryCode } = props;
  const [copied, setCopied] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only the "Copied!" label is tied to this screen. The clipboard wipe timer must keep
  // running after the screen closes, so it is deliberately not cleaned up here.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    try {
      await writeText(recoveryCode);
      setCopied(true);
      // Restart the 2 second label window on every copy; an older timer would hide the
      // label too early after a second copy.
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
      // Replace any pending clear from a previous copy so the 30s window
      // restarts from this copy instead of clearing early.
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(async () => {
        await writeText("");
      }, 30000); // Clear clipboard after 30s
    } catch (e) {
      console.error("Clipboard error", e);
    }
  }

  // Handle Form Submission (Enter Key)
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault(); // Stop page reload
    if (view === "setup") props.onInit();
    else if (view === "recovery_entry") props.onRecovery();
    else props.onLogin();
  };

  let title = "Unlock Vault";
  if (view === "loading") title = "Starting";
  if (view === "setup") title = "Setup QRE";
  if (view === "recovery_entry") title = "Recovery";
  if (view === "recovery_display") title = "Recovery Code";

  // Determine if we need the strength meter (Only for creating new passwords)
  const isCreationMode = view === "setup" || view === "recovery_entry";

  return (
    <div className="auth-overlay">
      <div className="auth-card">
        <div className="modal-header">
          <Shield size={20} color="var(--accent)" />
          <h2>{title}</h2>
        </div>

        <div className="modal-body">
          {view === "loading" ? (
            /* The app has not yet found out whether a vault exists, so there is nothing
               to sign in to. A form here would offer "Unlock" or a "New Master Password"
               field that does the wrong thing if used. */
            <p style={{ color: "var(--text-dim)", textAlign: "center" }}>
              Loading...
            </p>
          ) : view === "recovery_display" ? (
            /* --- RECOVERY CODE DISPLAY --- */
            <>
              <p className="auth-warning">SAVE THIS CODE SECURELY</p>

              <div className="recovery-box">
                <div className="recovery-code">{recoveryCode}</div>
                <button
                  className="secondary-btn"
                  onClick={handleCopy}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                  }}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? "Copied!" : "Copy to Clipboard"}
                </button>
                {copied && (
                  <span className="auth-note">Clipboard will clear in 30s</span>
                )}
              </div>

              <p className="auth-explain">
                It is the ONLY way to recover your data if you forget your
                password.
              </p>
              <button className="auth-btn" onClick={props.onAckRecoveryCode}>
                I have saved it
              </button>
            </>
          ) : (
            /* --- LOGIN / SETUP FORM --- */
            <form
              onSubmit={handleSubmit}
              style={{ display: "flex", flexDirection: "column", gap: "15px" }}
            >
              {(view === "login" || view === "setup") && (
                <p className="auth-tagline">Everything stays on this device.</p>
              )}

              {view === "recovery_entry" && (
                <input
                  className="auth-input"
                  placeholder="Recovery Code (QRE-...)"
                  onChange={(e) => props.setRecoveryCode(e.target.value)}
                  autoFocus
                />
              )}

              {/* Password Input with Strength Meter & Generator */}
              <PasswordInput
                key={view} // Reset state/autofocus when switching views
                value={password}
                onChange={props.setPassword}
                placeholder={
                  view === "login" ? "Master Password" : "New Master Password"
                }
                showStrength={isCreationMode} // Show meter for Setup/Recovery
                allowGenerate={isCreationMode} // Allow generating for Setup/Recovery
                autoFocus={view !== "recovery_entry"} // Autofocus here unless recovery code is first
              />

              {isCreationMode && (
                <PasswordInput
                  value={props.confirmPass}
                  onChange={props.setConfirmPass}
                  placeholder="Confirm Password"
                  showStrength={false}
                />
              )}

              <button type="submit" className="auth-btn">
                {view === "setup"
                  ? "Initialize"
                  : view === "recovery_entry"
                    ? "Reset & Login"
                    : "Unlock"}
              </button>

              {view === "login" && (
                <button type="button" className="auth-link" onClick={props.onSwitchToRecovery}>
                  Forgot Password?
                </button>
              )}
              {view === "setup" && (
                <button type="button" className="auth-link" onClick={props.onRestoreBackup}>
                  Restore from Backup instead
                </button>
              )}
              {view === "recovery_entry" && (
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={props.onCancelRecovery}
                  style={{ marginTop: 0 }}
                >
                  Cancel
                </button>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
