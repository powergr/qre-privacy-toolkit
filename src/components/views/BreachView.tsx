import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck, ShieldAlert, Search, Loader2 } from "lucide-react";
import { PasswordInput } from "../common/PasswordInput";

export function BreachView() {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    found: boolean;
    count: number;
  } | null>(null);

  async function checkPassword() {
    if (!password) return;
    setLoading(true);
    setResult(null);

    try {
      // Calls the new Rust command we added
      const res = await invoke<{ found: boolean; count: number }>(
        "check_password_breach",
        { password },
      );
      setResult(res);
    } catch (e) {
      alert(
        "Error checking database. Ensure you are connected to the internet.\n\nDetails: " +
          e,
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "40px 20px",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          maxWidth: 600,
          width: "100%",
          textAlign: "center",
          marginBottom: 30,
        }}
      >
        <h2
          style={{
            color: "var(--text-main)",
            marginBottom: 10,
            fontSize: "1.8rem",
          }}
        >
          Password Breach Check
        </h2>
        <p
          style={{
            color: "var(--text-dim)",
            fontSize: "0.95rem",
            lineHeight: "1.6",
          }}
        >
          Check if your password has appeared in known data leaks (over 2
          Billion records).
          <br />
          <span style={{ color: "var(--accent)", fontWeight: "bold" }}>
            Privacy Protected:
          </span>{" "}
          We use k-Anonymity. Your password is <strong>never</strong> sent to
          any server.
        </p>
      </div>

      <div
        className="modern-card"
        style={{ maxWidth: 500, width: "100%", padding: 30 }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <PasswordInput
            value={password}
            onChange={(val) => {
              setPassword(val);
              if (result) setResult(null); // Clear result on typing
            }}
            placeholder="Enter a password to check..."
            showStrength={false}
            autoFocus
          />

          <button
            className="auth-btn"
            onClick={checkPassword}
            disabled={loading || !password}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              padding: 12,
            }}
          >
            {loading ? (
              <Loader2 className="spinner" size={20} />
            ) : (
              <Search size={20} />
            )}
            {loading ? "Checking Database..." : "Check Now"}
          </button>
        </div>
      </div>

      {result !== null && (
        <div
          className="modern-card"
          style={{
            maxWidth: 500,
            width: "100%",
            marginTop: 20,
            borderColor: result.found
              ? "var(--btn-danger)"
              : "var(--btn-success)",
            backgroundColor: result.found
              ? "rgba(217, 64, 64, 0.05)"
              : "rgba(66, 184, 131, 0.05)",
          }}
        >
          {result.found ? (
            <div style={{ color: "var(--btn-danger)", textAlign: "center" }}>
              <ShieldAlert size={56} style={{ marginBottom: 10 }} />
              <h3 style={{ margin: "0 0 10px 0", fontSize: "1.4rem" }}>
                ⚠️ COMPROMISED
              </h3>
              <p style={{ color: "var(--text-main)" }}>
                This password has appeared in{" "}
                <strong>{result.count.toLocaleString()}</strong> known data
                breaches.
              </p>
              <p
                style={{
                  fontWeight: "bold",
                  marginTop: 15,
                  color: "var(--text-main)",
                }}
              >
                Do not use this password.
              </p>
            </div>
          ) : (
            <div style={{ color: "var(--btn-success)", textAlign: "center" }}>
              <ShieldCheck size={56} style={{ marginBottom: 10 }} />
              <h3 style={{ margin: "0 0 10px 0", fontSize: "1.4rem" }}>
                ✅ CLEAN
              </h3>
              <p style={{ color: "var(--text-main)" }}>
                This password was not found in the public breach database.
              </p>
              <p
                style={{
                  fontSize: "0.85rem",
                  marginTop: 15,
                  opacity: 0.8,
                  color: "var(--text-dim)",
                }}
              >
                (This does not guarantee it is unguessable, only that it hasn't
                been leaked yet.)
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
