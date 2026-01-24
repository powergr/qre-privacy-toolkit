import { useState } from "react";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getPasswordStrength, getStrengthColor } from "../../utils/security";

interface PasswordInputProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  showStrength?: boolean;
  allowGenerate?: boolean;
  autoFocus?: boolean;
  className?: string;
}

export function PasswordInput({
  value,
  onChange,
  placeholder = "Password",
  showStrength = false,
  allowGenerate = false,
  autoFocus = false,
  className = "auth-input",
}: PasswordInputProps) {
  const [showPass, setShowPass] = useState(false);
  const strength = getPasswordStrength(value);

  const handleGenerate = async () => {
    try {
      const pass = await invoke<string>("generate_passphrase");
      onChange(pass);
      setShowPass(true); // Show it so the user can read the words
    } catch (e) {
      console.error("Failed to generate password:", e);
    }
  };

  return (
    <div style={{ width: "100%" }}>
      <div
        className="password-wrapper"
        style={{ position: "relative", display: "flex", alignItems: "center" }}
      >
        <input
          type={showPass ? "text" : "password"}
          className={`${className} has-icon`}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          style={{ paddingRight: allowGenerate ? "70px" : "40px" }} // Make room for 2 buttons
        />

        <div
          style={{
            position: "absolute",
            right: 0,
            height: "100%",
            display: "flex",
            alignItems: "center",
            paddingRight: 5,
          }}
        >
          {allowGenerate && (
            <button
              type="button"
              className="password-toggle"
              style={{ position: "static", width: "30px" }}
              title="Generate Strong Passphrase"
              onClick={handleGenerate}
            >
              <RefreshCw size={16} />
            </button>
          )}
          <button
            type="button"
            className="password-toggle"
            style={{ position: "static", width: "30px" }}
            onClick={() => setShowPass(!showPass)}
            tabIndex={-1}
          >
            {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
      </div>

      {/* Strength Meter */}
      {showStrength && value.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {/* Progress Bar Background */}
          <div
            style={{
              height: 4,
              width: "100%",
              background: "rgba(255,255,255,0.1)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            {/* Colored Fill */}
            <div
              style={{
                height: "100%",
                width: `${(strength.score + 1) * 20}%`,
                background: getStrengthColor(strength.score),
                transition: "width 0.3s ease, background-color 0.3s ease",
              }}
            />
          </div>

          {/* Text Feedback */}
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--text-dim)",
              marginTop: 4,
              textAlign: "right",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span style={{ color: getStrengthColor(strength.score) }}>
              {["Very Weak", "Weak", "Okay", "Good", "Strong"][strength.score]}
            </span>
            <span>{strength.feedback}</span>
          </div>
        </div>
      )}
    </div>
  );
}
