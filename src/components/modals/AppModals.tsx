import { X, Info, AlertTriangle, Key } from "lucide-react";
import { getPasswordScore, getStrengthColor } from "../../utils/security";
// --- ABOUT MODAL ---
export function AboutModal({ onClose }: { onClose: () => void }) {
return (
<div className="modal-overlay" onClick={onClose}>
<div className="auth-card" onClick={(e) => e.stopPropagation()}>
<div className="modal-header">
<Info size={20} color="var(--accent)" />
<h2>About QRE Locker</h2>
<div style={{ flex: 1 }}></div>
<X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
</div>
<div className="modal-body" style={{ textAlign: "center" }}>
<p><strong>Version 2.2.2</strong></p>
<p style={{ color: "#aaa", fontSize: "0.9rem" }}>
Securing your files with AES-256-GCM and Post-Quantum Kyber-1024.
</p>
<button className="secondary-btn" onClick={onClose}>Close</button>
</div>
</div>
</div>
);
}
// --- RESET CONFIRM MODAL ---
export function ResetConfirmModal({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
return (
<div className="modal-overlay" onClick={onCancel}>
<div className="auth-card" onClick={(e) => e.stopPropagation()}>
<div className="modal-header">
<AlertTriangle size={20} color="var(--warning)" />
<h2>Reset Recovery Code?</h2>
</div>
<div className="modal-body">
<p style={{ color: "#ccc" }}>This will invalidate your old code immediately. You must print/save the new one.</p>
<div style={{ display: "flex", gap: 10 }}>
<button className="auth-btn danger-btn" onClick={onConfirm}>
Confirm Reset
</button>
<button className="secondary-btn" style={{ flex: 1 }} onClick={onCancel}>
Cancel
</button>
</div>
</div>
</div>
</div>
);
}
// --- CHANGE PASSWORD MODAL ---
interface ChangePassProps {
pass: string; setPass: (s: string) => void;
confirm: string; setConfirm: (s: string) => void;
onUpdate: () => void;
onCancel: () => void;
}
export function ChangePassModal({ pass, setPass, setConfirm, onUpdate, onCancel }: ChangePassProps) {
const score = getPasswordScore(pass);
return (
<div className="modal-overlay">
<div className="auth-card">
<div className="modal-header">
<Key size={20} color="var(--accent)" />
<h2>Change Password</h2>
</div>
<div className="modal-body">
<input type="password" className="auth-input" placeholder="New Password"
onChange={(e) => setPass(e.target.value)} />
{pass && (
        <div style={{ marginTop: "5px", marginBottom: "5px" }}>
          <div style={{ height: "4px", width: "100%", background: "#2f3448", borderRadius: "2px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(score + 1) * 20}%`, background: getStrengthColor(score) }} />
          </div>
        </div>
      )}

      <input type="password" className="auth-input" placeholder="Confirm"
        onChange={(e) => setConfirm(e.target.value)} />

      <div style={{ display: "flex", gap: 10 }}>
        <button className="auth-btn" style={{ flex: 1 }} onClick={onUpdate}>Update</button>
        <button className="secondary-btn" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>
</div>
);
}