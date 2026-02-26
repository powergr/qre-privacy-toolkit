import { useState, useEffect, useRef } from "react";
import { ArrowUp, Home, ChevronRight, X } from "lucide-react";

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
  const [isEditing, setIsEditing] = useState(false);
  const [tempPath, setTempPath] = useState(currentPath);
  const inputRef = useRef<HTMLInputElement>(null);

  const isWindows = navigator.userAgent.includes("Windows");
  const separator = isWindows ? "\\" : "/";

  useEffect(() => {
    setTempPath(currentPath);
  }, [currentPath]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      commitPath();
    } else if (e.key === "Escape") {
      setIsEditing(false);
      setTempPath(currentPath);
    }
  };

  const commitPath = () => {
    if (tempPath.trim() !== currentPath) {
      onNavigate(tempPath.trim());
    }
    setIsEditing(false);
  };

  // Generate segments for breadcrumbs
  const segments = currentPath
    ? currentPath.split(separator).filter((s) => s.length > 0)
    : [];

  return (
    <div className="address-bar">
      <button className="nav-btn" onClick={onGoUp} title="Up One Directory">
        <ArrowUp size={20} strokeWidth={2} />
      </button>

      <div
        className="address-container"
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "4px 8px",
          height: 36,
          overflow: "hidden",
        }}
      >
        {isEditing ? (
          <div style={{ display: "flex", width: "100%", alignItems: "center" }}>
            <input
              ref={inputRef}
              value={tempPath}
              onChange={(e) => setTempPath(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={commitPath}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                color: "var(--text-main)",
                fontSize: "0.9rem",
                fontFamily: "monospace",
                outline: "none",
              }}
            />
            <X
              size={16}
              style={{ cursor: "pointer", marginLeft: 8 }}
              onClick={() => {
                setIsEditing(false);
                setTempPath(currentPath);
              }}
            />
          </div>
        ) : (
          <div
            className="breadcrumbs"
            onClick={() => setIsEditing(true)}
            title="Click to edit path"
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              cursor: "text",
            }}
          >
            {/* Root / Drives Button */}
            <div
              className={`crumb ${segments.length === 0 ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onNavigate("");
              }}
              style={{ display: "flex", alignItems: "center", paddingRight: 4 }}
            >
              <Home size={16} />
            </div>

            {segments.map((seg, i) => {
              let path = segments.slice(0, i + 1).join(separator);
              if (!isWindows) path = "/" + path;
              if (isWindows && i === 0) path += separator;

              return (
                <div key={i} style={{ display: "flex", alignItems: "center" }}>
                  <ChevronRight
                    size={14}
                    className="crumb-separator"
                    style={{ opacity: 0.5 }}
                  />
                  <div
                    className="crumb"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNavigate(path);
                    }}
                    style={{
                      padding: "0 4px",
                      borderRadius: 4,
                      cursor: "pointer",
                    }}
                  >
                    {seg}
                  </div>
                </div>
              );
            })}

            {/* Spacer to allow clicking empty area to edit */}
            <div style={{ flex: 1, height: "100%" }}></div>
          </div>
        )}
      </div>
    </div>
  );
}
