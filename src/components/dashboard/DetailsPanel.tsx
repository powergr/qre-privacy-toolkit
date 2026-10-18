import { X } from "lucide-react";
import { Badge } from "../ui";
import { FileEntry } from "../../types";
import { formatSize, formatDate } from "../../utils/formatting";
import "./DetailsPanel.css";

interface DetailsPanelProps {
  /** The selected entries, in list order. */
  selected: FileEntry[];
  /** Locked-until time (seconds) of each time-locked file in the folder, by path. */
  timeLockInfo: Map<string, number>;
  /** The format version (5 to 8) of each locked file in the folder, by path. */
  formatVersions?: Map<string, number>;
  onClose: () => void;
}

const NO_VERSIONS = new Map<string, number>();

/** Locked by an older version of the app: the file name is readable without the key. */
export function isOlderFormat(version: number | undefined): boolean {
  return version !== undefined && version >= 5 && version <= 7;
}

/** The folder a path sits in, whichever kind of slash it uses. */
export function parentFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) return "";
  if (cut === 0) return path.slice(0, 1);
  // "C:\" keeps its slash; "C:\Users" becomes "C:\".
  const parent = path.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? parent + path[cut] : parent;
}

function kindOf(entry: FileEntry): string {
  if (entry.isDrive) return "Drive";
  if (entry.isDirectory) return "Folder";
  if (entry.name.toLowerCase().endsWith(".qre")) return "QRE encrypted file";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 && dot < entry.name.length - 1
    ? `${entry.name.slice(dot + 1).toUpperCase()} file`
    : "File";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="details-panel__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Facts about the selected item, so a size, date or full path does not need a right-click.
 * It only describes what is already listed; it never reads file contents.
 */
export function DetailsPanel({ selected, timeLockInfo, formatVersions = NO_VERSIONS, onClose }: DetailsPanelProps) {
  const total = selected.reduce((sum, e) => sum + (e.size ?? 0), 0);
  const folders = selected.filter((e) => e.isDirectory).length;
  const entry = selected.length === 1 ? selected[0] : null;
  const lockedUntil = entry ? timeLockInfo.get(entry.path) : undefined;
  // Only a .qre file has a format. The map is filled for those alone, but the panel does not rely on it.
  const isLocked = (e: FileEntry) => !e.isDirectory && !e.isDrive && e.name.toLowerCase().endsWith(".qre");
  const version = entry && isLocked(entry) ? formatVersions.get(entry.path) : undefined;
  const olderCount = selected.filter((e) => isLocked(e) && isOlderFormat(formatVersions.get(e.path))).length;

  return (
    <aside className="details-panel" aria-label="Details">
      <div className="details-panel__head">
        <h3>Details</h3>
        <button type="button" className="details-panel__close" aria-label="Close details" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {selected.length === 0 && (
        <p className="details-panel__hint">Select a file or folder to see its details.</p>
      )}

      {entry && (
        <>
          <p className="details-panel__name" title={entry.name}>
            {entry.name}
          </p>
          <dl className="details-panel__list">
            <Row label="Type" value={kindOf(entry)} />
            {!entry.isDirectory && !entry.isDrive && entry.size !== null && (
              <Row label="Size" value={formatSize(entry.size)} />
            )}
            {entry.modified && <Row label="Modified" value={formatDate(entry.modified)} />}
            {!entry.isDrive && <Row label="Location" value={parentFolder(entry.path)} />}
            {lockedUntil !== undefined && (
              <Row label="Time lock" value={`Until ${new Date(lockedUntil * 1000).toLocaleString()}`} />
            )}
            {version !== undefined && version >= 5 && version <= 8 && (
              <div className="details-panel__row">
                <dt>Format</dt>
                <dd>
                  {isOlderFormat(version) ? (
                    <Badge tone="warn">Older format (version {version})</Badge>
                  ) : (
                    <Badge tone="ok">Current format</Badge>
                  )}
                </dd>
              </div>
            )}
          </dl>
          {isOlderFormat(version) && (
            <p className="details-panel__note">
              An older version locked this file, so its file name is readable by anyone who has it. Right-click it and
              choose Upgrade Format to fix that.
            </p>
          )}
        </>
      )}

      {selected.length > 1 && (
        <>
          <p className="details-panel__name">{selected.length} items selected</p>
          <dl className="details-panel__list">
            <Row label="Folders" value={String(folders)} />
            <Row label="Files" value={String(selected.length - folders)} />
            <Row label="Total size" value={formatSize(total)} />
            {olderCount > 0 && (
              <div className="details-panel__row">
                <dt>Older format</dt>
                <dd>
                  <Badge tone="warn">{olderCount === 1 ? "1 file" : `${olderCount} files`}</Badge>
                </dd>
              </div>
            )}
          </dl>
          {olderCount > 0 && (
            <p className="details-panel__note">
              Right-click an older file and choose Upgrade Format. The older files in the selection are upgraded together.
            </p>
          )}
        </>
      )}
    </aside>
  );
}
