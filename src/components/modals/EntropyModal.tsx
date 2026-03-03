import { useState, useEffect, useRef } from "react";

interface EntropyModalProps {
  onComplete: (entropy: number[]) => void;
  onCancel: () => void;
}

export function EntropyModal({ onComplete, onCancel }: EntropyModalProps) {
  const [progress, setProgress] = useState(0);
  const [hashView, setHashView] = useState("Waiting for input...");

  // Store raw entropy values. We need exactly 32 bytes.
  const entropyPool = useRef<number[]>([]);
  const lastPos = useRef({ x: 0, y: 0 });
  const lastTimestamp = useRef<number>(performance.now());

  // Unified logic for processing coordinates (Mouse or Touch)
  const processMovement = (clientX: number, clientY: number) => {
    if (progress >= 100) return;

    // Calculate distance to ensure they aren't just holding still
    const deltaX = Math.abs(clientX - lastPos.current.x);
    const deltaY = Math.abs(clientY - lastPos.current.y);
    const distance = Math.sqrt(deltaX ** 2 + deltaY ** 2);

    // Only collect if they actually moved
    if (distance > 5) {
      const now = performance.now();
      // The true entropy comes from the unpredictable timing jitter between human movements
      const timeDelta = now - lastTimestamp.current;

      lastPos.current = { x: clientX, y: clientY };
      lastTimestamp.current = now;

      // Extract the least significant bits of the timing delta (the most unpredictable part)
      const jitterByte = Math.floor(timeDelta * 1000) & 0xff;

      // Pull a truly random byte from the OS to mix with our physical jitter
      const cryptoByte = window.crypto.getRandomValues(new Uint8Array(1))[0];

      // XOR them together to guarantee maximum unpredictability, ensuring we get a full 0-255 range.
      const secureByte = cryptoByte ^ jitterByte;
      entropyPool.current.push(secureByte);

      // Update UI (Hash View) - Visual feedback for the user
      const randomDisplay = Array.from(
        window.crypto.getRandomValues(new Uint8Array(16)),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      setHashView(randomDisplay);

      // We need 32 bytes of entropy. If we collect 1 byte per movement,
      // adding ~1.5 to progress means it takes ~66 distinct movements to fill the pool.
      // We will slice exactly 32 bytes on completion.
      setProgress((prev) => Math.min(prev + 1.5, 100));
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    processMovement(e.clientX, e.clientY);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length > 0) {
      const touch = e.touches[0];
      processMovement(touch.clientX, touch.clientY);
    }
  };

  useEffect(() => {
    if (progress >= 100) {
      // Finished!
      setTimeout(() => {
        // Ensure we only ever return exactly 32 bytes of the highest quality collected entropy
        // If we collected more due to rapid movement, just take the last 32 bytes.
        let finalEntropy = entropyPool.current;
        if (finalEntropy.length > 32) {
          finalEntropy = finalEntropy.slice(finalEntropy.length - 32);
        } else
          while (finalEntropy.length < 32) {
            // Fallback: If somehow we hit 100% without 32 bytes, fill the rest with OS CSPRNG
            finalEntropy.push(
              window.crypto.getRandomValues(new Uint8Array(1))[0],
            );
          }

        onComplete(finalEntropy);
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
