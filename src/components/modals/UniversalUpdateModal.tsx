import { useState, useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { UpdateModal } from "./UpdateModal";
import { AndroidUpdateChecker } from "./AndroidUpdateChecker";
import { RefreshCw } from "lucide-react";

interface UniversalUpdateModalProps {
  onClose: () => void;
}

export function UniversalUpdateModal({ onClose }: UniversalUpdateModalProps) {
  const [currentPlatform, setCurrentPlatform] = useState<string | null>(null);

  useEffect(() => {
    // Detect platform safely
    try {
      const os = platform();
      setCurrentPlatform(os);
    } catch (e) {
      console.error("Failed to detect platform:", e);
      setCurrentPlatform("unknown");
    }
  }, []);

  if (!currentPlatform) {
    // Loading state while checking platform
    return (
      <div className="modal-overlay" style={{ zIndex: 99999 }}>
        <div
          className="auth-card"
          style={{ width: 300, textAlign: "center", padding: 30 }}
        >
          <RefreshCw className="spinner" size={32} color="var(--accent)" />
          <p style={{ marginTop: 15, color: "var(--text-dim)" }}>
            Initializing...
          </p>
        </div>
      </div>
    );
  }

  // --- ROUTING LOGIC ---

  if (currentPlatform === "android") {
    return <AndroidUpdateChecker onClose={onClose} />;
  }

  // Default to Desktop Updater for Windows, macOS, Linux
  return <UpdateModal onClose={onClose} />;
}
