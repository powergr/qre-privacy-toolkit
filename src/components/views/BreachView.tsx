import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  Mail,
  ExternalLink,
  Key,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PasswordInput } from "../common/PasswordInput";

// --- CLIENT SIDE HASHING ---
async function sha1Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

interface BreachInfo {
  Name: string;
  Title: string;
  Domain: string;
  BreachDate: string;
  Description: string;
  PwnCount: number;
  DataClasses: string[];
  IsVerified: boolean;
}

export function BreachView() {
  // Tabs: Password | Email | Network
  const [activeTab, setActiveTab] = useState<"password" | "email" | "network">(
    "password",
  );

  // --- PASSWORD STATE ---
  const [password, setPassword] = useState("");
  const [passLoading, setPassLoading] = useState(false);
  const [passResult, setPassResult] = useState<{
    found: boolean;
    count: number;
  } | null>(null);
  const [passError, setPassError] = useState<string | null>(null);
  const [lastCheckTime, setLastCheckTime] = useState(0);

  // --- EMAIL STATE ---
  const [email, setEmail] = useState("");
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem("hibp_api_key") || "",
  );
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailBreaches, setEmailBreaches] = useState<BreachInfo[] | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  // --- NETWORK STATE ---
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [isWarp, setIsWarp] = useState(false);
  const [ipLoading, setIpLoading] = useState(false);
  const [ipService, setIpService] = useState("");

  // --- ACTIONS ---

  async function checkPassword() {
    if (!password.trim()) {
      setPassError("Please enter a password.");
      return;
    }
    if (Date.now() - lastCheckTime < 2000) {
      setPassError("Please wait a moment.");
      return;
    }

    setPassLoading(true);
    setPassResult(null);
    setPassError(null);
    setLastCheckTime(Date.now());
    try {
      const hash = await sha1Hex(password);
      const res = await invoke<{ found: boolean; count: number }>(
        "check_password_breach",
        { sha1Hash: hash },
      );
      setPassResult(res);
    } catch (e) {
      setPassError("Connection failed: " + e);
    } finally {
      setPassLoading(false);
    }
  }

  async function checkEmail() {
    if (!email.trim() || !email.includes("@")) {
      setEmailError("Invalid email address.");
      return;
    }

    // If no API key, offer external link
    if (!apiKey.trim()) {
      setEmailError(
        "API Key required for inline check. Use the button below to check for free on the website.",
      );
      return;
    }

    setEmailLoading(true);
    setEmailBreaches(null);
    setEmailError(null);
    localStorage.setItem("hibp_api_key", apiKey); // Save key for convenience

    try {
      const res = await invoke<BreachInfo[]>("check_email_breach", {
        email,
        apiKey,
      });
      setEmailBreaches(res);
    } catch (e) {
      setEmailError("API Error: " + e);
    } finally {
      setEmailLoading(false);
    }
  }

  async function checkIp() {
    setIpLoading(true);
    try {
      const res = await invoke<{
        ip: string;
        is_warp: boolean;
        service_used: string;
      }>("get_public_ip_address");
      setPublicIp(res.ip);
      setIsWarp(res.is_warp);
      setIpService(res.service_used);
    } catch {
      setPublicIp("Unknown");
    } finally {
      setIpLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === "network" && !publicIp) checkIp();
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
      <div style={{ textAlign: "center", marginBottom: 30 }}>
        <h2 style={{ margin: 0, fontSize: "1.8rem" }}>Privacy Check</h2>
        <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
          Verify your digital identity and network exposure.
        </p>
      </div>

      {/* TABS */}
      <div
        style={{ display: "flex", justifyContent: "center", marginBottom: 30 }}
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
          {["password", "email", "network"].map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t as any)}
              style={{
                padding: "8px 20px",
                borderRadius: "6px",
                border: "none",
                background: activeTab === t ? "var(--accent)" : "transparent",
                color: activeTab === t ? "white" : "var(--text-dim)",
                cursor: "pointer",
                fontWeight: 500,
                textTransform: "capitalize",
              }}
            >
              {t} Breach
            </button>
          ))}
        </div>
      </div>

      {/* --- TAB 1: PASSWORD BREACH --- */}
      {activeTab === "password" && (
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
              Check if your password appears in known leaks (850M+ records).
              <br />
              <span style={{ color: "var(--success)" }}>
                ✓ Zero-Knowledge:
              </span>{" "}
              Hash calculated locally.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <PasswordInput
                value={password}
                onChange={(val) => {
                  setPassword(val);
                  setPassResult(null);
                  setPassError(null);
                }}
                placeholder="Enter password to verify..."
                showStrength={false}
                autoFocus
              />
              <button
                className="auth-btn"
                onClick={checkPassword}
                disabled={passLoading || !password}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  padding: 12,
                }}
              >
                {passLoading ? (
                  <Loader2 className="spinner" size={20} />
                ) : (
                  <Search size={20} />
                )}
                {passLoading ? "Checking..." : "Scan Password"}
              </button>
            </div>
            {passError && (
              <div
                style={{
                  marginTop: 15,
                  padding: 10,
                  borderRadius: 6,
                  background: "rgba(239, 68, 68, 0.1)",
                  color: "var(--btn-danger)",
                  fontSize: "0.9rem",
                  display: "flex",
                  gap: 10,
                }}
              >
                <AlertTriangle size={16} /> {passError}
              </div>
            )}
          </div>
          {passResult && (
            <div
              className="modern-card"
              style={{
                marginTop: 20,
                borderColor: passResult.found
                  ? "var(--btn-danger)"
                  : "var(--btn-success)",
                backgroundColor: passResult.found
                  ? "rgba(217, 64, 64, 0.05)"
                  : "rgba(66, 184, 131, 0.05)",
              }}
            >
              {passResult.found ? (
                <div
                  style={{ color: "var(--btn-danger)", textAlign: "center" }}
                >
                  <ShieldAlert size={56} style={{ marginBottom: 10 }} />
                  <h3 style={{ margin: "0 0 10px 0", fontSize: "1.4rem" }}>
                    ⚠️ COMPROMISED
                  </h3>
                  <p style={{ color: "var(--text-main)" }}>
                    Found in{" "}
                    <strong>{passResult.count.toLocaleString()}</strong>{" "}
                    breaches.
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

      {/* --- TAB 2: EMAIL BREACH (NEW) --- */}
      {activeTab === "email" && (
        <div
          style={{
            maxWidth: 600,
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
              Check which services have leaked your email address.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--bg-color)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "0 10px",
                }}
              >
                <Mail size={18} color="var(--text-dim)" />
                <input
                  className="auth-input"
                  style={{
                    border: "none",
                    background: "transparent",
                    paddingLeft: 0,
                  }}
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--bg-color)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "0 10px",
                }}
              >
                <Key size={18} color="var(--text-dim)" />
                <input
                  className="auth-input"
                  style={{
                    border: "none",
                    background: "transparent",
                    paddingLeft: 0,
                  }}
                  type="password"
                  placeholder="HIBP API Key (Optional)"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="auth-btn"
                  onClick={checkEmail}
                  disabled={emailLoading}
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    padding: 12,
                  }}
                >
                  {emailLoading ? (
                    <Loader2 className="spinner" size={20} />
                  ) : (
                    <Search size={20} />
                  )}
                  {emailLoading ? "Scanning..." : "Scan with API"}
                </button>

                <button
                  className="secondary-btn"
                  onClick={() =>
                    openUrl(`https://haveibeenpwned.com/account/${email}`)
                  }
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                  }}
                >
                  <ExternalLink size={20} /> Check Website (Free)
                </button>
              </div>
            </div>

            {emailError && (
              <div
                style={{
                  marginTop: 15,
                  padding: 10,
                  borderRadius: 6,
                  background: "rgba(239, 68, 68, 0.1)",
                  color: "var(--btn-danger)",
                  fontSize: "0.85rem",
                }}
              >
                {emailError}
              </div>
            )}
          </div>

          {/* EMAIL RESULTS */}
          {emailBreaches && (
            <div style={{ marginTop: 20 }}>
              {emailBreaches.length === 0 ? (
                <div
                  className="modern-card"
                  style={{ textAlign: "center", color: "#4ade80" }}
                >
                  <CheckCircle size={48} style={{ marginBottom: 10 }} />
                  <h3>Good News! No breaches found.</h3>
                </div>
              ) : (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 15 }}
                >
                  <h3 style={{ margin: 0, color: "var(--btn-danger)" }}>
                    {emailBreaches.length} Breaches Found:
                  </h3>
                  {emailBreaches.map((b) => (
                    <div
                      key={b.Name}
                      className="modern-card"
                      style={{ padding: 20, borderColor: "var(--btn-danger)" }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                        }}
                      >
                        <h3 style={{ margin: 0 }}>{b.Title}</h3>
                        <span
                          style={{
                            fontSize: "0.8rem",
                            background: "var(--bg-color)",
                            padding: "2px 8px",
                            borderRadius: 4,
                          }}
                        >
                          {b.BreachDate}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "0.85rem",
                          color: "var(--text-dim)",
                          margin: "10px 0",
                        }}
                        dangerouslySetInnerHTML={{ __html: b.Description }}
                      />
                      <div
                        style={{ display: "flex", gap: 5, flexWrap: "wrap" }}
                      >
                        {b.DataClasses.map((d) => (
                          <span
                            key={d}
                            style={{
                              fontSize: "0.75rem",
                              background: "rgba(239, 68, 68, 0.1)",
                              color: "var(--btn-danger)",
                              padding: "2px 6px",
                              borderRadius: 4,
                            }}
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* --- TAB 3: NETWORK --- */}
      {activeTab === "network" && (
        <div
          style={{
            maxWidth: 600,
            width: "100%",
            margin: "0 auto",
            animation: "fadeIn 0.3s ease",
          }}
        >
          <div
            className="modern-card"
            style={{
              padding: 20,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              marginBottom: 15,
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
                borderRadius: "50%",
                background: isWarp
                  ? "rgba(34, 197, 94, 0.15)"
                  : "rgba(245, 158, 11, 0.15)",
                color: isWarp ? "var(--success)" : "#f59e0b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 10,
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
                margin: "10px 0",
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
                fontSize: "0.8rem",
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
            <div
              style={{
                marginTop: 10,
                fontSize: "0.7rem",
                color: "var(--text-dim)",
              }}
            >
              Source: {ipService}
            </div>
          </div>

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
                      borderRadius: 4,
                      fontSize: "0.75rem",
                      fontWeight: "bold",
                    }}
                  >
                    FREE
                  </div>
                </div>
                <p
                  style={{
                    color: "var(--text-dim)",
                    lineHeight: 1.5,
                    marginBottom: 15,
                    fontSize: "0.9rem",
                  }}
                >
                  Your public IP is exposed. If you are already using a VPN
                  (NordVPN, Proton), you are safe.
                  <br />
                  <br />
                  If not, we recommend <strong>Cloudflare WARP</strong>. It
                  creates an encrypted tunnel to mask your location.
                </p>
                <button
                  onClick={() => openUrl("https://one.one.one.one")}
                  style={{
                    background: "var(--text-main)",
                    color: "var(--bg-color)",
                    border: "none",
                    padding: "10px 20px",
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
        </div>
      )}
    </div>
  );
}
