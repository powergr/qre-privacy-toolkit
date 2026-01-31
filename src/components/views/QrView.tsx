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
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

export function QrView() {
  const [activeTab, setActiveTab] = useState<"text" | "wifi">("text");

  // Content State
  const [text, setText] = useState("");
  const [ssid, setSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [isHidden, setIsHidden] = useState(false);
  const [showWifiPass, setShowWifiPass] = useState(false);

  // Style State
  const [fgColor, setFgColor] = useState("#000000");
  const [bgColor, setBgColor] = useState("#FFFFFF");

  const [svg, setSvg] = useState<string | null>(null);

  // Ref for PNG conversion
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // --- GENERATION LOGIC ---

  useEffect(() => {
    let payload = "";
    if (activeTab === "text") {
      payload = text;
    } else {
      // WIFI format: WIFI:T:WPA;S:MyNetwork;P:password;H:false;;
      if (ssid) {
        const safeSsid = ssid.replace(/([\\;,:])/g, "\\$1");
        const safePass = wifiPass.replace(/([\\;,:])/g, "\\$1");
        payload = `WIFI:T:WPA;S:${safeSsid};P:${safePass};H:${isHidden};;`;
      }
    }

    if (payload) {
      invoke<string>("generate_qr_code", {
        text: payload,
        fg: fgColor,
        bg: bgColor,
      })
        .then(setSvg)
        .catch(console.error);
    } else {
      setSvg(null);
    }
  }, [text, ssid, wifiPass, isHidden, activeTab, fgColor, bgColor]);

  // --- SAVE LOGIC ---

  async function saveSvg() {
    if (!svg) return;
    try {
      const path = await save({
        filters: [{ name: "SVG Image", extensions: ["svg"] }],
        defaultPath: "qrcode.svg",
      });

      if (path) {
        const encoder = new TextEncoder();
        await writeFile(path, encoder.encode(svg));
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function savePng() {
    if (!svg || !canvasRef.current) return;

    const img = new Image();
    // SVG needs to be base64 encoded for the image source
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    img.onload = async () => {
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Set high resolution for crisp PNG
      canvas.width = 1000;
      canvas.height = 1000;

      ctx.drawImage(img, 0, 0, 1000, 1000);

      // Get binary data
      // This is a bit tricky in Tauri without raw canvas blob support in older webviews,
      // but we can convert DataURL to Uint8Array
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
        console.error(e);
      }

      URL.revokeObjectURL(url);
    };

    img.src = url;
  }

  // --- UI COMPONENTS ---

  const labelStyle = {
    fontSize: "0.85rem",
    color: "var(--text-dim)",
    marginBottom: 8,
    display: "block",
  };

  const inputStyle = {
    width: "100%",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid var(--border)",
    background: "var(--bg-card)",
    color: "var(--text-main)",
    outline: "none",
    boxSizing: "border-box" as const,
  };

  return (
    <div style={{ padding: "40px", height: "100%", overflowY: "auto" }}>
      <div style={{ textAlign: "center", marginBottom: 30 }}>
        <h2 style={{ margin: "0 0 10px 0", color: "var(--text-main)" }}>
          Secure QR Generator
        </h2>
        <p style={{ color: "var(--text-dim)" }}>
          Create offline codes for Wi-Fi sharing, Crypto, or Links.
        </p>
      </div>

      <div
        style={{
          display: "flex",
          gap: 30,
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        {/* LEFT COLUMN: CONTROLS */}
        <div
          className="modern-card"
          style={{ flex: 1, minWidth: 320, maxWidth: 500, padding: 25 }}
        >
          {/* TABS */}
          <div
            style={{
              display: "flex",
              marginBottom: 20,
              background: "var(--bg-color)",
              padding: 4,
              borderRadius: 8,
            }}
          >
            <button
              onClick={() => setActiveTab("text")}
              style={{
                flex: 1,
                padding: "8px",
                border: "none",
                background:
                  activeTab === "text" ? "var(--highlight)" : "transparent",
                color:
                  activeTab === "text" ? "var(--accent)" : "var(--text-dim)",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Type size={16} /> Text / URL
            </button>
            <button
              onClick={() => setActiveTab("wifi")}
              style={{
                flex: 1,
                padding: "8px",
                border: "none",
                background:
                  activeTab === "wifi" ? "var(--highlight)" : "transparent",
                color:
                  activeTab === "wifi" ? "var(--accent)" : "var(--text-dim)",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Wifi size={16} /> Wi-Fi Config
            </button>
          </div>

          {/* INPUT FORM */}
          <div style={{ marginBottom: 25 }}>
            {activeTab === "text" ? (
              <>
                <label style={labelStyle}>Content</label>
                <textarea
                  style={{
                    ...inputStyle,
                    height: 120,
                    resize: "none",
                    fontFamily: "monospace",
                  }}
                  placeholder="https://... or plain text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 15 }}
              >
                <div>
                  <label style={labelStyle}>Network Name (SSID)</label>
                  <input
                    style={inputStyle}
                    placeholder="MyHomeWifi"
                    value={ssid}
                    onChange={(e) => setSsid(e.target.value)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Password</label>
                  <div style={{ position: "relative" }}>
                    <input
                      style={{ ...inputStyle, paddingRight: 40 }}
                      type={showWifiPass ? "text" : "password"}
                      placeholder="Network Password"
                      value={wifiPass}
                      onChange={(e) => setWifiPass(e.target.value)}
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
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    cursor: "pointer",
                    color: "var(--text-main)",
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

          {/* COLOR OPTIONS */}
          <div>
            <label style={labelStyle}>Customization</label>
            <div style={{ display: "flex", gap: 15 }}>
              <div style={{ flex: 1 }}>
                <span
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--text-dim)",
                    display: "block",
                    marginBottom: 5,
                  }}
                >
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
                    style={{
                      border: "none",
                      width: 30,
                      height: 30,
                      cursor: "pointer",
                      background: "none",
                    }}
                  />
                  <span
                    style={{ fontSize: "0.85rem", fontFamily: "monospace" }}
                  >
                    {fgColor}
                  </span>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <span
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--text-dim)",
                    display: "block",
                    marginBottom: 5,
                  }}
                >
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
                    style={{
                      border: "none",
                      width: 30,
                      height: 30,
                      cursor: "pointer",
                      background: "none",
                    }}
                  />
                  <span
                    style={{ fontSize: "0.85rem", fontFamily: "monospace" }}
                  >
                    {bgColor}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: PREVIEW */}
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
          {svg ? (
            <div
              style={{
                background: bgColor,
                padding: 20,
                borderRadius: 10,
                boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
              }}
            >
              <div
                dangerouslySetInnerHTML={{ __html: svg }}
                style={{ width: 220, height: 220 }}
              />
            </div>
          ) : (
            <div style={{ opacity: 0.3, textAlign: "center", padding: 40 }}>
              <QrCode size={80} color="var(--text-dim)" />
              <p style={{ color: "var(--text-main)", marginTop: 20 }}>
                Enter text or Wi-Fi details to generate preview
              </p>
            </div>
          )}

          <div
            style={{ display: "flex", gap: 10, marginTop: 30, width: "100%" }}
          >
            <button
              className="secondary-btn"
              style={{ flex: 1, justifyContent: "center" }}
              onClick={saveSvg}
              disabled={!svg}
            >
              <Download size={18} style={{ marginRight: 8 }} /> SVG
            </button>
            <button
              className="auth-btn"
              style={{ flex: 1, justifyContent: "center" }}
              onClick={savePng}
              disabled={!svg}
            >
              <ImageIcon size={18} style={{ marginRight: 8 }} /> PNG
            </button>
          </div>

          {/* Hidden Canvas for Conversion */}
          <canvas ref={canvasRef} style={{ display: "none" }} />
        </div>
      </div>
    </div>
  );
}
