import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, Info, TriangleAlert, XCircle, X } from "lucide-react";
import { Button } from "./Button";
import "./ui.css";

export type ToastTone = "success" | "error" | "info" | "warning";

export interface ToastOptions {
  message: string;
  /** A short bold line above the message. */
  title?: string;
  tone?: ToastTone;
  /** One follow-up action, such as Undo or Open. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before it closes itself. 0 keeps it until dismissed. */
  duration?: number;
}

export interface ToastApi {
  show: (options: ToastOptions) => number;
  success: (message: string, options?: Omit<ToastOptions, "message" | "tone">) => number;
  error: (message: string, options?: Omit<ToastOptions, "message" | "tone">) => number;
  info: (message: string, options?: Omit<ToastOptions, "message" | "tone">) => number;
  warning: (message: string, options?: Omit<ToastOptions, "message" | "tone">) => number;
  dismiss: (id: number) => void;
}

interface ToastEntry extends ToastOptions {
  id: number;
}

const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
};

const ICONS: Record<ToastTone, ReactNode> = {
  success: <CheckCircle2 size={18} />,
  info: <Info size={18} />,
  warning: <TriangleAlert size={18} />,
  error: <XCircle size={18} />,
};

// A screen that shows a toast must not crash in a test, or in a tree with no provider.
const noop: ToastApi = {
  show: () => 0,
  success: () => 0,
  error: () => 0,
  info: () => 0,
  warning: () => 0,
  dismiss: () => {},
};

const ToastContext = createContext<ToastApi>(noop);

/** The toast functions: show, success, error, info, warning and dismiss. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: number) => void }) {
  const tone = toast.tone ?? "info";
  const duration = toast.duration ?? (toast.action ? 10000 : DEFAULT_DURATION[tone]);
  // Hovering or focusing a toast stops the countdown, so it cannot vanish while being read.
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!duration || paused) return;
    const timer = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(timer);
  }, [duration, paused, toast.id, onDismiss]);

  return (
    <div
      className={`ui-toast ui-toast--${tone}`}
      role={tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span style={{ color: "var(--tone)", display: "flex", paddingTop: 1 }} aria-hidden="true">
        {ICONS[tone]}
      </span>
      <div className="ui-toast__text">
        {toast.title && <strong className="ui-toast__title">{toast.title}</strong>}
        {toast.message}
      </div>
      <div className="ui-toast__actions">
        {toast.action && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              toast.action!.onClick();
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label="Dismiss notification"
          icon={<X size={14} />}
          onClick={() => onDismiss(toast.id)}
        />
      </div>
    </div>
  );
}

/**
 * Mount once near the top of the app. Short confirmations ("Saved", "Copied") go here
 * instead of a dialog that needs a click.
 */
export function ToastProvider({ children, max = 3 }: { children: ReactNode; max?: number }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      // Only the newest few stay on screen.
      setToasts((list) => [...list, { ...options, id }].slice(-max));
      return id;
    },
    [max],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (message, o) => show({ ...o, message, tone: "success" }),
      error: (message, o) => show({ ...o, message, tone: "error" }),
      info: (message, o) => show({ ...o, message, tone: "info" }),
      warning: (message, o) => show({ ...o, message, tone: "warning" }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ui-toasts" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
