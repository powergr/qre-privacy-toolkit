import {
  Lock,
  Trash2,
  Key,
  Fingerprint,
  StickyNote,
  Radar,
  Eraser,
  QrCode,
  ClipboardList,
  Bookmark,
} from "lucide-react";

interface HomeViewProps {
  setTab: (tab: string) => void;
}

export function HomeView({ setTab }: HomeViewProps) {
  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        overflowY: "auto",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* HEADER SECTION */}
      <div
        style={{
          marginBottom: 30,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div style={{ marginBottom: 10 }}>
          <Fingerprint size={48} color="var(--accent)" strokeWidth={1.5} />
        </div>
        <h1
          style={{
            margin: "0",
            fontSize: "1.6rem",
            color: "var(--text-main)",
            fontWeight: 700,
          }}
        >
          QRE Privacy Toolkit
        </h1>
        <p
          style={{
            color: "var(--text-dim)",
            fontSize: "0.95rem",
            marginTop: 5,
          }}
        >
          Select a tool to begin.
        </p>
      </div>

      {/* GRID CONTAINER */}
      <div className="home-grid">
        {/* Encrypt */}
        <div onClick={() => setTab("files")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(66, 184, 131, 0.1)" }}
          >
            <Lock size={28} color="#42b883" />
          </div>
          <h3>Encrypt Files</h3>
          <p>Secure documents with military-grade AES-256.</p>
        </div>

        {/* Notes */}
        <div onClick={() => setTab("notes")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(255, 170, 0, 0.1)" }}
          >
            <StickyNote size={28} color="#ffaa00" />
          </div>
          <h3>Secure Notes</h3>
          <p>Encrypted notepad for PINs and sensitive text.</p>
        </div>

        {/* Vault */}
        <div onClick={() => setTab("vault")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(0, 122, 204, 0.1)" }}
          >
            <Key size={28} color="#007acc" />
          </div>
          <h3>Password Vault</h3>
          <p>Store your digital secrets securely offline.</p>
        </div>

        {/*Bookmarks */}
        <div onClick={() => setTab("bookmarks")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(255, 255, 255, 0.1)" }}
          >
            <Bookmark size={28} color="#22c55e" />
          </div>
          <h3>Bookmarks</h3>
          <p>Save sensitive personal encrypted Bookmarks</p>
        </div>

        {/* Clipboard (NEW) */}
        <div onClick={() => setTab("clipboard")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(6, 182, 212, 0.1)" }}
          >
            <ClipboardList size={28} color="#06b6d4" />
          </div>
          <h3>Secure Clipboard</h3>
          <p>Encrypt sensitive copies & auto-clear history.</p>
        </div>

        {/* Breach */}
        <div onClick={() => setTab("breach")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(168, 85, 247, 0.1)" }}
          >
            <Radar size={28} color="#a855f7" />
          </div>
          <h3>Breach Check</h3>
          <p>Scan against 850M+ leaked passwords.</p>
        </div>

        {/* Cleaner */}
        <div onClick={() => setTab("cleaner")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(34, 197, 94, 0.1)" }}
          >
            <Eraser size={28} color="#22c55e" />
          </div>
          <h3>Metadata Cleaner</h3>
          <p>Remove hidden GPS and author data.</p>
        </div>

        {/* Shredder */}
        <div onClick={() => setTab("shred")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(217, 64, 64, 0.1)" }}
          >
            <Trash2 size={28} color="#d94040" />
          </div>
          <h3>Secure Shredder</h3>
          <p>Permanently destroy sensitive files.</p>
        </div>

        {/* QR Generator */}
        <div onClick={() => setTab("qr")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(255, 255, 255, 0.1)" }}
          >
            <QrCode size={28} color="#ffffff" />
          </div>
          <h3>QR Generator</h3>
          <p>Share Wi-Fi or text offline via screen.</p>
        </div>
      </div>
    </div>
  );
}
