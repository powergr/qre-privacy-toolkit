import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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
  Mail,
  ExternalLink,
  Copy,
  Check,
  RefreshCw,
  FolderSearch,
  FileText,
} from "lucide-react";
import { PasswordInput } from "../common/PasswordInput";

// ... [KEEP YOUR EXISTING sha1Hex AND getPasswordStrength FUNCTIONS HERE] ...
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

function getPasswordStrength(pwd: string) {
  const hasUpper = /[A-Z]/.test(pwd);
  const hasLower = /[a-z]/.test(pwd);
  const hasDigit = /[0-9]/.test(pwd);
  const hasSpecial = /[^A-Za-z0-9]/.test(pwd);
  let score = 0;
  if (hasUpper) score++;
  if (hasLower) score++;
  if (hasDigit) score++;
  if (hasSpecial) score++;
  if (pwd.length >= 12) score++;
  if (pwd.length >= 16) score++;
  if (pwd.length < 8) return { label: "Very Weak", color: "#ef4444", score: 0 };
  if (score <= 2) return { label: "Weak", color: "#f97316", score: 1 };
  if (score === 3 || score === 4)
    return { label: "Medium", color: "#eab308", score: 2 };
  return { label: "Strong", color: "#22c55e", score: 3 };
}

export function BreachView() {
  const [activeTab, setActiveTab] = useState<
    "local" | "password" | "email" | "network"
  >("local");

  // --- LOCAL SCANNER STATE ---
  const [localLoading, setLocalLoading] = useState(false);
  const [localFindings, setLocalFindings] = useState<any[] | null>(null);
  const [currentScanPath, setCurrentScanPath] =
    useState<string>("Initializing...");
  const scanUnlisten = useRef<(() => void) | null>(null);

  // --- EXISTING STATES (Password, Email, Network) ---
  const [password, setPassword] = useState("");
  const [passLoading, setPassLoading] = useState(false);
  const [passResult, setPassResult] = useState<{
    found: boolean;
    count: number;
  } | null>(null);
  const [passError, setPassError] = useState<string | null>(null);
  const [lastCheckTime, setLastCheckTime] = useState(0);
  const [autoClearPassword, setAutoClearPassword] = useState(true);

  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);

  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [isWarp, setIsWarp] = useState(false);
  const [ipLoading, setIpLoading] = useState(false);
  const [ipService, setIpService] = useState("");
  const [copiedIp, setCopiedIp] = useState(false);

  // --- LOCAL SCAN LOGIC ---
  async function runLocalScan() {
    try {
      const selected = await open({
        directory: true,
        title: "Select folder to scan for exposed secrets",
      });
      if (selected && typeof selected === "string") {
        setLocalLoading(true);
        setLocalFindings(null);
        setCurrentScanPath("Starting scan...");

        // Listen for live progress from Rust
        scanUnlisten.current = await listen<string>(
          "secret-scan-progress",
          (event) => {
            // We slice the path so it doesn't break the UI layout
            const shortPath =
              event.payload.length > 50
                ? "..." + event.payload.slice(-47)
                : event.payload;
            setCurrentScanPath(shortPath);
          },
        );

        try {
          const res = await invoke<any[]>("scan_local_secrets", {
            dirPath: selected,
          });
          setLocalFindings(res);
        } catch (backendError) {
          alert(backendError); // Shows the "Protected system directory" error
        }
      }
    } catch (e) {
      console.error(e);
      alert("Scan failed: " + e);
    } finally {
      setLocalLoading(false);
      if (scanUnlisten.current) {
        scanUnlisten.current();
        scanUnlisten.current = null;
      }
    }
  }

  // --- EXISTING LOGIC ---
  async function checkPassword() {
    const trimmedPassword = password.trim();
    if (!trimmedPassword) {
      setPassError("Please enter a password.");
      return;
    }
    if (trimmedPassword.length > 1000) {
      setPassError("Password is too long.");
      return;
    }
    if (Date.now() - lastCheckTime < 2000) {
      setPassError("Please wait before checking again.");
      return;
    }

    setPassLoading(true);
    setPassResult(null);
    setPassError(null);
    setLastCheckTime(Date.now());
    try {
      const hash = await sha1Hex(trimmedPassword);
      const res = await invoke<{ found: boolean; count: number }>(
        "check_password_breach",
        { sha1Hash: hash },
      );
      setPassResult(res);
      if (autoClearPassword && res) setTimeout(() => setPassword(""), 3000);
    } catch (e) {
      setPassError("Connection failed: " + String(e));
    } finally {
      setPassLoading(false);
    }
  }

  function checkEmailOnWebsite() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setEmailError("Please enter an email address.");
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      setEmailError("Invalid email address format.");
      return;
    }
    setEmailError(null);
    openUrl(
      `https://haveibeenpwned.com/account/${encodeURIComponent(trimmedEmail)}`,
    );
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
    } catch (e) {
      setPublicIp("Unknown (Service unavailable)");
      setIpService("Error");
    } finally {
      setIpLoading(false);
    }
  }

  async function copyIpAddress() {
    if (publicIp && publicIp !== "Unknown (Service unavailable)") {
      await navigator.clipboard.writeText(publicIp);
      setCopiedIp(true);
      setTimeout(() => setCopiedIp(false), 2000);
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
          Detect sensitive data leaks locally and online.
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
          {[
            { id: "local", label: "Local Scanner" },
            { id: "password", label: "Password Breach" },
            { id: "email", label: "Email Breach" },
            { id: "network", label: "Network Security" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              style={{
                padding: "8px 20px",
                borderRadius: "6px",
                border: "none",
                background:
                  activeTab === tab.id ? "var(--accent)" : "transparent",
                color: activeTab === tab.id ? "white" : "var(--text-dim)",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* --- TAB 1: LOCAL SECRET SCANNER (NEW PRIMARY TOOL) --- */}
      {activeTab === "local" && (
        <div
          style={{
            maxWidth: 800,
            width: "100%",
            margin: "0 auto",
            animation: "fadeIn 0.3s ease",
            display: "flex",
            flexDirection: "column",
            // If there are no findings, push the content to the absolute center of the available space
            justifyContent:
              !localFindings && !localLoading ? "center" : "flex-start",
            flex: 1,
          }}
        >
          {!localFindings && !localLoading && (
            <div
              className="shred-zone"
              style={{
                padding: 40,
                textAlign: "center",
                cursor: "pointer",
                borderColor: "var(--accent)",
                // FIX: Force Horizontal Centering
                margin: "0 auto",
                width: "100%",
                maxWidth: 500,
              }}
              onClick={runLocalScan}
            >
              <FolderSearch
                size={64}
                color="var(--accent)"
                style={{ marginBottom: 20 }}
              />
              <h3>Scan for Exposed Secrets</h3>
              <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
                Find plaintext passwords, API keys, and Crypto Wallets hiding in
                your unencrypted folders (.txt, .csv, .env).
              </p>
              <button className="auth-btn">Select Folder to Scan</button>
            </div>
          )}

          {localLoading && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                flex: 1,
              }}
            >
              <Search
                size={48}
                className="spinner"
                color="var(--accent)"
                style={{ marginBottom: 20 }}
              />
              <h3>Scanning local files...</h3>
              <div
                style={{
                  background: "#0a0a0a",
                  padding: "8px 15px",
                  borderRadius: 6,
                  fontFamily: "monospace",
                  fontSize: "0.8rem",
                  color: "#4ade80",
                  marginTop: 15,
                  width: "100%",
                  maxWidth: 500,
                  textAlign: "left",
                  border: "1px solid #333",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                }}
              >
                &gt; {currentScanPath}
              </div>
            </div>
          )}

          {localFindings && (
            <div style={{ paddingBottom: 40 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 20,
                }}
              >
                <h3 style={{ margin: 0 }}>
                  {localFindings.length === 0
                    ? "No secrets exposed!"
                    : `${localFindings.length} Exposed Secrets Found`}
                </h3>
                <button
                  className="secondary-btn"
                  onClick={() => setLocalFindings(null)}
                >
                  Scan Again
                </button>
              </div>

              {localFindings.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: 40,
                    background: "rgba(34, 197, 94, 0.05)",
                    borderRadius: 12,
                    border: "1px solid rgba(34, 197, 94, 0.3)",
                  }}
                >
                  <ShieldCheck
                    size={48}
                    color="var(--btn-success)"
                    style={{ marginBottom: 15 }}
                  />
                  <p style={{ color: "var(--text-main)", fontSize: "1.1rem" }}>
                    Your local files are clean.
                  </p>
                  <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
                    No plaintext passwords or API keys detected.
                  </p>
                </div>
              ) : (
                <div
                  style={{
                    background: "var(--bg-card)",
                    borderRadius: 10,
                    border: "1px solid var(--btn-danger)",
                    overflow: "hidden",
                  }}
                >
                  {localFindings.map((f, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        padding: 15,
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <FileText
                        size={20}
                        color="#f59e0b"
                        style={{ marginRight: 15, flexShrink: 0 }}
                      />
                      <div
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          paddingRight: 10,
                        }}
                      >
                        <div style={{ fontWeight: "bold" }}>{f.filename}</div>
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-dim)",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                            overflow: "hidden",
                          }}
                        >
                          {f.path}
                        </div>
                      </div>
                      <div
                        style={{
                          background: "rgba(239, 68, 68, 0.1)",
                          color: "var(--btn-danger)",
                          padding: "4px 10px",
                          borderRadius: 4,
                          fontSize: "0.8rem",
                          fontWeight: "bold",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {f.category}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* --- TAB 2: PASSWORD BREACH --- */}
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
              Hash calculated locally using k-Anonymity.
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

              {/* FIX: Auto-clear checkbox */}
              <label
                style={{
                  fontSize: "0.85rem",
                  color: "var(--text-dim)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={autoClearPassword}
                  onChange={(e) => setAutoClearPassword(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                Clear password 3 seconds after check
              </label>

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

            {/* FIX: Inline error display */}
            {passError && (
              <div
                style={{
                  marginTop: 15,
                  padding: 10,
                  borderRadius: 6,
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "var(--btn-danger)",
                  fontSize: "0.9rem",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <AlertTriangle size={16} /> {passError}
              </div>
            )}
          </div>

          {/* PASSWORD RESULTS */}
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
                    <br />
                    <span style={{ fontSize: "0.9rem" }}>
                      Do not use this password anywhere.
                    </span>
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
                  <p style={{ color: "var(--text-main)", marginBottom: 10 }}>
                    Not found in public leaks.
                  </p>

                  {/* FIX: Password strength indicator */}
                  {password &&
                    (() => {
                      const strength = getPasswordStrength(password);
                      return (
                        <div
                          style={{
                            marginTop: 10,
                            padding: "8px 12px",
                            borderRadius: 6,
                            background: `${strength.color}22`,
                            border: `1px solid ${strength.color}44`,
                          }}
                        >
                          <div
                            style={{
                              fontSize: "0.85rem",
                              color: "var(--text-dim)",
                            }}
                          >
                            Password Strength:{" "}
                            <strong style={{ color: strength.color }}>
                              {strength.label}
                            </strong>
                          </div>
                          {strength.score < 3 && (
                            <div
                              style={{
                                fontSize: "0.75rem",
                                color: "var(--text-dim)",
                                marginTop: 4,
                              }}
                            >
                              Consider using a longer password with mixed
                              characters.
                            </div>
                          )}
                        </div>
                      );
                    })()}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* --- TAB 3: EMAIL BREACH (Option 1: Redirect to Website) --- */}
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
            <div
              style={{
                textAlign: "center",
                marginBottom: 20,
              }}
            >
              <Mail
                size={48}
                style={{ color: "var(--accent)", marginBottom: 10 }}
              />
              <h3 style={{ margin: "0 0 8px 0" }}>Email Breach Check</h3>
              <p
                style={{
                  color: "var(--text-dim)",
                  lineHeight: "1.5",
                  fontSize: "0.9rem",
                  margin: 0,
                }}
              >
                Check if your email has been exposed in data breaches.
                <br />
                <small>
                  Powered by{" "}
                  <strong style={{ color: "var(--accent)" }}>
                    haveibeenpwned.com
                  </strong>
                </small>
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--bg-color)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "0 12px",
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
                  type="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailError(null);
                  }}
                  onKeyPress={(e) => {
                    if (e.key === "Enter") checkEmailOnWebsite();
                  }}
                />
              </div>

              <button
                className="auth-btn"
                onClick={checkEmailOnWebsite}
                disabled={!email.trim()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  padding: 12,
                }}
              >
                <ExternalLink size={20} />
                Check on haveibeenpwned.com (Free & Secure)
              </button>

              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-dim)",
                  textAlign: "center",
                  margin: 0,
                  opacity: 0.7,
                  lineHeight: 1.5,
                }}
              >
                Your email will be checked securely on HIBP's website.
                <br />
                No account or API key required.
              </p>
            </div>

            {/* FIX: Inline error display */}
            {emailError && (
              <div
                style={{
                  marginTop: 15,
                  padding: 10,
                  borderRadius: 6,
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "var(--btn-danger)",
                  fontSize: "0.85rem",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <AlertTriangle size={16} /> {emailError}
              </div>
            )}
          </div>

          {/* Information Card */}
          <div
            className="modern-card"
            style={{
              marginTop: 20,
              padding: 20,
              background: "rgba(59, 130, 246, 0.05)",
              borderColor: "rgba(59, 130, 246, 0.3)",
            }}
          >
            <h4
              style={{
                margin: "0 0 10px 0",
                fontSize: "1rem",
                color: "var(--text-main)",
              }}
            >
              What You'll See:
            </h4>
            <ul
              style={{
                margin: 0,
                paddingLeft: 20,
                color: "var(--text-dim)",
                fontSize: "0.85rem",
                lineHeight: 1.6,
              }}
            >
              <li>Which services have been breached (LinkedIn, Adobe, etc.)</li>
              <li>What data was exposed (passwords, emails, addresses)</li>
              <li>When each breach occurred</li>
              <li>Recommendations for next steps</li>
            </ul>
          </div>
        </div>
      )}

      {/* --- TAB 4: NETWORK SECURITY --- */}
      {activeTab === "network" && (
        <div
          style={{
            maxWidth: 600,
            width: "100%",
            margin: "0 auto",
            animation: "fadeIn 0.3s ease",
          }}
        >
          {/* IP STATUS CARD */}
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

            {/* IP ADDRESS with Copy Button */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                margin: "10px 0",
              }}
            >
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  fontFamily: "monospace",
                  letterSpacing: "1px",
                }}
              >
                {ipLoading ? (
                  <Loader2 className="spinner" />
                ) : (
                  publicIp || "---"
                )}
              </div>

              {/* FIX: Copy IP button */}
              {publicIp && publicIp !== "Unknown (Service unavailable)" && (
                <button
                  onClick={copyIpAddress}
                  className="icon-btn-ghost"
                  title="Copy IP Address"
                  style={{
                    padding: 6,
                    borderRadius: 4,
                  }}
                >
                  {copiedIp ? (
                    <Check size={18} color="var(--success)" />
                  ) : (
                    <Copy size={18} />
                  )}
                </button>
              )}
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
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span>Source: {ipService}</span>
              {/* FIX: Refresh button */}
              <button
                onClick={checkIp}
                disabled={ipLoading}
                className="icon-btn-ghost"
                title="Refresh IP"
                style={{
                  padding: 4,
                  borderRadius: 4,
                }}
              >
                <RefreshCw size={14} className={ipLoading ? "spinner" : ""} />
              </button>
            </div>
          </div>

          {/* WARP RECOMMENDATION CARD */}
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
                  Your public IP is exposed. If you're already using a VPN
                  (NordVPN, ProtonVPN, etc.), you're protected.
                  <br />
                  <br />
                  If not, we recommend{" "}
                  <strong style={{ color: "var(--text-main)" }}>
                    Cloudflare WARP
                  </strong>
                  . It creates an encrypted tunnel to mask your location and
                  prevent ISP tracking.
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
