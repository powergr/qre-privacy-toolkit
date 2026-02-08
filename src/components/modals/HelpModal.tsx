import React, { useRef, useMemo } from "react";
import { X, BookOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { HELP_MARKDOWN } from "../../assets/helpContent";

// Helper to create anchor IDs from text (remove emojis, lowercase, hyphenate)
function createId(text: string): string {
  return text
    // Remove ALL emojis (comprehensive ranges)
    .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F910}-\u{1F96B}]|[\u{1F980}-\u{1F9E0}]|[\uFE00-\uFE0F]|[\u200D]/gu, "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "") // Remove ampersands specifically
    .replace(/[^\w\s-]/g, "") // Remove other special chars
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-"); // Replace multiple hyphens with single hyphen
}

// Convert markdown-style text to HTML
function markdownToHtml(text: string): string {
  return (
    text
      // Escape HTML first
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")

      // Links (must come before other replacements)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

      // Headers with IDs
      .replace(/^### (.+)$/gm, (_, content) => {
        const id = createId(content);
        return `<h3 id="${id}">${content}</h3>`;
      })
      .replace(/^## (.+)$/gm, (_, content) => {
        const id = createId(content);
        return `<h2 id="${id}">${content}</h2>`;
      })
      .replace(/^# (.+)$/gm, (_, content) => {
        const id = createId(content);
        return `<h1 id="${id}">${content}</h1>`;
      })

      // Bold
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")

      // Italic
      .replace(/\*(.+?)\*/g, "<em>$1</em>")

      // Code
      .replace(/`(.+?)`/g, "<code>$1</code>")

      // Horizontal rules
      .replace(/^---$/gm, "<hr>")

      // Lists
      .replace(/^- (.+)$/gm, "<li>$1</li>")

      // Wrap consecutive list items in ul
      .replace(/(<li>.*?<\/li>\n?)+/gs, "<ul>$&</ul>")

      // Paragraphs (double newline)
      .split("\n\n")
      .map((para) => {
        // Don't wrap headings, lists, or hrs in p tags
        if (para.match(/^<(h[1-6]|ul|hr)/)) {
          return para;
        }
        // Don't wrap empty lines
        if (para.trim() === "") {
          return "";
        }
        return `<p>${para.replace(/\n/g, "<br>")}</p>`;
      })
      .join("\n")
  );
}

export function HelpModal({ onClose }: { onClose: () => void }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Convert markdown to HTML once
  const htmlContent = useMemo(() => markdownToHtml(HELP_MARKDOWN), []);

  const handleLinkClick = async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "A") {
      e.preventDefault();
      const href = target.getAttribute("href");

      if (href?.startsWith("http")) {
        try {
          await invoke("plugin:opener|open", { path: href });
        } catch (err) {
          console.error("Link Error:", err);
        }
      } else if (href?.startsWith("#")) {
        // Handle anchor links
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
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="auth-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 800,
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
          onClick={handleLinkClick}
          style={{
            flex: 1,
            overflowY: "auto",
            paddingRight: 15,
            scrollBehavior: "smooth",
          }}
        >
          <div
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
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