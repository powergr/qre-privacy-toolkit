import type { ReactNode } from "react";
import { Upload } from "lucide-react";
import { cx } from "./cx";
import "./ui.css";

export interface DropZoneProps {
  icon: ReactNode;
  title: string;
  /** One line about what can be dropped. */
  description?: ReactNode;
  /** Smaller print under it, such as a size limit. */
  hint?: ReactNode;
  /** The label of the button that opens the file picker. */
  buttonLabel?: string;
  /** Opens the file picker. Pressing anywhere in the zone does the same, unless clickable is false. */
  onBrowse?: () => void;
  /** Icon of the button. Defaults to an upload arrow. */
  buttonIcon?: ReactNode;
  /** False makes only the button respond, not the whole zone. Phones use this: nothing can be dropped there. */
  clickable?: boolean;
  /** True while a file is being dragged over the window. */
  active?: boolean;
  /** Blocks the picker, for example while something is running. */
  disabled?: boolean;
  /** Colour of the icon, as a CSS value. */
  hue?: string;
  /** A shorter zone, for places that also have other content. */
  compact?: boolean;
  /** Anything extra under the button. */
  children?: ReactNode;
  className?: string;
}

/**
 * The start screen of a tool that works on files: an icon, what to drop, and a button for
 * people who would rather browse. The same zone is used by every tool, so dropping a file
 * looks and behaves the same everywhere. The shred-zone class is the older name of the
 * dashed border style, kept so existing styles and tests find it.
 */
export function DropZone({
  icon,
  title,
  description,
  hint,
  buttonLabel,
  onBrowse,
  buttonIcon,
  clickable = true,
  active = false,
  disabled = false,
  hue,
  compact = false,
  children,
  className,
}: DropZoneProps) {
  const canBrowse = !!onBrowse && !disabled;
  const zoneClickable = canBrowse && clickable;
  return (
    <div
      className={cx("shred-zone", "ui-drop", active && "active", compact && "ui-drop--compact", className)}
      style={hue ? ({ ["--drop-hue" as string]: hue } as React.CSSProperties) : undefined}
      onClick={zoneClickable ? onBrowse : undefined}
    >
      <div className="ui-drop__icon" aria-hidden="true">
        {icon}
      </div>
      <h3 className="ui-drop__title">{title}</h3>
      {description && <p className="ui-drop__desc">{description}</p>}
      {hint && <p className="ui-drop__hint">{hint}</p>}
      {buttonLabel && onBrowse && (
        <button
          type="button"
          className="secondary-btn ui-drop__button"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onBrowse();
          }}
        >
          {buttonIcon ?? <Upload size={16} aria-hidden="true" />} {buttonLabel}
        </button>
      )}
      {children}
    </div>
  );
}
