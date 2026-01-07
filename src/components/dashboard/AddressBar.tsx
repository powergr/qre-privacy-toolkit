import { ArrowUp } from "lucide-react";

interface AddressBarProps {
  currentPath: string;
  onGoUp: () => void;
}

export function AddressBar({ currentPath, onGoUp }: AddressBarProps) {
  return (
    <div className="address-bar">
      <button className="nav-btn" onClick={onGoUp}>
        <ArrowUp size={18} />
      </button>
      <input className="path-input" value={currentPath} readOnly />
    </div>
  );
}