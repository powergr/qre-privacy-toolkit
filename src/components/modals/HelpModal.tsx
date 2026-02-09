import { useRef } from "react";
import { X, BookOpen } from "lucide-react";
import { HelpManual } from "./HelpManual"; // Import new component

export function HelpModal({ onClose }: { onClose: () => void }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Simple scroll handler
  const handleScrollTo = (id: string) => {
    const element = document.getElementById(id);
    const container = scrollContainerRef.current;
    if (element && container) {
      const top = element.offsetTop - container.offsetTop;
      container.scrollTo({ top, behavior: "smooth" });
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 200000 }}>
      <div
        className="auth-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 800,
          maxWidth: "95vw",
          height: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="modal-header">
          <BookOpen size={20} color="var(--accent)" />
          <h2>Help Topics</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>

        <div
          className="modal-body"
          ref={scrollContainerRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "0 25px", // Standard padding
            scrollBehavior: "smooth",
          }}
        >
          {/* Render the manual component */}
          <HelpManual onScrollTo={handleScrollTo} />
        </div>

        <div
          style={{ padding: "15px 25px", borderTop: "1px solid var(--border)" }}
        >
          <button
            className="secondary-btn"
            style={{ width: "100%" }}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
