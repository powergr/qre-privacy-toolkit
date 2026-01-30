import { useState, useMemo, useEffect } from "react";
import {
  Clipboard,
  Copy,
  Trash2,
  CreditCard,
  Key,
  Bitcoin,
  X,
  Clock,
  Search,
  ExternalLink,
  Eye,
  EyeOff,
  Link as LinkIcon,
  Mail,
  Landmark,
  ChevronDown,
} from "lucide-react";
import { useClipboard } from "../../hooks/useClipboard";
import { InfoModal } from "../modals/AppModals";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./ClipboardView.css";

export function ClipboardView() {
  const {
    entries,
    loading,
    securePaste,
    copyToClipboard,
    clearAll,
    deleteEntry,
    retentionHours,
    updateRetention,
  } = useClipboard();

  const [msg, setMsg] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      if (isDropdownOpen) setIsDropdownOpen(false);
    };
    if (isDropdownOpen) {
      document.addEventListener("click", handleClickOutside);
    }
    return () => document.removeEventListener("click", handleClickOutside);
  }, [isDropdownOpen]);

  // --- LOGIC ---
  const toggleReveal = (id: string) => {
    const newSet = new Set(revealedIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setRevealedIds(newSet);
  };

  const filteredEntries = useMemo(() => {
    if (!searchQuery) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter(
      (e) =>
        e.content.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q),
    );
  }, [entries, searchQuery]);

  const getIcon = (cat: string) => {
    if (cat.includes("Card")) return <CreditCard size={20} />;
    if (cat.includes("Bank")) return <Landmark size={20} />;
    if (
      cat.includes("API") ||
      cat.includes("Password") ||
      cat.includes("Secret")
    )
      return <Key size={20} />;
    if (cat.includes("Crypto")) return <Bitcoin size={20} />;
    if (cat.includes("Link")) return <LinkIcon size={20} />;
    if (cat.includes("Email")) return <Mail size={20} />;
    return <Clipboard size={20} />;
  };

  const getBadgeClass = (cat: string) => {
    if (cat.includes("Card") || cat.includes("Bank")) return "badge card";
    if (cat.includes("Password") || cat.includes("Secret"))
      return "badge password";
    if (cat.includes("API")) return "badge apikey";
    if (cat.includes("Crypto")) return "badge crypto";
    if (cat.includes("Link")) return "badge link";
    if (cat.includes("Email")) return "badge email";
    return "badge text";
  };

  const isSensitiveCategory = (cat: string) => {
    return (
      cat.includes("Password") ||
      cat.includes("Secret") ||
      cat.includes("API") ||
      cat.includes("Card") ||
      cat.includes("Bank")
    );
  };

  return (
    <div className="clipboard-view">
      {/* HEADER */}
      <div className="clipboard-header">
        <div>
          <h2 style={{ margin: 0 }}>Secure Clipboard</h2>
          <p
            style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-dim)" }}
          >
            {entries.length} items • Auto-clears every {retentionHours}h.
          </p>
        </div>

        {/* RIGHT ACTIONS TOOLBAR - ALIGNMENT FIX */}
        <div
          style={{
            display: "flex",
            gap: "10px",
            alignItems: "center",
          }}
        >
          {/* 1. Search Bar (Box) */}
          <div
            style={{
              width: "220px",
              height: "42px",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              padding: "0 10px",
              position: "relative",
              boxSizing: "border-box",
            }}
          >
            <Search size={16} color="var(--text-dim)" />
            <input
              placeholder="Search history..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                background: "transparent",
                color: "var(--text-main)",
                paddingLeft: 8,
                outline: "none",
                fontSize: "0.9rem",
              }}
            />
          </div>

          {/* 2. Retention Selector (Box) - Wrapped in positioned container */}
          <div style={{ position: "relative" }}>
            <div
              style={{
                width: "130px",
                height: "42px",
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                display: "flex",
                alignItems: "center",
                padding: "0 10px",
                boxSizing: "border-box",
                cursor: "pointer",
              }}
              onClick={(e) => {
                e.stopPropagation();
                setIsDropdownOpen(!isDropdownOpen);
              }}
            >
              <Clock size={16} color="var(--text-dim)" />
              <div
                style={{
                  width: "100%",
                  paddingLeft: 8,
                  fontSize: "0.9rem",
                  fontWeight: 500,
                  color: "var(--text-main)",
                }}
              >
                {retentionHours === 1 && "1 Hour"}
                {retentionHours === 4 && "4 Hours"}
                {retentionHours === 12 && "12 Hours"}
                {retentionHours === 24 && "24 Hours"}
                {retentionHours === 72 && "3 Days"}
                {retentionHours === 168 && "1 Week"}
              </div>
              <ChevronDown
                size={14}
                color="var(--text-dim)"
                style={{
                  transform: isDropdownOpen ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.2s",
                }}
              />
            </div>

            {/* Custom Dropdown Menu */}
            {isDropdownOpen && (
              <div
                className="custom-dropdown-menu"
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  width: "130px",
                  background: "var(--panel-bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  overflow: "hidden",
                  zIndex: 1000,
                  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {[
                  { value: 1, label: "1 Hour" },
                  { value: 4, label: "4 Hours" },
                  { value: 12, label: "12 Hours" },
                  { value: 24, label: "24 Hours" },
                  { value: 72, label: "3 Days" },
                  { value: 168, label: "1 Week" },
                ].map((option) => (
                  <div
                    key={option.value}
                    className="custom-dropdown-option"
                    style={{
                      padding: "10px 12px",
                      cursor: "pointer",
                      fontSize: "0.9rem",
                      color: "var(--text-main)",
                      background:
                        retentionHours === option.value
                          ? "var(--highlight)"
                          : "transparent",
                      fontWeight: retentionHours === option.value ? 600 : 400,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateRetention(option.value);
                      setIsDropdownOpen(false);
                    }}
                    onMouseEnter={(e) => {
                      if (retentionHours !== option.value) {
                        e.currentTarget.style.background = "var(--highlight)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (retentionHours !== option.value) {
                        e.currentTarget.style.background = "transparent";
                      }
                    }}
                  >
                    {option.label}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 3. Clear Button */}
          {entries.length > 0 && (
            <button
              className="secondary-btn"
              onClick={() => setShowClearConfirm(true)}
              style={{
                height: "42px",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-main)",
                padding: "0 15px",
                borderRadius: "8px",
                cursor: "pointer",
                fontWeight: 500,
                whiteSpace: "nowrap",
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
              }}
            >
              Clear All
            </button>
          )}

          {/* 4. Secure Paste Button */}
          <button
            className="header-action-btn"
            onClick={securePaste}
            style={{
              height: "42px",
              padding: "0 15px",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
              fontWeight: 500,
              whiteSpace: "nowrap",
              boxSizing: "border-box",
              // Background comes from CSS class
            }}
          >
            <Clipboard size={18} /> Secure Paste
          </button>
        </div>
      </div>

      {entries.length === 0 && !loading && (
        <div style={{ textAlign: "center", marginTop: 50, opacity: 0.5 }}>
          <Clipboard size={64} />
          <p>Clipboard history is empty.</p>
          <p style={{ fontSize: "0.8rem" }}>
            Copy something sensitive, then click "Secure Paste".
          </p>
        </div>
      )}

      {/* LIST */}
      <div className="clipboard-list">
        {filteredEntries.map((entry) => {
          const sensitive = isSensitiveCategory(entry.category);
          const isMasked = sensitive && !revealedIds.has(entry.id);
          const isLink = entry.category.includes("Link");

          return (
            <div key={entry.id} className="clipboard-card">
              <div className="clip-icon">{getIcon(entry.category)}</div>

              <div className="clip-content">
                <div
                  className="clip-preview"
                  title={isMasked ? "Hidden" : entry.content}
                >
                  {isMasked ? "•••• •••• •••• ••••" : entry.preview}
                </div>
                <div className="clip-meta">
                  <span className={getBadgeClass(entry.category)}>
                    {entry.category}
                  </span>
                  <span>{new Date(entry.created_at).toLocaleString()}</span>
                </div>
              </div>

              <div className="card-actions" style={{ opacity: 1 }}>
                {/* Eye Button for ALL Sensitive types */}
                {sensitive && (
                  <button
                    className="icon-btn-ghost"
                    title={isMasked ? "Show" : "Hide"}
                    onClick={() => toggleReveal(entry.id)}
                  >
                    {isMasked ? <Eye size={18} /> : <EyeOff size={18} />}
                  </button>
                )}

                {/* Open Link Button */}
                {isLink && (
                  <button
                    className="icon-btn-ghost"
                    title="Open Link"
                    onClick={() => openUrl(entry.content)}
                  >
                    <ExternalLink size={18} />
                  </button>
                )}

                <button
                  className="icon-btn-ghost"
                  title="Copy"
                  onClick={() => {
                    copyToClipboard(entry.content);
                    setMsg("Copied to clipboard");
                  }}
                >
                  <Copy size={18} />
                </button>

                <button
                  className="icon-btn-ghost danger"
                  title="Delete Entry"
                  onClick={() => deleteEntry(entry.id)}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {msg && <InfoModal message={msg} onClose={() => setMsg(null)} />}

      {/* CONFIRMATION MODAL */}
      {showClearConfirm && (
        <div
          className="modal-overlay"
          style={{ zIndex: 100005 }}
          onClick={() => setShowClearConfirm(false)}
        >
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Trash2 size={20} color="var(--btn-danger)" />
              <h2 style={{ color: "var(--btn-danger)" }}>Clear History?</h2>
              <div style={{ flex: 1 }}></div>
              <X
                size={20}
                style={{ cursor: "pointer" }}
                onClick={() => setShowClearConfirm(false)}
              />
            </div>
            <div className="modal-body" style={{ textAlign: "center" }}>
              <p style={{ fontSize: "1.1rem", color: "var(--text-main)" }}>
                Delete all <strong>{entries.length}</strong> clipboard entries?
              </p>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => setShowClearConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  className="auth-btn danger-btn"
                  style={{ flex: 1 }}
                  onClick={() => {
                    clearAll();
                    setShowClearConfirm(false);
                  }}
                >
                  Yes, Clear All
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
