import { ReactNode } from "react";

interface ToolScrollProps {
  title: string;
  subtitle: string;
  /** Tab bar, shown between the header and the content. */
  tabs?: ReactNode;
  /** Centre the content in the space under the header (use for empty "start" screens). */
  centered?: boolean;
  children: ReactNode;
}

/**
 * The scrolling part of a tool screen. The title and subtitle always sit at the top
 * of the page, tabs come next, and a start screen is centred in the space that is left,
 * so moving between tools never makes the layout jump.
 */
export function ToolScroll({
  title,
  subtitle,
  tabs,
  centered = false,
  children,
}: ToolScrollProps) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "30px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ textAlign: "center", marginBottom: 30 }}>
        <h2 style={{ margin: 0, fontSize: "1.8rem" }}>{title}</h2>
        <p style={{ color: "var(--text-dim)", marginTop: 5 }}>{subtitle}</p>
      </div>

      {tabs}

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: centered ? "center" : "flex-start",
        }}
      >
        {children}
      </div>
    </div>
  );
}

interface ToolPageProps extends ToolScrollProps {
  /** Rendered below the scrolling area: action bars, dialogs. */
  footer?: ReactNode;
}

/** A full tool screen: the scrolling part plus an optional fixed footer. */
export function ToolPage({ footer, ...scroll }: ToolPageProps) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ToolScroll {...scroll} />
      {footer}
    </div>
  );
}

/** The pill-style tab bar used by Privacy Check and Metadata Cleaner. */
export function ToolTabs({ children }: { children: ReactNode }) {
  return (
    <div
      style={{ display: "flex", justifyContent: "center", marginBottom: 30 }}
    >
      <div
        style={{
          display: "flex",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "8px",
          padding: "4px",
        }}
      >
        {children}
      </div>
    </div>
  );
}
