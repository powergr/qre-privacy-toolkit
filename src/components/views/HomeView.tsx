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
  FileCheck,
  Brush,
  FileSearch,
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
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center", // Vertically center the content
        overflow: "hidden", // Prevent scrolling if possible
      }}
    >
      {/* COMPACT HEADER */}
      <div
        style={{
          marginBottom: 20, // Reduced margin
          textAlign: "center",
          display: "flex",
          alignItems: "center",
          gap: 15,
          justifyContent: "center",
          flexShrink: 0, // Don't shrink header
        }}
      >
        <div
          style={{
            background: "rgba(0, 122, 204, 0.1)",
            padding: 10,
            borderRadius: "50%",
          }}
        >
          <Fingerprint size={36} color="var(--accent)" strokeWidth={2} />
        </div>
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: "1.8rem",
              color: "var(--text-main)",
              fontWeight: 700,
              lineHeight: 1,
            }}
          >
            QRE Privacy Toolkit
          </h1>
        </div>
      </div>

      {/* 4-COLUMN GRID LAYOUT */}
      <div
        className="home-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          // Calculate row height dynamically or set fixed to fit nicely
          gridTemplateRows: "repeat(3, 1fr)",
          gap: "15px",
          width: "100%",
          maxWidth: "1100px",
          flex: 1, // Take available height
          maxHeight: "600px", // Prevent stretching too tall on large screens
          alignContent: "center",
        }}
      >
        <ToolCard
          title="Encrypt Files"
          desc="AES-256-GCM encryption."
          icon={<Lock size={24} color="#42b883" />}
          bg="rgba(66, 184, 131, 0.1)"
          onClick={() => setTab("files")}
        />
        <ToolCard
          title="Secure Notes"
          desc="Encrypted private notepad."
          icon={<StickyNote size={24} color="#ffaa00" />}
          bg="rgba(255, 170, 0, 0.1)"
          onClick={() => setTab("notes")}
        />
        <ToolCard
          title="Passwords"
          desc="Offline credential vault."
          icon={<Key size={24} color="#007acc" />}
          bg="rgba(0, 122, 204, 0.1)"
          onClick={() => setTab("vault")}
        />
        <ToolCard
          title="Bookmarks"
          desc="Private encrypted links."
          icon={<Bookmark size={24} color="#22c55e" />}
          bg="rgba(34, 197, 94, 0.1)"
          onClick={() => setTab("bookmarks")}
        />

        {/* Row 2 */}
        <ToolCard
          title="Clipboard"
          desc="Secure copy & history."
          icon={<ClipboardList size={24} color="#06b6d4" />}
          bg="rgba(6, 182, 212, 0.1)"
          onClick={() => setTab("clipboard")}
        />
        <ToolCard
          title="Privacy Check"
          desc="Check leaks & IP exposure."
          icon={<Radar size={24} color="#a855f7" />}
          bg="rgba(168, 85, 247, 0.1)"
          onClick={() => setTab("breach")}
        />
        <ToolCard
          title="Integrity Check"
          desc="Verify file hashes."
          icon={<FileCheck size={24} color="#eab308" />}
          bg="rgba(234, 179, 8, 0.1)"
          onClick={() => setTab("hash")}
        />

        {/* Row 3 */}
        <ToolCard
          title="System Clean"
          desc="Clear temp & cache."
          icon={<Brush size={24} color="#3b82f6" />}
          bg="rgba(59, 130, 246, 0.1)"
          onClick={() => setTab("sysclean")}
        />
        <ToolCard
          title="Meta Cleaner"
          desc="Remove Exif/GPS data."
          icon={<Eraser size={24} color="#22c55e" />}
          bg="rgba(34, 197, 94, 0.1)"
          onClick={() => setTab("cleaner")}
        />
        <ToolCard
          title="Shredder"
          desc="Permanently destroy files."
          icon={<Trash2 size={24} color="#d94040" />}
          bg="rgba(217, 64, 64, 0.1)"
          onClick={() => setTab("shred")}
        />
        <ToolCard
          title="File Analyzer"
          desc="Detect fake extensions."
          icon={<FileSearch size={24} color="#ec4899" />}
          bg="rgba(236, 72, 153, 0.1)"
          onClick={() => setTab("analyzer")}
        />
        <ToolCard
          title="QR Generator"
          desc="Offline QR creation."
          icon={<QrCode size={24} color="#ffffff" />}
          bg="rgba(255, 255, 255, 0.1)"
          onClick={() => setTab("qr")}
        />
      </div>
    </div>
  );
}

function ToolCard({ title, desc, icon, bg, onClick }: any) {
  return (
    <div
      onClick={onClick}
      className="home-card"
      style={{
        padding: "15px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center", // Center content vertically
        textAlign: "center",
        cursor: "pointer",
        height: "100%", // Fill the grid cell
        minHeight: "120px",
      }}
    >
      <div
        className="card-icon"
        style={{ background: bg, marginBottom: 12, width: 48, height: 48 }}
      >
        {icon}
      </div>
      <h3 style={{ fontSize: "1rem", margin: "0 0 5px 0" }}>{title}</h3>
      <p
        style={{
          fontSize: "0.75rem",
          margin: 0,
          lineHeight: 1.3,
          opacity: 0.8,
        }}
      >
        {desc}
      </p>
    </div>
  );
}
