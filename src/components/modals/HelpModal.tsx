import React, { useRef } from "react";
import ReactMarkdown from "react-markdown";
import { X, BookOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { HELP_MARKDOWN } from "../../assets/helpContent";

// --- HELPERS ---
function extractText(children: any): string {
  if (!children) return "";
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children?.props?.children) return extractText(children.props.children);
  return "";
}

function slugify(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export function HelpModal({ onClose }: { onClose: () => void }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Safety Check: Prevent White Screen Crash if import fails
  const content = HELP_MARKDOWN || "# Error: Help content could not be loaded.";

  const handleLinkClick = async (
    e: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    if (href.startsWith("http")) {
      e.preventDefault();
      try {
        await invoke("plugin:opener|open", { path: href });
      } catch (err) {
        console.error("Link Error:", err);
      }
      return;
    }

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

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 200000 }}>
      <div
        className="auth-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 800, // Slightly wider for better reading
          maxWidth: "95vw",
          height: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* HEADER */}
        <div className="modal-header">
          <BookOpen size={20} color="var(--accent)" />
          <h2>User Manual</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>

        {/* CONTENT */}
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
              {content}
            </ReactMarkdown>
          </div>
        </div>

        {/* FOOTER */}
        <div
          style={{ padding: "15px 25px", borderTop: "1px solid var(--border)" }}
        >
          <button
            className="secondary-btn"
            style={{ width: "100%" }}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
