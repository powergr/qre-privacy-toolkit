import { useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { cx } from "./cx";
import { Button } from "./Button";
import { useFocusTrap } from "./useFocusTrap";
import "./ui.css";

interface SheetProps {
  kind: "dialog" | "drawer";
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "danger";
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  dismissible: boolean;
  role: "dialog" | "alertdialog";
  className?: string;
}

/** The shared frame of Dialog and Drawer: dimmed page, focus trap, Escape, labelled panel. */
function Sheet({
  kind,
  title,
  description,
  icon,
  tone = "default",
  children,
  footer,
  onClose,
  dismissible,
  role,
  className,
}: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  // Escape closes the newest dialog first (see useEscapeKey).
  useEscapeKey(onClose, dismissible);
  useFocusTrap(panel, true);

  const isDrawer = kind === "drawer";
  return (
    <div
      className={cx("modal-overlay", "ui-overlay", isDrawer && "ui-overlay--drawer")}
      // mousedown, not click: selecting text inside and releasing outside must not close it.
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(isDrawer ? "ui-drawer" : "ui-dialog", tone === "danger" && "ui-dialog--danger", className)}
      >
        <div className="ui-sheet__head">
          {icon && (
            <span className="ui-sheet__icon" aria-hidden="true">
              {icon}
            </span>
          )}
          <div className="ui-sheet__titles">
            <h2 id={titleId} className="ui-sheet__title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="ui-sheet__desc">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Close"
              data-no-initial-focus
              onClick={onClose}
              icon={<X size={16} />}
            />
          )}
        </div>
        {children !== undefined && <div className="ui-sheet__body">{children}</div>}
        {footer && <div className="ui-sheet__foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface DialogProps {
  /** Mount the dialog only while it is needed. Defaults to open. */
  open?: boolean;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  /** danger paints the dialog red. Use it for the final step of a destructive action. */
  tone?: "default" | "danger";
  children?: ReactNode;
  /** The buttons. Put the main action last. */
  actions?: ReactNode;
  onClose: () => void;
  /** False blocks Escape, the close button and a click outside, for example while saving. */
  dismissible?: boolean;
  /** alertdialog tells screen readers this interrupts and needs an answer. */
  alert?: boolean;
}

/**
 * For decisions only: destructive confirmations and choices that block the page. Success
 * messages belong in a toast, and editing an item belongs in a Drawer.
 */
export function Dialog({
  open = true,
  title,
  description,
  icon,
  tone = "default",
  children,
  actions,
  onClose,
  dismissible = true,
  alert = false,
}: DialogProps) {
  if (!open) return null;
  return (
    <Sheet
      kind="dialog"
      title={title}
      description={description}
      icon={icon}
      tone={tone}
      footer={actions}
      onClose={onClose}
      dismissible={dismissible}
      role={alert ? "alertdialog" : "dialog"}
    >
      {children}
    </Sheet>
  );
}

export interface DrawerProps {
  open?: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Save and Cancel buttons, kept in view below the scrolling content. */
  footer?: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
}

/**
 * A panel that slides in from the right for editing one item, so the list stays visible
 * behind it.
 */
export function Drawer({ open = true, title, description, children, footer, onClose, dismissible = true }: DrawerProps) {
  if (!open) return null;
  return (
    <Sheet
      kind="drawer"
      title={title}
      description={description}
      footer={footer}
      onClose={onClose}
      dismissible={dismissible}
      role="dialog"
    >
      {children}
    </Sheet>
  );
}
