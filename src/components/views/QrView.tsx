import { useShortcut } from "../../hooks/useShortcut";
import { ToolPage } from "../common/ToolPage";
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  QrCode,
  Download,
  Wifi,
  Type,
  Image as ImageIcon,
  Eye,
  EyeOff,
  Mail,
  Phone,
  Link as LinkIcon,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { Banner } from "../ui/Banner";
import { Segmented } from "../ui/Segmented";
import { ShortcutHint } from "../ui/ShortcutHint";

interface QrResult {
  svg: string;
  size: number;
  version: number;
}

interface QrValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  estimated_size?: string;
}

type TabType = "text" | "url" | "email" | "phone" | "wifi";
type EccLevel = "low" | "medium" | "quartile" | "high";

const TEMPLATES = {
  text: { name: "Text", icon: Type, placeholder: "Enter any text..." },
  url: { name: "Website", icon: LinkIcon, placeholder: "https://example.com" },
  email: { name: "Email", icon: Mail, placeholder: "your@email.com" },
  phone: { name: "Phone", icon: Phone, placeholder: "+1234567890" },
  wifi: { name: "WiFi", icon: Wifi, placeholder: "" },
};

export function QrView() {
  const [activeTab, setActiveTab] = useState<TabType>("url");
  const [error, setError] = useState<string | null>(null);

  // Content State
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [ssid, setSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [isHidden, setIsHidden] = useState(false);
  const [wifiSecurity, setWifiSecurity] = useState("WPA");
  const [showWifiPass, setShowWifiPass] = useState(false);

  // Style State
  const [fgColor, setFgColor] = useState("#000000");
  const [bgColor, setBgColor] = useState("#FFFFFF");
  const [eccLevel, setEccLevel] = useState<EccLevel>("medium");
  const [border, setBorder] = useState(4);

  // Result State
  const [qrResult, setQrResult] = useState<QrResult | null>(null);
  const [validation, setValidation] = useState<QrValidation | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  function getContentForTab(): string {
    switch (activeTab) {
      case "text":
        return text;
      case "url":
        if (url && !/^https?:\/\//i.test(url)) {
          return `https://${url}`;
        }
        return url;
      case "email":
        return email ? `mailto:${email}` : "";
      case "phone":
        return phone ? `tel:${phone}` : "";
      case "wifi":
        return ssid; // Just return ssid for validation
      default:
        return "";
    }
  }

  // Generate QR
  useEffect(() => {
    // Set when the inputs change again. A slow response for older input must not
    // overwrite the result (or error) for what is on screen now.
    let cancelled = false;
    const content = getContentForTab();
    
    if (!content) {
      setQrResult(null);
      setValidation(null);
      return;
    }

    // Validate first (non-WiFi)
    if (activeTab !== "wifi") {
      invoke<QrValidation>("validate_qr_input", { text: content })
        .then(v => {
          if (cancelled) return;
          setValidation(v);
          if (!v.valid) {
            setQrResult(null);
            return;
          }
        })
        .catch(console.error);
    }

    // Generate QR
    if (activeTab === "wifi") {
      invoke<QrResult>("generate_wifi_qr", {
        options: {
          ssid,
          password: wifiPass,
          hidden: isHidden,
          security: wifiSecurity,
          fg_color: fgColor,
          bg_color: bgColor,
          ecc: eccLevel,
          border,
        },
      })
        .then(result => {
          if (cancelled) return;
          setQrResult(result);
          setError(null);
          setValidation({ valid: true, errors: [], warnings: [] });
        })
        .catch(e => {
          if (cancelled) return;
          setError(String(e));
          setQrResult(null);
        });
    } else {
      invoke<QrResult>("generate_qr", {
        options: {
          text: content,
          fg_color: fgColor,
          bg_color: bgColor,
          ecc: eccLevel,
          border,
        },
      })
        .then(result => {
          if (cancelled) return;
          setQrResult(result);
          setError(null);
        })
        .catch(e => {
          if (cancelled) return;
          setError(String(e));
          setQrResult(null);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    text, url, email, phone, ssid, wifiPass, isHidden, wifiSecurity,
    activeTab, fgColor, bgColor, eccLevel, border,
  ]);

  async function saveSvg() {
    if (!qrResult) return;
    try {
      const path = await save({
        filters: [{ name: "SVG Image", extensions: ["svg"] }],
        defaultPath: "qrcode.svg",
      });

      if (path) {
        const encoder = new TextEncoder();
        await writeFile(path, encoder.encode(qrResult.svg));
      }
    } catch (e) {
      setError("Failed to save SVG: " + e);
    }
  }

  async function savePng() {
    if (!qrResult || !canvasRef.current) return;

    const img = new Image();
    const svgBlob = new Blob([qrResult.svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    img.onload = async () => {
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = 1000;
      canvas.height = 1000;

      ctx.drawImage(img, 0, 0, 1000, 1000);

      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",")[1];
      const binaryStr = atob(base64);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      try {
        const path = await save({
          filters: [{ name: "PNG Image", extensions: ["png"] }],
          defaultPath: "qrcode.png",
        });
        if (path) {
          await writeFile(path, bytes);
        }
      } catch (e) {
        setError("Failed to save PNG: " + e);
      }

      URL.revokeObjectURL(url);
    };

    img.src = url;
  }

  // Ctrl+S saves the code as a PNG, Ctrl+Shift+S as an SVG.
  useShortcut("s", savePng, { enabled: qrResult !== null });
  useShortcut("s", saveSvg, { enabled: qrResult !== null, shift: true });

  const labelStyle = {
    fontSize: "0.85rem",
    color: "var(--text-dim)",
    marginBottom: 8,
    display: "block" as const,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid var(--border)",
    background: "var(--bg-card)",
    color: "var(--text-main)",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <ToolPage
      title="Secure QR Generator"
      subtitle="Create offline QR codes for WiFi, contacts, links, and more."
    >
      <div style={{ width: "100%" }}>
        {/* MESSAGES */}
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
          {error && (
            <Banner tone="error" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          )}

          {validation && !validation.valid && (
            <Banner tone="error">
              {validation.errors.map((err, i) => (
                <div key={i}>• {err}</div>
              ))}
            </Banner>
          )}

          {validation && validation.warnings.length > 0 && (
            <Banner tone="warning">
              {validation.warnings.map((warn, i) => (
                <div key={i}>{warn}</div>
              ))}
            </Banner>
          )}
        </div>
        <div style={{ height: 20 }} />

        <div
          style={{
            display: "flex",
            gap: 30,
            flexWrap: "wrap",
            justifyContent: "center",
            maxWidth: 1200,
            margin: "0 auto",
          }}
        >
          {/* LEFT: CONTROLS */}
          <div className="modern-card" style={{ flex: 1, minWidth: 320, maxWidth: 500, padding: 25 }}>
            {/* TABS */}
            <div style={{ marginBottom: 20 }}>
              <Segmented<TabType>
                fill
                variant="tabs"
                label="Kind of QR code"
                value={activeTab}
                onChange={setActiveTab}
                options={(Object.keys(TEMPLATES) as TabType[]).map((tab) => {
                  const Icon = TEMPLATES[tab].icon;
                  return { value: tab, label: TEMPLATES[tab].name, icon: <Icon size={14} /> };
                })}
              />
            </div>

            {/* INPUT FORM */}
            <div style={{ marginBottom: 25 }}>
              {activeTab === "text" && (
                <>
                  <label style={labelStyle}>Content</label>
                  <textarea
                    style={{ ...inputStyle, height: 120, resize: "none", fontFamily: "monospace" }}
                    placeholder={TEMPLATES.text.placeholder}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    maxLength={2048}
                  />
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: 5 }}>
                    {text.length} / 2048 characters
                  </div>
                </>
              )}

              {activeTab === "url" && (
                <>
                  <label style={labelStyle}>Website URL</label>
                  <input
                    style={inputStyle}
                    placeholder={TEMPLATES.url.placeholder}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </>
              )}

              {activeTab === "email" && (
                <>
                  <label style={labelStyle}>Email Address</label>
                  <input
                    style={inputStyle}
                    type="email"
                    placeholder={TEMPLATES.email.placeholder}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </>
              )}

              {activeTab === "phone" && (
                <>
                  <label style={labelStyle}>Phone Number</label>
                  <input
                    style={inputStyle}
                    type="tel"
                    placeholder={TEMPLATES.phone.placeholder}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </>
              )}

              {activeTab === "wifi" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
                  <div>
                    <label style={labelStyle}>Network Name (SSID)</label>
                    <input
                      style={inputStyle}
                      placeholder="MyHomeWifi"
                      value={ssid}
                      onChange={(e) => setSsid(e.target.value)}
                      maxLength={32}
                    />
                  </div>
                  
                  {/* REPLACED: WiFi Security Dropdown -> Radio Button Grid */}
                  <div>
                    <label style={labelStyle}>Security Type</label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                      {[
                        { id: "WPA2", label: "WPA2 (Recommended)" },
                        { id: "WPA", label: "WPA" },
                        { id: "WEP", label: "WEP (Insecure)" },
                        { id: "nopass", label: "Open (No Password)" },
                      ].map((sec) => (
                        <div
                          key={sec.id}
                          onClick={() => {
                            setWifiSecurity(sec.id);
                            // If they select "open", clear the password
                            if (sec.id === "nopass") setWifiPass("");
                          }}
                          style={{
                            padding: "8px 12px",
                            border: `1px solid ${wifiSecurity === sec.id ? "var(--accent)" : "var(--border)"}`,
                            borderRadius: "6px",
                            background: wifiSecurity === sec.id ? "rgba(0, 122, 204, 0.1)" : "var(--bg-card)",
                            color: wifiSecurity === sec.id ? "var(--accent)" : "var(--text-main)",
                            fontSize: "0.85rem",
                            fontWeight: wifiSecurity === sec.id ? 600 : 400,
                            cursor: "pointer",
                            textAlign: "center",
                            transition: "all 0.2s",
                            userSelect: "none"
                          }}
                        >
                          {sec.label}
                        </div>
                      ))}
                    </div>
                  </div>

                  {wifiSecurity !== "nopass" && (
                    <div>
                      <label style={labelStyle}>Password</label>
                      <div style={{ position: "relative" }}>
                        <input
                          style={{ ...inputStyle, paddingRight: 40 }}
                          type={showWifiPass ? "text" : "password"}
                          placeholder="Network Password"
                          value={wifiPass}
                          onChange={(e) => setWifiPass(e.target.value)}
                          minLength={8}
                          maxLength={63}
                        />
                        <button
                          onClick={() => setShowWifiPass(!showWifiPass)}
                          style={{
                            position: "absolute",
                            right: 8,
                            top: "50%",
                            transform: "translateY(-50%)",
                            background: "none",
                            border: "none",
                            color: "var(--text-dim)",
                            cursor: "pointer",
                          }}
                        >
                          {showWifiPass ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                      </div>
                    </div>
                  )}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      cursor: "pointer",
                      fontSize: "0.9rem",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isHidden}
                      onChange={(e) => setIsHidden(e.target.checked)}
                    />
                    Hidden Network
                  </label>
                </div>
              )}
            </div>

            {/* CUSTOMIZATION */}
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Customization</label>
              <div style={{ display: "flex", gap: 15, marginBottom: 15 }}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: "0.8rem", color: "var(--text-dim)", marginBottom: 5, display: "block" }}>
                    Code Color
                  </span>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: "var(--bg-color)",
                      padding: 5,
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                    }}
                  >
                    <input
                      type="color"
                      value={fgColor}
                      onChange={(e) => setFgColor(e.target.value)}
                      style={{ border: "none", width: 30, height: 30, cursor: "pointer", background: "none" }}
                    />
                    <span style={{ fontSize: "0.85rem", fontFamily: "monospace" }}>{fgColor}</span>
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: "0.8rem", color: "var(--text-dim)", marginBottom: 5, display: "block" }}>
                    Background
                  </span>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: "var(--bg-color)",
                      padding: 5,
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                    }}
                  >
                    <input
                      type="color"
                      value={bgColor}
                      onChange={(e) => setBgColor(e.target.value)}
                      style={{ border: "none", width: 30, height: 30, cursor: "pointer", background: "none" }}
                    />
                    <span style={{ fontSize: "0.85rem", fontFamily: "monospace" }}>{bgColor}</span>
                  </div>
                </div>
              </div>

              {/* REPLACED: Error Correction Dropdown -> Radio Button Grid */}
              <div style={{ marginBottom: 15 }}>
                <span style={{ fontSize: "0.8rem", color: "var(--text-dim)", marginBottom: 8, display: "block" }}>
                  Error Correction Level
                </span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                  {[
                    { id: "low", title: "Low (7%)", desc: "Smallest size" },
                    { id: "medium", title: "Medium (15%)", desc: "Recommended" },
                    { id: "quartile", title: "Quartile (25%)", desc: "Better recovery" },
                    { id: "high", title: "High (30%)", desc: "Best for logos" },
                  ].map((ecc) => (
                    <div
                      key={ecc.id}
                      onClick={() => setEccLevel(ecc.id as EccLevel)}
                      style={{
                        padding: "8px 12px",
                        border: `1px solid ${eccLevel === ecc.id ? "var(--accent)" : "var(--border)"}`,
                        borderRadius: "6px",
                        background: eccLevel === ecc.id ? "rgba(0, 122, 204, 0.1)" : "var(--bg-card)",
                        cursor: "pointer",
                        transition: "all 0.2s",
                        userSelect: "none"
                      }}
                    >
                      <div style={{ 
                        fontSize: "0.85rem", 
                        color: eccLevel === ecc.id ? "var(--accent)" : "var(--text-main)",
                        fontWeight: eccLevel === ecc.id ? 600 : 400,
                        marginBottom: "2px"
                      }}>
                        {ecc.title}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                        {ecc.desc}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <span style={{ fontSize: "0.8rem", color: "var(--text-dim)", marginBottom: 5, display: "block" }}>
                  Border Size: {border} modules
                </span>
                <input
                  type="range"
                  min="0"
                  max="10"
                  value={border}
                  onChange={(e) => setBorder(parseInt(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>
            </div>

            {/* QR INFO */}
            {qrResult && validation && validation.estimated_size && (
              <Banner tone="info">
                <strong>QR Code Info</strong>
                <div style={{ color: "var(--text-dim)" }}>{validation.estimated_size}</div>
              </Banner>
            )}
          </div>

          {/* RIGHT: PREVIEW */}
          <div
            className="modern-card"
            style={{
              flex: 1,
              minWidth: 300,
              maxWidth: 400,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-card)",
            }}
          >
            {qrResult ? (
              <div
                style={{
                  background: bgColor,
                  padding: 20,
                  borderRadius: 10,
                  boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
                }}
              >
                <div
                  dangerouslySetInnerHTML={{ __html: qrResult.svg }}
                  style={{ width: 220, height: 220 }}
                />
              </div>
            ) : (
              <div style={{ opacity: 0.3, textAlign: "center", padding: 40 }}>
                <QrCode size={80} color="var(--text-dim)" />
                <p style={{ marginTop: 20 }}>
                  {activeTab === "wifi"
                    ? "Enter WiFi details to generate"
                    : "Enter content to generate QR code"}
                </p>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 30, width: "100%" }}>
              <button
                className="secondary-btn"
                style={{ flex: 1, justifyContent: "center" }}
                onClick={saveSvg}
                disabled={!qrResult}
              >
                <Download size={18} style={{ marginRight: 8 }} /> SVG <ShortcutHint shortcut="Mod+Shift+S" />
              </button>
              <button
                className="auth-btn"
                style={{ flex: 1, justifyContent: "center" }}
                onClick={savePng}
                disabled={!qrResult}
              >
                <ImageIcon size={18} style={{ marginRight: 8 }} /> PNG <ShortcutHint shortcut="Mod+S" />
              </button>
            </div>

            <canvas ref={canvasRef} style={{ display: "none" }} />
          </div>
        </div>
      </div>
    </ToolPage>
  );
}