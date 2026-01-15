import { useState, useEffect, useRef } from "react";

interface EntropyModalProps {
  onComplete: (entropy: number[]) => void;
  onCancel: () => void;
}

export function EntropyModal({ onComplete, onCancel }: EntropyModalProps) {
  const [progress, setProgress] = useState(0);
  const [hashView, setHashView] = useState("Waiting for input...");

  // Store raw entropy values
  const entropyPool = useRef<number[]>([]);
  const lastPos = useRef({ x: 0, y: 0 });

  // Unified logic for processing coordinates (Mouse or Touch)
  const processMovement = (clientX: number, clientY: number) => {
    if (progress >= 100) return;

    // Calculate distance to ensure they aren't just hovering
    const deltaX = Math.abs(clientX - lastPos.current.x);
    const deltaY = Math.abs(clientY - lastPos.current.y);
    const distance = Math.sqrt(deltaX ** 2 + deltaY ** 2);

    // Only collect if they moved enough pixels
    if (distance > 5) {
      lastPos.current = { x: clientX, y: clientY };

      // Collect data: Coordinates + Timestamp + Random Jitter
      // This mixes physical world data with high-res timing
      const time = performance.now();
      const raw = Math.floor(clientX * clientY + time);

      // Normalize to byte range (0-255) for easy consumption by backend
      entropyPool.current.push(raw % 255);

      // Update UI (Hash View) - Just visual noise for effect
      const randomDisplay = Array.from(
        window.crypto.getRandomValues(new Uint8Array(16))
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      setHashView(randomDisplay);

      // Increase Progress (Requires steady movement)
      setProgress((prev) => Math.min(prev + 1.5, 100));
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    processMovement(e.clientX, e.clientY);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    // Check if there is at least one touch point
    if (e.touches.length > 0) {
      const touch = e.touches[0];
      processMovement(touch.clientX, touch.clientY);
    }
  };

  useEffect(() => {
    if (progress >= 100) {
      // Finished! Small delay for UX
      setTimeout(() => {
        onComplete(entropyPool.current);
      }, 300);
    }
  }, [progress, onComplete]);

  return (
    <div
      className="modal-overlay"
      // touchAction: none prevents the browser from scrolling while dragging
      style={{ zIndex: 100005, cursor: "crosshair", touchAction: "none" }}
      onMouseMove={handleMouseMove}
      onTouchMove={handleTouchMove}
    >
      <div
        className="auth-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 450,
          maxWidth: "90%",
          textAlign: "center",
          padding: "40px 20px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: 20,
          }}
        >
          {/* Custom CSS Spinner defined in App.css */}
          <div className="spinner"></div>
        </div>

        <h2 style={{ margin: 0, color: "var(--text-main)" }}>
          Generating Entropy
        </h2>
        <p style={{ color: "var(--text-dim)", marginTop: 10 }}>
          Please move your mouse or finger randomly within this window to
          generate the cryptographic seed.
        </p>

        {/* VISUAL HASH PREVIEW */}
        <div
          style={{
            fontFamily: "monospace",
            background: "var(--bg-color)",
            padding: 10,
            margin: "20px 0",
            borderRadius: 4,
            color: "var(--accent)",
            fontSize: "0.85rem",
            wordBreak: "break-all",
            border: "1px solid var(--border)",
          }}
        >
          {hashView}
        </div>

        {/* PROGRESS BAR */}
        <div className="progress-container" style={{ height: 15 }}>
          <div
            className="progress-fill"
            style={{
              width: `${progress}%`,
              background:
                progress >= 100 ? "var(--btn-success)" : "var(--accent)",
            }}
          ></div>
        </div>
        <p
          style={{
            fontWeight: "bold",
            marginTop: 5,
            color: "var(--text-main)",
          }}
        >
          {Math.round(progress)}%
        </p>

        <button
          className="secondary-btn"
          style={{ marginTop: 20 }}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
