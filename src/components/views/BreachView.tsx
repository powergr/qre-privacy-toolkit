import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ShieldCheck,
  ShieldAlert,
  Search,
  Loader2,
  Globe,
  Radio,
  Download,
  CheckCircle,
  AlertTriangle,
} from "lucide-react";
import { PasswordInput } from "../common/PasswordInput";

export function BreachView() {
  const [activeTab, setActiveTab] = useState<"breach" | "network">("breach");

  // --- BREACH STATE ---
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    found: boolean;
    count: number;
  } | null>(null);

  // --- NETWORK STATE ---
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [isWarp, setIsWarp] = useState(false);
  const [ipLoading, setIpLoading] = useState(false);

  // --- ACTIONS ---

  async function checkPassword() {
    if (!password) return;
    setLoading(true);
    setResult(null);

    try {
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

  async function checkIp() {
    setIpLoading(true);
    try {
      const res = await invoke<{ ip: string; is_warp: boolean }>(
        "get_public_ip_address",
      );
      setPublicIp(res.ip);
      setIsWarp(res.is_warp);
    } catch {
      setPublicIp("Unknown (Offline?)");
    } finally {
      setIpLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === "network" && !publicIp) {
      checkIp();
    }
  }, [activeTab]);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: "30px",
        overflowY: "auto",
      }}
    >
      {/* HEADER */}
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: "1.8rem" }}>Privacy Check</h2>
        <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
          Verify your digital identity and network exposure.
        </p>
      </div>

      {/* TABS */}
      <div
        style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}
      >
        <div
          style={{
            display: "flex",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            padding: "4px",
          }}
        >
          <button
            onClick={() => setActiveTab("breach")}
            style={{
              padding: "8px 20px",
              borderRadius: "6px",
              border: "none",
              background:
                activeTab === "breach" ? "var(--accent)" : "transparent",
              color: activeTab === "breach" ? "white" : "var(--text-dim)",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Identity Breach
          </button>
          <button
            onClick={() => setActiveTab("network")}
            style={{
              padding: "8px 20px",
              borderRadius: "6px",
              border: "none",
              background:
                activeTab === "network" ? "var(--accent)" : "transparent",
              color: activeTab === "network" ? "white" : "var(--text-dim)",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Network Security
          </button>
        </div>
      </div>

      {/* --- TAB 1: BREACH CHECK --- */}
      {activeTab === "breach" && (
        <div
          style={{
            maxWidth: 500,
            width: "100%",
            margin: "0 auto",
            animation: "fadeIn 0.3s ease",
          }}
        >
          <div className="modern-card" style={{ padding: 30 }}>
            <p
              style={{
                marginTop: 0,
                marginBottom: 20,
                color: "var(--text-dim)",
                lineHeight: "1.5",
                fontSize: "0.9rem",
                textAlign: "center",
              }}
            >
              Check if your password appears in the{" "}
              <strong>HIBP Database</strong> (850M+ leaks).
              <br />
              <br />
              <span style={{ color: "var(--success)" }}>
                ✓ Zero-Knowledge:
              </span>{" "}
              We verify locally using k-Anonymity. Your password never leaves
              this device.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <PasswordInput
                value={password}
                onChange={(val) => {
                  setPassword(val);
                  if (result) setResult(null);
                }}
                placeholder="Enter password to verify..."
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
                {loading ? "Scanning Database..." : "Scan Now"}
              </button>
            </div>
          </div>

          {/* RESULTS */}
          {result !== null && (
            <div
              className="modern-card"
              style={{
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
                <div
                  style={{ color: "var(--btn-danger)", textAlign: "center" }}
                >
                  <ShieldAlert size={56} style={{ marginBottom: 10 }} />
                  <h3 style={{ margin: "0 0 10px 0", fontSize: "1.4rem" }}>
                    ⚠️ COMPROMISED
                  </h3>
                  <p style={{ color: "var(--text-main)" }}>
                    Found in <strong>{result.count.toLocaleString()}</strong>{" "}
                    data breaches.
                    <br />
                    Do not use this password.
                  </p>
                </div>
              ) : (
                <div
                  style={{ color: "var(--btn-success)", textAlign: "center" }}
                >
                  <ShieldCheck size={56} style={{ marginBottom: 10 }} />
                  <h3 style={{ margin: "0 0 10px 0", fontSize: "1.4rem" }}>
                    ✅ CLEAN
                  </h3>
                  <p style={{ color: "var(--text-main)" }}>
                    Not found in public leaks.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* --- TAB 2: NETWORK SECURITY --- */}
      {activeTab === "network" && (
        <div
          style={{
            maxWidth: 600,
            width: "100%",
            margin: "0 auto",
            animation: "fadeIn 0.3s ease",
          }}
        >
          {/* STATUS CARD (COMPACT) */}
          <div
            className="modern-card"
            style={{
              padding: 20, // Reduced from 25
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              marginBottom: 15, // Reduced margin
              borderColor: isWarp ? "var(--success)" : "#f59e0b",
              background: isWarp
                ? "rgba(34, 197, 94, 0.05)"
                : "rgba(245, 158, 11, 0.05)",
            }}
          >
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: "50%", // Reduced from 60
                background: isWarp
                  ? "rgba(34, 197, 94, 0.15)"
                  : "rgba(245, 158, 11, 0.15)",
                color: isWarp ? "var(--success)" : "#f59e0b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 10, // Reduced margin
              }}
            >
              {isWarp ? <CheckCircle size={28} /> : <AlertTriangle size={28} />}
            </div>

            <h3 style={{ margin: 0, fontSize: "1.1rem" }}>
              {isWarp ? "Secure Connection" : "Unverified Network"}
            </h3>

            <div
              style={{
                fontSize: "1.5rem",
                fontWeight: "bold",
                margin: "10px 0", // Reduced size and margin
                fontFamily: "monospace",
                letterSpacing: "1px",
              }}
            >
              {ipLoading ? <Loader2 className="spinner" /> : publicIp || "---"}
            </div>

            <div
              style={{
                background: isWarp
                  ? "rgba(34, 197, 94, 0.1)"
                  : "rgba(245, 158, 11, 0.1)",
                color: isWarp ? "var(--success)" : "#f59e0b",
                padding: "6px 12px",
                borderRadius: "20px",
                fontSize: "0.8rem", // Compact badge
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: "bold",
              }}
            >
              {isWarp ? (
                <>
                  <ShieldCheck size={14} /> Encrypted via Cloudflare Warp
                </>
              ) : (
                <>
                  <Radio size={14} /> Public IP is Visible
                </>
              )}
            </div>
          </div>

          {/* WARP RECOMMENDATION CARD (COMPACT) */}
          {!isWarp && (
            <div
              className="modern-card"
              style={{
                padding: 0,
                overflow: "hidden",
                border: "1px solid rgba(246, 130, 31, 0.4)",
                background: "var(--bg-card)",
              }}
            >
              <div style={{ padding: 20 }}>
                {" "}
                {/* Reduced padding from 30 */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <Globe size={20} color="#f6821f" />
                    <h3
                      style={{
                        margin: 0,
                        fontSize: "1.1rem",
                        color: "var(--text-main)",
                      }}
                    >
                      Protect Your Traffic
                    </h3>
                  </div>
                  <div
                    style={{
                      background: "rgba(246, 130, 31, 0.1)",
                      color: "#f6821f",
                      padding: "2px 8px",
                      borderRadius: "4px",
                      fontSize: "0.75rem",
                      fontWeight: "bold",
                    }}
                  >
                    FREE
                  </div>
                </div>
                {/* NUANCED TEXT */}
                <p
                  style={{
                    color: "var(--text-dim)",
                    lineHeight: 1.5,
                    marginBottom: 15,
                    fontSize: "0.9rem",
                  }}
                >
                  Your public IP address is visible. If you are already using a
                  VPN (e.g., NordVPN, Proton), you are safe.
                  <br />
                  <br />
                  If not, we recommend <strong>Cloudflare WARP</strong>. It
                  creates an encrypted tunnel to mask your location and prevent
                  your ISP from tracking you.
                </p>
                <button
                  onClick={() => openUrl("https://one.one.one.one")}
                  style={{
                    background: "var(--text-main)",
                    color: "var(--bg-color)",
                    border: "none",
                    padding: "10px 20px", // Slightly thinner button
                    borderRadius: "8px",
                    fontWeight: "bold",
                    fontSize: "0.95rem",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    width: "100%",
                  }}
                >
                  <Download size={18} /> Download WARP (1.1.1.1)
                </button>
              </div>
            </div>
          )}

          {isWarp && (
            <p
              style={{
                textAlign: "center",
                color: "var(--text-dim)",
                marginTop: 20,
              }}
            >
              You are protected. Your ISP cannot see your browsing history.
            </p>
          )}

          {/* DISCLAIMER */}
          <p
            style={{
              textAlign: "center",
              fontSize: "0.75rem",
              color: "var(--text-dim)",
              marginTop: 15,
              opacity: 0.6,
            }}
          >
            QRE recommends Cloudflare Warp for privacy, but is not affiliated
            with Cloudflare, Inc.
          </p>
        </div>
      )}
    </div>
  );
}
