import { AlertTriangle } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";

interface LoadErrorProps {
  /** What could not be opened, as a plain sentence. */
  title: string;
  /** The reason the system gave. Shown in a monospace line so it can be copied into a report. */
  detail: string;
  onRetry: () => void;
}

/**
 * What a screen shows when its data could not be read. It says what failed, why, and what
 * to do next, with a button to try again, instead of leaving the user at a dead end.
 */
export function LoadError({ title, detail, onRetry }: LoadErrorProps) {
  return (
    <EmptyState
      icon={<AlertTriangle size={48} color="var(--status-danger)" />}
      title={title}
      description={
        <>
          <code className="load-error__detail">{detail}</code>
          <br />
          Your data has not been changed. Try again, and restart the app if this keeps happening.
        </>
      }
      actions={
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}
