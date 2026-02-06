import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import {
  X,
  BookOpen,
  Github,
  RefreshCw,
  Info,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { UpdateModal } from "./UpdateModal";

// @ts-ignore
import { HELP_MARKDOWN as helpContent } from "../../assets/helpContent";

// --- HELPERS ---
function extractText(children: any): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children?.props?.children) return extractText(children.props.children);
  return "";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

// Style for the menu buttons to ensure left alignment
const menuBtnStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  width: "100%",
  padding: "12px 16px",
  gap: "12px",
  fontSize: "0.95rem",
  textAlign: "left" as const,
};

export function HelpModal({ onClose }: { onClose: () => void }) {
  // State: 'menu' = The buttons list, 'manual' = The markdown reader
  const [view, setView] = useState<"menu" | "manual">("menu");
  const [showUpdate, setShowUpdate] = useState(false);
  const [appVersion, setAppVersion] = useState("2.5.9");

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(console.error);
  }, []);

  // Custom Link Handler
  const handleLinkClick = async (
    e: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    // A. External Links (Http) -> Open in Browser
    if (href.startsWith("http")) {
      e.preventDefault();
      try {
        await invoke("plugin:opener|open", { path: href });
      } catch (err) {
        console.error("Link Error:", err);
      }
      return;
    }

    // B. Internal Links (Anchors) -> Scroll to ID
    if (href.startsWith("#")) {
      e.preventDefault();
      const id = href.substring(1);
      const element = document.getElementById(id);
      const container = scrollContainerRef.current;

      if (element && container) {
        const topPos = element.offsetTop - container.offsetTop;
        container.scrollTo({
          top: topPos,
          behavior: "smooth",
        });
      }
    }
  };

  // --- VIEW: MANUAL (Markdown Viewer) ---
  if (view === "manual") {
    return (
      <div
        className="modal-overlay"
        style={{ zIndex: 200000 }}
        onClick={onClose}
      >
        <div
          className="auth-card"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 700,
            maxWidth: "95vw",
            height: "85vh",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div className="modal-header">
            <button
              className="icon-btn-ghost"
              onClick={() => setView("menu")}
              style={{ marginRight: 10 }}
            >
              <ChevronLeft size={20} />
            </button>
            <BookOpen size={20} color="var(--accent)" />
            <h2>User Manual</h2>
            <div style={{ flex: 1 }}></div>
            <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
          </div>

          <div
            className="modal-body"
            ref={scrollContainerRef}
            style={{
              flex: 1,
              overflowY: "auto",
              paddingRight: 15,
              scrollBehavior: "smooth",
            }}
          >
            <div className="markdown-content">
              <ReactMarkdown
                components={{
                  h2: ({ node, children, ...props }) => {
                    const text = extractText(children);
                    return (
                      <h2
                        id={slugify(text)}
                        {...props}
                        style={{ scrollMarginTop: "20px" }}
                      >
                        {children}
                      </h2>
                    );
                  },
                  h3: ({ node, children, ...props }) => {
                    const text = extractText(children);
                    return (
                      <h3
                        id={slugify(text)}
                        {...props}
                        style={{ scrollMarginTop: "20px" }}
                      >
                        {children}
                      </h3>
                    );
                  },
                  a: ({ node, href, children, ...props }) => {
                    return (
                      <a
                        href={href}
                        onClick={(e) => handleLinkClick(e, href || "")}
                        style={{
                          cursor: "pointer",
                          color: "var(--accent)",
                          textDecoration: "none",
                        }}
                        {...props}
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {helpContent || "# Error loading help content"}
              </ReactMarkdown>
            </div>
          </div>

          <div
            style={{
              padding: "15px 25px",
              borderTop: "1px solid var(--border)",
              display: "flex",
              gap: 10,
            }}
          >
            <button
              className="secondary-btn"
              style={{ flex: 1 }}
              onClick={() => setView("menu")}
            >
              Back to Menu
            </button>
            <button className="auth-btn" style={{ flex: 1 }} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- VIEW: MENU (Default) ---
  return (
    <>
      <div
        className="modal-overlay"
        style={{ zIndex: 100000 }}
        onClick={onClose}
      >
        <div
          className="auth-card"
          style={{ width: 400 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <Info size={20} color="var(--accent)" />
            <h2>Help & Info</h2>
            <div style={{ flex: 1 }}></div>
            <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
          </div>

          <div
            className="modal-body"
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            {/* 1. MANUAL */}
            <button
              className="secondary-btn"
              style={menuBtnStyle}
              onClick={() => setView("manual")}
            >
              <BookOpen size={18} style={{ flexShrink: 0 }} />
              <span>User Manual</span>
              <ChevronRight
                size={16}
                style={{ marginLeft: "auto", opacity: 0.5 }}
              />
            </button>

            {/* 2. GITHUB */}
            <button
              className="secondary-btn"
              style={menuBtnStyle}
              onClick={() =>
                openUrl("https://github.com/Pashalis/QRE-Privacy-Toolkit")
              }
            >
              <Github size={18} style={{ flexShrink: 0 }} />
              <span>Source Code (GitHub)</span>
              <ExternalLink
                size={16}
                style={{ marginLeft: "auto", opacity: 0.5 }}
              />
            </button>

            {/* 3. UPDATE */}
            <button
              className="secondary-btn"
              style={menuBtnStyle}
              onClick={() => setShowUpdate(true)}
            >
              <RefreshCw size={18} style={{ flexShrink: 0 }} />
              <span>Check for Updates</span>
            </button>

            {/* 4. ABOUT CARD */}
            <div
              style={{
                marginTop: 15,
                padding: 20,
                background: "rgba(255,255,255,0.03)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontWeight: "bold",
                  fontSize: "1.2rem",
                  marginBottom: 5,
                }}
              >
                QRE Privacy Toolkit
              </div>
              <div style={{ fontSize: "0.9rem", color: "var(--text-dim)" }}>
                Version {appVersion}
              </div>
              <div
                style={{
                  fontSize: "0.8rem",
                  color: "var(--text-dim)",
                  marginTop: 8,
                  opacity: 0.7,
                }}
              >
                Local-First • Zero-Knowledge
              </div>
            </div>
          </div>
        </div>
      </div>

      {showUpdate && <UpdateModal onClose={() => setShowUpdate(false)} />}
    </>
  );
}
