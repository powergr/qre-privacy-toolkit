import {
  Lock,
  Trash2,
  Key,
  Fingerprint,
  StickyNote,
  Radar,
  Eraser,
} from "lucide-react"; // Added Radar

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
        padding: "40px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* Header Section */}
      <div style={{ marginBottom: 40, textAlign: "center", marginTop: "5vh" }}>
        <Fingerprint
          size={90}
          color="var(--accent)"
          strokeWidth={1}
          style={{ marginBottom: 15 }}
        />
        <h1
          style={{
            margin: "0",
            fontSize: "2.2rem",
            color: "var(--text-main)",
            fontWeight: 800,
          }}
        >
          QRE Toolkit
        </h1>
        <p
          style={{
            color: "var(--text-dim)",
            fontSize: "1.1rem",
            marginTop: 10,
          }}
        >
          Select a tool to begin.
        </p>
      </div>

      {/* Grid Container */}
      <div className="home-grid">
        {/* Encrypt Card */}
        <div onClick={() => setTab("files")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(66, 184, 131, 0.1)" }}
          >
            <Lock size={36} color="#42b883" />
          </div>
          <h3>Encrypt Files</h3>
          <p>Secure documents with military-grade AES-256.</p>
        </div>

        {/* Notes Card */}
        <div onClick={() => setTab("notes")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(255, 170, 0, 0.1)" }}
          >
            <StickyNote size={36} color="#ffaa00" />
          </div>
          <h3>Secure Notes</h3>
          <p>Encrypted notepad for PINs and sensitive text.</p>
        </div>

        {/* Vault Card */}
        <div onClick={() => setTab("vault")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(0, 122, 204, 0.1)" }}
          >
            <Key size={36} color="#007acc" />
          </div>
          <h3>Password Vault</h3>
          <p>Store your digital secrets securely offline.</p>
        </div>

        {/* NEW: Breach Check Card */}
        <div onClick={() => setTab("breach")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(168, 85, 247, 0.1)" }}
          >
            <Radar size={36} color="#a855f7" />
          </div>
          <h3>Breach Check</h3>
          <p>Scan your passwords against 2B+ leaked records.</p>
        </div>

        {/* Cleaner Card */}
        <div onClick={() => setTab("cleaner")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(34, 197, 94, 0.1)" }}
          >
            <Eraser size={36} color="#22c55e" />
          </div>
          <h3>Metadata Cleaner</h3>
          <p>Remove hidden GPS and author data from photos.</p>
        </div>

        {/* Shredder Card */}
        <div onClick={() => setTab("shred")} className="home-card">
          <div
            className="card-icon"
            style={{ background: "rgba(217, 64, 64, 0.1)" }}
          >
            <Trash2 size={36} color="#d94040" />
          </div>
          <h3>Secure Shredder</h3>
          <p>Permanently destroy sensitive files.</p>
        </div>
      </div>
    </div>
  );
}
