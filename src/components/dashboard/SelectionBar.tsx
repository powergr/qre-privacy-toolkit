import { Info, Trash2, X } from "lucide-react";
import { ActionBar } from "../ui/ActionBar";
import { Button } from "../ui/Button";
import { formatSize } from "../../utils/formatting";

interface SelectionBarProps {
  /** Names of the selected items, in list order. */
  names: string[];
  /** Total size of the selected files, in bytes. */
  totalSize: number;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onDelete: () => void;
  onClear: () => void;
}

/**
 * Appears under the list while something is selected and says what the next click will act
 * on: the name for one item, a count and total size for several.
 */
export function SelectionBar({
  names,
  totalSize,
  detailsOpen,
  onToggleDetails,
  onDelete,
  onClear,
}: SelectionBarProps) {
  if (names.length === 0) return null;
  // One text node, so it never repeats a file name or item count shown elsewhere on screen.
  const text =
    names.length === 1
      ? `Selected: ${names[0]}`
      : `${names.length} items selected, ${formatSize(totalSize)}`;
  const summary = <span title={text}>{text}</span>;

  return (
    <div className="selection-bar" role="region" aria-label="Selection">
      <ActionBar sticky={false} summary={summary}>
        <Button size="sm" aria-pressed={detailsOpen} icon={<Info size={14} />} onClick={onToggleDetails}>
          Details
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={onDelete}>
          Delete
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onClear}>
          Clear selection
        </Button>
      </ActionBar>
    </div>
  );
}
