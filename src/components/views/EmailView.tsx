import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Mail, RefreshCw, Copy, ArrowLeft, Loader2 } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

interface EmailMessage {
  id: number;
  from: string;
  subject: string;
  date: string;
}

interface EmailContent extends EmailMessage {
  body: string;
  htmlBody: string;
}

export function EmailView() {
  const [address, setAddress] = useState<string | null>(null);
  const [inbox, setInbox] = useState<EmailMessage[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<EmailContent | null>(null);
  const [loading, setLoading] = useState(false);

  // Generate on mount if empty
  useEffect(() => {
    if (!address) generateNew();
  }, []);

  // Auto-refresh inbox every 10s
  useEffect(() => {
    if (!address) return;
    const interval = setInterval(fetchInbox, 10000);
    return () => clearInterval(interval);
  }, [address]);

  async function generateNew() {
    setLoading(true);
    setInbox([]);
    setSelectedEmail(null);
    try {
      const newAddr = await invoke<string>("temp_mail_generate");
      setAddress(newAddr);
    } catch (e) {
      alert("Failed to generate email. Check internet.");
    } finally {
      setLoading(false);
    }
  }

  async function fetchInbox() {
    if (!address) return;
    try {
      const msgs = await invoke<EmailMessage[]>("temp_mail_inbox", { address });
      // Only update if changed to avoid flicker
      if (msgs.length !== inbox.length) {
          setInbox(msgs);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function readEmail(id: number) {
    if (!address) return;
    setLoading(true);
    try {
      const content = await invoke<EmailContent>("temp_mail_read", { address, id });
      setSelectedEmail(content);
    } catch (e) {
      alert(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, height: "100%", display: "flex", flexDirection: "column" }}>
      
      {/* HEADER: Address Bar */}
      <div className="modern-card" style={{ padding: 15, marginBottom: 20, flexDirection: "row", alignItems: "center", gap: 15 }}>
        <div style={{ background: "var(--highlight)", padding: 10, borderRadius: 8 }}>
            <Mail size={24} color="var(--accent)" />
        </div>
        
        <div style={{ flex: 1 }}>
            <div style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>YOUR TEMPORARY ADDRESS</div>
            <div style={{ fontSize: "1.1rem", fontWeight: "bold", fontFamily: "monospace" }}>
                {loading && !address ? "Generating..." : address}
            </div>
        </div>

        <button className="icon-btn-ghost" title="Copy" onClick={() => writeText(address || "")}>
            <Copy size={20} />
        </button>
        <button className="icon-btn-ghost" title="New Address" onClick={generateNew}>
            <RefreshCw size={20} />
        </button>
      </div>

      {/* BODY: Split View or List */}
      <div style={{ flex: 1, display: "flex", gap: 20, overflow: "hidden" }}>
        
        {/* LEFT: INBOX LIST */}
        <div style={{ flex: 1, display: selectedEmail ? "none" : "flex", flexDirection: "column", overflowY: "auto" }}>
            <h3 style={{ margin: "0 0 10px 0" }}>Inbox ({inbox.length})</h3>
            
            {inbox.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--text-dim)", marginTop: 40 }}>
                    <Loader2 className="spinner" />
                    <p>Waiting for emails...</p>
                </div>
            ) : (
                inbox.map(msg => (
                    <div 
                        key={msg.id} 
                        className="modern-card" 
                        style={{ padding: 15, marginBottom: 10, cursor: "pointer", borderLeft: "4px solid var(--accent)" }}
                        onClick={() => readEmail(msg.id)}
                    >
                        <div style={{ fontWeight: "bold", marginBottom: 4 }}>{msg.from}</div>
                        <div style={{ color: "var(--text-dim)" }}>{msg.subject}</div>
                        <div style={{ fontSize: "0.75rem", marginTop: 8, textAlign: "right", opacity: 0.7 }}>{msg.date}</div>
                    </div>
                ))
            )}
        </div>

        {/* RIGHT: READING PANE (Overlay on Mobile/Small screens logic handled by display toggle above) */}
        {selectedEmail && (
            <div style={{ flex: 1.5, display: "flex", flexDirection: "column", background: "var(--panel-bg)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
                {/* Header */}
                <div style={{ padding: 15, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "start", gap: 10 }}>
                    <button className="icon-btn-ghost" onClick={() => setSelectedEmail(null)}>
                        <ArrowLeft size={20} />
                    </button>
                    <div>
                        <div style={{ fontWeight: "bold", fontSize: "1.1rem" }}>{selectedEmail.subject}</div>
                        <div style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>{selectedEmail.from}</div>
                    </div>
                </div>
                
                {/* Body - Sanitized HTML display is complex in React. 
                    For safety, we strictly display Text Body if available, 
                    or render HTML in a sandboxed iframe if necessary. 
                    For v1, let's just dump the text body. */}
                <div style={{ padding: 20, overflowY: "auto", whiteSpace: "pre-wrap", flex: 1, fontFamily: "sans-serif" }}>
                    {selectedEmail.body || "No text content."}
                </div>
            </div>
        )}

      </div>
    </div>
  );
}