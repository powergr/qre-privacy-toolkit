import { BookOpen, Info, ChevronRight } from "lucide-react";

interface HelpViewProps {
  onOpenHelpModal: () => void;
  onOpenAboutModal: () => void;
}

interface RowProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

function HelpRow({ icon, label, onClick }: RowProps) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px",
        background: "var(--panel-bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        cursor: "pointer",
        color: "var(--text-main)",
        width: "100%",
        fontFamily: "inherit",
        fontSize: "1rem",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {icon} {label}
      </span>
      <ChevronRight size={16} color="var(--text-dim)" />
    </button>
  );
}

export function HelpView({ onOpenHelpModal, onOpenAboutModal }: HelpViewProps) {
  return (
    <div
      style={{
        padding: "24px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <h2
        style={{
          margin: "0 0 12px",
          fontSize: "1.2rem",
          color: "var(--text-main)",
        }}
      >
        Help
      </h2>
      <HelpRow
        icon={<BookOpen size={20} />}
        label="Help Topics"
        onClick={onOpenHelpModal}
      />
      <HelpRow
        icon={<Info size={20} />}
        label="About"
        onClick={onOpenAboutModal}
      />
    </div>
  );
}
