import React, { useRef } from "react";
import ReactMarkdown from "react-markdown";
import { X, BookOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
// @ts-ignore
import helpContent from "../../assets/HELP.md?raw";

// 1. Helper to extract raw text from React children (removes HTML tags/components)
function extractText(children: any): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children?.props?.children) return extractText(children.props.children);
  return "";
}

// 2. Convert text to ID (Must match the links in HELP.md)
// Example: "🔐 File Encryption" -> "-file-encryption"
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-") // Spaces to dashes
    .replace(/[^\w\-]+/g, "") // Remove emojis and non-word chars
    .replace(/\-\-+/g, "-") // Collapse multiple dashes
    .replace(/^-+/, "") // Trim leading dash (optional, but keeps it clean)
    .replace(/-+$/, ""); // Trim trailing dash
}

export function HelpModal({ onClose }: { onClose: () => void }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 3. Custom Link Click Handler
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

      // Clean up the href to match the ID format
      // Note: If HELP.md has (#-file-encryption), we look for id="-file-encryption"
      const id = href.substring(1);

      const element = document.getElementById(id);
      const container = scrollContainerRef.current;

      if (element && container) {
        const topPos = element.offsetTop - container.offsetTop;
        container.scrollTo({
          top: topPos,
          behavior: "smooth",
        });
      } else {
        console.warn(`Target ID not found: ${id}`);
      }
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 200000 }}>
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
          <BookOpen size={20} color="var(--accent)" />
          <h2>Help Topics</h2>
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
                // CUSTOM H2 RENDERER: Attaches ID so links work
                h2: ({ node, children, ...props }) => {
                  const text = extractText(children);
                  const id = slugify(text); // Generates ID
                  return (
                    <h2 id={id} {...props} style={{ scrollMarginTop: "20px" }}>
                      {children}
                    </h2>
                  );
                },
                // CUSTOM H3 RENDERER
                h3: ({ node, children, ...props }) => {
                  const text = extractText(children);
                  const id = slugify(text);
                  return (
                    <h3 id={id} {...props} style={{ scrollMarginTop: "20px" }}>
                      {children}
                    </h3>
                  );
                },
                // CUSTOM LINK RENDERER
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
              {helpContent}
            </ReactMarkdown>
          </div>
        </div>

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
