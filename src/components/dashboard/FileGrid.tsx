import { FileEntry } from "../../types";
import { formatSize, formatDate } from "../../utils/formatting";
import { Folder, File, HardDrive } from "lucide-react";

interface FileGridProps {
  entries: FileEntry[];
  selectedPaths: string[];
  onSelect: (path: string, multi: boolean) => void;
  onNavigate: (path: string) => void;
}

export function FileGrid({ entries, selectedPaths, onSelect, onNavigate }: FileGridProps) {
  return (
    <div className="file-view">
      <div className="file-header">
        <div></div>
        <div>Name</div>
        <div>Type</div>
        <div>Size</div>
        <div>Date</div>
      </div>
      {entries.map((e, i) => (
        <div
          key={i}
          className={`file-row ${selectedPaths.includes(e.path) ? "selected" : ""}`}
          onClick={(ev) => onSelect(e.path, ev.ctrlKey)}
          onDoubleClick={() => e.isDirectory && onNavigate(e.path)}
        >
          <div className="icon">
            {e.isDrive ? (
              <HardDrive size={16} stroke="#7aa2f7" />
            ) : e.isDirectory ? (
              <Folder size={16} stroke="#e0af68" />
            ) : (
              <File size={16} />
            )}
          </div>
          <div className="name">{e.name}</div>
          <div className="details">
            {e.isDirectory ? "Folder" : e.name.split(".").pop()?.toUpperCase()}
          </div>
          <div className="details">{formatSize(e.size)}</div>
          <div className="details">{formatDate(e.modified)}</div>
        </div>
      ))}
    </div>
  );
}