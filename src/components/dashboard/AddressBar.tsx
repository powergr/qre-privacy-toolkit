import { ArrowUp, Home, ChevronRight } from "lucide-react";

interface AddressBarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onGoUp: () => void;
}

export function AddressBar({
  currentPath,
  onNavigate,
  onGoUp,
}: AddressBarProps) {
  const isWindows = navigator.userAgent.includes("Windows");
  const separator = isWindows ? "\\" : "/";

  // Generate segments
  const segments = currentPath
    ? currentPath.split(separator).filter((s) => s.length > 0)
    : [];

  return (
    <div className="address-bar">
      {/* Replaced CornerLeftUp with ArrowUp for better compatibility */}
      <button className="nav-btn" onClick={onGoUp} title="Up One Directory">
        <ArrowUp size={20} strokeWidth={2} />
      </button>

      <div className="breadcrumbs">
        {/* Root / Drives Button */}
        <div
          className={`crumb ${segments.length === 0 ? "active" : ""}`}
          onClick={() => onNavigate("")}
          title="Drives / Root"
          style={{ display: "flex", alignItems: "center" }}
        >
          <Home size={16} />
        </div>

        {segments.map((seg, i) => {
          // Reconstruct path up to this segment
          let path = segments.slice(0, i + 1).join(separator);
          if (!isWindows) path = "/" + path;
          if (isWindows && i === 0) path += separator; // Add back slash to drive

          return (
            <div key={i} style={{ display: "flex", alignItems: "center" }}>
              <ChevronRight size={14} className="crumb-separator" />
              <div
                className={`crumb ${i === segments.length - 1 ? "active" : ""}`}
                onClick={() => onNavigate(path)}
              >
                {seg}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
