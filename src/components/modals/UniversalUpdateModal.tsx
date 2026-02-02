// UniversalUpdateModal.tsx
// Automatically uses the correct updater based on platform

import { useState, useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { UpdateModal } from "./UpdateModal"; // Your existing desktop updater
import { AndroidUpdateChecker } from "./AndroidUpdateChecker";

interface UniversalUpdateModalProps {
  onClose: () => void;
}

export function UniversalUpdateModal({ onClose }: UniversalUpdateModalProps) {
  const [currentPlatform, setCurrentPlatform] = useState<string>("");

  useEffect(() => {
    const currentPlatform = platform();
    setCurrentPlatform(currentPlatform);
  }, []);

  // Show Android updater on Android, desktop updater otherwise
  if (currentPlatform === "android") {
    return <AndroidUpdateChecker onClose={onClose} />;
  }

  return <UpdateModal onClose={onClose} />;
}
