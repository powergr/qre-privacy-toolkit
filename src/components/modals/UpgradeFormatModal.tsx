import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleArrowUp } from "lucide-react";
import { Banner, Button, Dialog } from "../ui";
import type { BatchResult, OldFormatFile } from "../../types";
import { cancelNotice, summarizeCancel } from "../../utils/cancelled";

interface UpgradeFormatModalProps {
  /** The folder open in the Files screen. */
  folder: string;
  /** The key file selected in the options menu, if any. */
  keyFile: string | null;
  /** Runs the upgrade on these files and returns one result for each, or null if it could not run. */
  onRun: (paths: string[]) => Promise<BatchResult[] | null>;
  onClose: () => void;
}

/** How many file names are listed before "and N more". */
const SHOWN = 6;

/**
 * Finds the locked files in the open folder that an older version of the app made, and rewrites
 * them in the current format. The scan only looks. Nothing changes until the user presses the
 * button, and each file is checked before it replaces the old one.
 */
export function UpgradeFormatModal({ folder, keyFile, onRun, onClose }: UpgradeFormatModalProps) {
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [files, setFiles] = useState<OldFormatFile[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runFailed, setRunFailed] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);

  useEffect(() => {
    let stale = false;
    setFiles(null);
    setScanError(null);
    invoke<OldFormatFile[]>("find_old_format_files", { folder, recursive: includeSubfolders })
      .then((found) => {
        if (!stale) setFiles(found);
      })
      .catch((e) => {
        if (!stale) setScanError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [folder, includeSubfolders]);

  // Only a guide for the screen: the app itself decides again, with its own clock, when it runs.
  const nowSecs = Date.now() / 1000;
  const stillLocked = (f: OldFormatFile) => f.locked_until !== null && f.locked_until > nowSecs;
  const ready = (files ?? []).filter((f) => !stillLocked(f));
  const waiting = (files ?? []).filter(stillLocked);

  async function run() {
    setRunning(true);
    setRunFailed(false);
    const done = await onRun(ready.map((f) => f.path));
    setRunning(false);
    if (done === null) setRunFailed(true);
    else setResults(done);
  }

  // ─── After the run ────────────────────────────────────────────────────────
  if (results) {
    const upgraded = results.filter((r) => r.success && r.message.startsWith("Upgraded")).length;
    const { cancelled: stopped, problems: failures } = summarizeCancel(results);
    return (
      <Dialog
        title="Upgrade Older Locked Files"
        icon={<CircleArrowUp size={18} />}
        onClose={onClose}
        actions={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        {stopped && <Banner tone="info">{cancelNotice(upgraded, "upgraded")}</Banner>}
        {!stopped && upgraded > 0 && (
          <Banner tone="success">
            {upgraded === 1 ? "1 file was" : `${upgraded} files were`} upgraded to the current format.
          </Banner>
        )}
        {failures.length > 0 && (
          <Banner tone="warning">
            <strong>{failures.length === 1 ? "1 file was" : `${failures.length} files were`} not upgraded and left as they were:</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {failures.map((f) => (
                <li key={f.name + f.message}>
                  {f.name}: {f.message}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {!stopped && upgraded === 0 && failures.length === 0 && <p>Nothing needed to change.</p>}
      </Dialog>
    );
  }

  // ─── Before the run ───────────────────────────────────────────────────────
  return (
    <Dialog
      title="Upgrade Older Locked Files"
      description="Files locked by older versions of the app show their file names to anyone who has them. The current format hides the names and catches a file that was cut short."
      icon={<CircleArrowUp size={18} />}
      onClose={onClose}
      dismissible={!running}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={running}>
            {files && files.length === 0 ? "Close" : "Cancel"}
          </Button>
          {files && files.length > 0 && (
            <Button variant="primary" loading={running} disabled={ready.length === 0} onClick={run}>
              {ready.length === 1 ? "Upgrade 1 file" : `Upgrade ${ready.length} files`}
            </Button>
          )}
        </>
      }
    >
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={includeSubfolders}
          disabled={running}
          onChange={(e) => setIncludeSubfolders(e.target.checked)}
        />
        Include sub folders
      </label>

      {scanError && <Banner tone="error">{scanError}</Banner>}
      {runFailed && (
        <Banner tone="error">The upgrade could not run. The message is shown at the top of the Files screen.</Banner>
      )}

      {!scanError && files === null && <p role="status">Looking for older locked files…</p>}

      {files && files.length === 0 && (
        <p role="status">No locked files in an older format were found here. Everything is already in the current format.</p>
      )}

      {files && files.length > 0 && (
        <>
          <p>
            <strong>{files.length === 1 ? "1 locked file" : `${files.length} locked files`}</strong> here{" "}
            {files.length === 1 ? "was" : "were"} made by an older version:
          </p>
          <ul aria-label="Older locked files" style={{ margin: "0 0 12px", paddingLeft: 18 }}>
            {files.slice(0, SHOWN).map((f) => (
              <li key={f.path} title={f.path}>
                {f.name}
                {stillLocked(f) && " (time-locked, will be skipped)"}
              </li>
            ))}
            {files.length > SHOWN && <li>and {files.length - SHOWN} more</li>}
          </ul>

          <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
            Each file is rewritten in the current format, checked from start to finish, and only then replaces the old
            one. The names and your password stay the same, and nothing is written to the disk in the clear. If anything
            goes wrong, the old file is left as it was.
          </p>

          {waiting.length > 0 && (
            <Banner tone="info">
              {waiting.length === 1 ? "1 file is" : `${waiting.length} files are`} still time-locked. Upgrade{" "}
              {waiting.length === 1 ? "it" : "them"} after the lock ends.
            </Banner>
          )}

          <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
            {keyFile
              ? "The key file you selected will be used. Files locked with a different key file will be skipped."
              : "A file locked with a key file needs that key file. Select it in the options menu first."}
          </p>
        </>
      )}
    </Dialog>
  );
}
