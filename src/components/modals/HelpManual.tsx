import {
  Lock,
  Key,
  StickyNote,
  Bookmark,
  ClipboardList,
  Radar,
  Eraser,
  QrCode,
  Trash2,
  Settings,
  LifeBuoy,
  AlertTriangle,
  FileCheck,
  FileSearch,
  Brush,
  Wifi,
  Terminal,
} from "lucide-react";
// @ts-ignore
import pkg from "../../../package.json";

interface SectionProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

const Section = ({ id, title, icon, children }: SectionProps) => (
  <section id={id} style={{ marginBottom: "50px", scrollMarginTop: "20px" }}>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        marginBottom: "15px",
        borderBottom: "1px solid var(--border)",
        paddingBottom: "10px",
      }}
    >
      {icon && <div style={{ color: "var(--accent)" }}>{icon}</div>}
      <h3 style={{ margin: 0, color: "var(--text-main)", fontSize: "1.2rem" }}>
        {title}
      </h3>
    </div>
    <div
      style={{
        color: "var(--text-dim)",
        lineHeight: "1.7",
        fontSize: "0.95rem",
      }}
    >
      {children}
    </div>
  </section>
);

interface HelpManualProps {
  onScrollTo: (id: string) => void;
}

export function HelpManual({ onScrollTo }: HelpManualProps) {
  // Table of Contents Data
  const toc = [
    { id: "encryption", label: "File Encryption", icon: <Lock size={16} /> },
    { id: "vault", label: "Password Vault", icon: <Key size={16} /> },
    { id: "notes", label: "Secure Notes", icon: <StickyNote size={16} /> },
    {
      id: "bookmarks",
      label: "Private Bookmarks",
      icon: <Bookmark size={16} />,
    },
    {
      id: "clipboard",
      label: "Secure Clipboard",
      icon: <ClipboardList size={16} />,
    },
    { id: "privacy", label: "Privacy Check", icon: <Radar size={16} /> },
    { id: "analyzer", label: "File Analyzer", icon: <FileSearch size={16} /> }, // <--- NEW
    {
      id: "integrity",
      label: "Integrity Check",
      icon: <FileCheck size={16} />,
    },
    { id: "sysclean", label: "System Cleaner", icon: <Brush size={16} /> }, // <--- NEW
    { id: "cleaner", label: "Metadata Cleaner", icon: <Eraser size={16} /> },
    { id: "qr", label: "QR Generator", icon: <QrCode size={16} /> },
    { id: "shredder", label: "Secure Shredder", icon: <Trash2 size={16} /> },
    { id: "backup", label: "Backup & Recovery", icon: <LifeBuoy size={16} /> },
    { id: "settings", label: "Settings", icon: <Settings size={16} /> },
    {
      id: "troubleshoot",
      label: "Troubleshooting",
      icon: <AlertTriangle size={16} />,
    },
  ];

  return (
    <div className="manual-container">
      {/* INTRO */}
      <div
        style={{ textAlign: "center", marginBottom: "40px", marginTop: "10px" }}
      >
        <h1 style={{ margin: "0 0 10px 0", fontSize: "1.8rem" }}>
          QRE User Manual
        </h1>
        <div
          style={{
            display: "inline-block",
            background: "rgba(0, 122, 204, 0.1)",
            border: "1px solid var(--accent)",
            padding: "4px 12px",
            borderRadius: "12px",
            fontSize: "0.85rem",
            fontWeight: "bold",
            color: "var(--accent)",
          }}
        >
          Version {pkg.version}
        </div>
        <p
          style={{
            marginTop: "15px",
            color: "var(--text-dim)",
            maxWidth: "600px",
            marginInline: "auto",
          }}
        >
          QRE Privacy Toolkit is a <strong>Local-First</strong>,{" "}
          <strong>Zero-Knowledge</strong> security suite. We do not have
          servers. We do not have your data. You are in complete control.
        </p>
      </div>

      {/* TABLE OF CONTENTS */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "12px",
          padding: "20px",
          marginBottom: "50px",
        }}
      >
        <h4
          style={{
            marginTop: 0,
            marginBottom: "15px",
            color: "var(--text-main)",
          }}
        >
          Jump to Topic
        </h4>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "10px",
          }}
        >
          {toc.map((item) => (
            <button
              key={item.id}
              onClick={() => onScrollTo(item.id)}
              style={{
                background: "rgba(255,255,255,0.03)",
                border: "1px solid transparent",
                borderRadius: "6px",
                color: "var(--text-dim)",
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px",
                fontSize: "0.9rem",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--highlight)";
                e.currentTarget.style.color = "var(--text-main)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                e.currentTarget.style.color = "var(--text-dim)";
              }}
            >
              <span style={{ color: "var(--accent)" }}>{item.icon}</span>{" "}
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* --- SECTIONS --- */}

      <Section id="encryption" title="File Encryption" icon={<Lock />}>
        <p>
          The core engine of QRE. Encrypt files of any size using military-grade{" "}
          <strong>AES-256-GCM</strong>.
        </p>

        <h4 style={{ color: "var(--text-main)", marginTop: 20 }}>
          How to Lock Files
        </h4>
        <ol style={{ paddingLeft: 20 }}>
          <li>
            Navigate to the <strong>Files</strong> tab (Lock Icon).
          </li>
          <li>
            <strong>Drag & Drop</strong> files or folders directly into the
            window.
          </li>
          <li>
            Click the green <strong>Lock</strong> button in the toolbar.
          </li>
          <li>
            New <code>.qre</code> encrypted files are created next to the
            originals.
          </li>
        </ol>
        <div
          style={{
            background: "rgba(255,255,255,0.05)",
            padding: "10px",
            borderRadius: 6,
            fontSize: "0.9rem",
          }}
        >
          <strong>Tip:</strong> The original files are <em>not</em> deleted
          automatically. Use the <strong>Shredder</strong> if you want to
          permanently destroy the originals after encryption.
        </div>

        <h4 style={{ color: "var(--text-main)", marginTop: 20 }}>
          How to Unlock
        </h4>
        <ol style={{ paddingLeft: 20 }}>
          <li>
            Drag a <code>.qre</code> file into the app.
          </li>
          <li>
            Click the red <strong>Unlock</strong> button.
          </li>
          <li>The file will be decrypted to its original state.</li>
        </ol>
      </Section>

      <Section id="vault" title="Password Vault" icon={<Key />}>
        <p>
          A secure, offline database for your logins, credit cards, and secure
          notes.
        </p>
        <ul style={{ paddingLeft: 20 }}>
          <li>
            <strong>Search:</strong> Use the search bar to filter by service
            name or username.
          </li>
          <li>
            <strong>Organize:</strong> Use <strong>Color Labels</strong> to
            categorize entries (e.g., Red for Banking, Blue for Social).
          </li>
          <li>
            <strong>Pinning:</strong> Click the pin icon on important items to
            keep them at the top.
          </li>
          <li>
            <strong>Generate:</strong> Click the Key icon inside the editor to
            generate a cryptographically strong password.
          </li>
        </ul>
      </Section>

      <Section id="notes" title="Secure Notes" icon={<StickyNote />}>
        <p>
          A secure notepad for text that doesn't fit in a password manager.
          Ideal for{" "}
          <strong>Recovery Seeds, Diaries, WiFi Codes, or API Keys</strong>.
        </p>
        <p>
          <strong>Security:</strong> The text is encrypted on your hard drive.
          It is only decrypted in RAM when you open the specific note.
        </p>
      </Section>

      <Section id="bookmarks" title="Private Bookmarks" icon={<Bookmark />}>
        <p>
          Store sensitive links (Medical portals, Financial admin panels, etc.)
          that you do not want in your browser history.
        </p>
        <ul style={{ paddingLeft: 20 }}>
          <li>
            <strong>Privacy:</strong> These bookmarks are never synced to
            iCloud/Google. They exist only in your encrypted vault.
          </li>
          <li>
            <strong>Import:</strong> Click the "Import" button to pull existing
            bookmarks from Chrome/Edge for a quick start.
          </li>
        </ul>
      </Section>

      <Section id="clipboard" title="Secure Clipboard" icon={<ClipboardList />}>
        <p>
          Stop other apps from reading your clipboard history. This tool acts as
          an encrypted buffer.
        </p>

        <h4 style={{ color: "var(--text-main)", marginTop: 20 }}>How to use</h4>
        <ol style={{ paddingLeft: 20 }}>
          <li>
            <strong>Copy</strong> sensitive text (like an IBAN or Password) from
            another app.
          </li>
          <li>
            Immediately click <strong>"Secure Paste"</strong> in QRE Toolkit.
          </li>
          <li>
            The app encrypts the text into your vault and{" "}
            <strong>wipes the system clipboard</strong> instantly.
          </li>
        </ol>

        <h4 style={{ color: "var(--text-main)", marginTop: 20 }}>
          Auto-Clear & Retention
        </h4>
        <p>
          Use the timer dropdown (default: 24 Hours) to set how long items stay
          in the history. Old items are automatically shredded to keep your
          history clean.
        </p>
        <p>
          <strong>Masking:</strong> Sensitive data like Credit Cards and API
          Keys are visually masked (<code>••••</code>) by default. Click the{" "}
          <strong>Eye Icon</strong> to reveal them.
        </p>
      </Section>

      <Section id="privacy" title="Privacy Check" icon={<Radar />}>
        <div style={{ display: "grid", gap: 20, gridTemplateColumns: "1fr" }}>
          <div
            style={{
              background: "rgba(255,255,255,0.03)",
              padding: 15,
              borderRadius: 8,
            }}
          >
            <strong style={{ color: "var(--accent)" }}>
              Tab 1: Identity Breach
            </strong>
            <p style={{ marginTop: 5 }}>
              Checks if your password has appeared in known data leaks (850M+
              records) via HIBP.
              <br />
              <br />
              <em style={{ fontSize: "0.85rem" }}>
                Note: We use k-Anonymity. We send only the first 5 characters of
                the hash. Your password is never exposed.
              </em>
            </p>
          </div>
          <div
            style={{
              background: "rgba(255,255,255,0.03)",
              padding: 15,
              borderRadius: 8,
            }}
          >
            <strong style={{ color: "var(--accent)" }}>
              Tab 2: Network Security
            </strong>
            <p style={{ marginTop: 5 }}>
              Checks your <strong>Public IP</strong> visibility. It detects if
              you are exposed to your ISP or if you are properly protected by a
              VPN or Cloudflare Warp.
            </p>
          </div>
        </div>
      </Section>

      {/* --- NEW SECTIONS --- */}

      <Section id="analyzer" title="File Analyzer" icon={<FileSearch />}>
        <p>
          Detect malicious files hiding behind fake extensions (e.g.,{" "}
          <code>invoice.pdf.exe</code>).
        </p>
        <ul style={{ paddingLeft: 20 }}>
          <li>
            <strong>Smart Scan:</strong> Quickly checks your Downloads and
            Desktop for dangerous mismatches.
          </li>
          <li>
            <strong>Deep Scan:</strong> Select any folder or drive to scan
            recursively.
          </li>
        </ul>
        <div
          style={{
            background: "rgba(239, 68, 68, 0.1)",
            padding: "10px",
            borderRadius: 6,
            fontSize: "0.9rem",
            color: "var(--btn-danger)",
          }}
        >
          <strong>Danger Detection:</strong> Flag files that claim to be safe
          (PDF, JPG) but contain executable binary code.
        </div>
      </Section>

      <Section id="integrity" title="Integrity Checker" icon={<FileCheck />}>
        <p>
          Verify that a downloaded file (like a Linux ISO or wallet software) is
          genuine and hasn't been tampered with.
        </p>
        <ul style={{ paddingLeft: 20 }}>
          <li>
            <strong>Algorithms:</strong> Calculates SHA-256, SHA-1, and MD5
            simultaneously.
          </li>
          <li>
            <strong>Auto-Compare:</strong> Paste the official hash from the
            developer's website. QRE will instantly highlight if it is a{" "}
            <span style={{ color: "#4ade80" }}>
              <strong>MATCH</strong>
            </span>{" "}
            or{" "}
            <span style={{ color: "#f87171" }}>
              <strong>MISMATCH</strong>
            </span>
            .
          </li>
        </ul>
      </Section>

      <Section id="sysclean" title="System Cleaner" icon={<Brush />}>
        <p>
          Remove temporary files, caches, and usage history to free up space and
          improve privacy.
        </p>
        <ul style={{ paddingLeft: 20 }}>
          <li>
            <strong>Targets:</strong> Clears browser caches (Chrome, Edge,
            Brave), Windows Temp, and Recent Documents list.
          </li>
          <li>
            <strong>Privacy:</strong> Only deletes cache/temp files. It does NOT
            delete saved passwords or cookies.
          </li>
        </ul>
        <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>
          *Available on Desktop versions only.
        </p>
      </Section>

      <Section id="cleaner" title="Metadata Cleaner" icon={<Eraser />}>
        <p>
          Photos and documents contain hidden data (EXIF) that reveals your
          location and device info.
        </p>
        <p>
          <strong>Supported Formats:</strong> JPG, PNG, PDF, DOCX, XLSX, PPTX,
          ZIP.
        </p>

        <h4 style={{ color: "var(--text-main)", marginTop: 20 }}>Workflow</h4>
        <ol style={{ paddingLeft: 20 }}>
          <li>Drag files into the Cleaner area.</li>
          <li>
            Review the <strong>Metadata Report</strong> to see exactly what was
            found (GPS, Dates, Author).
          </li>
          <li>
            Click <strong>Clean Files</strong>. New copies (e.g.,{" "}
            <code>photo_clean.jpg</code>) will be created.
          </li>
        </ol>
      </Section>

      <Section id="qr" title="QR Generator" icon={<QrCode />}>
        <p>
          Generate QR codes entirely offline. No data is sent to the internet.
        </p>
        <ul style={{ paddingLeft: 20 }}>
          <li>
            <strong>
              <Wifi size={14} style={{ display: "inline" }} /> Wi-Fi Mode:
            </strong>{" "}
            Create codes to let guests join your WiFi without typing the
            password.
          </li>
          <li>
            <strong>Colors:</strong> Customize the foreground/background color
            to match your brand.
          </li>
          <li>
            <strong>Export:</strong> Save the code as high-resolution{" "}
            <strong>PNG</strong> or Vector <strong>SVG</strong>.
          </li>
        </ul>
      </Section>

      <Section id="shredder" title="Secure Shredder" icon={<Trash2 />}>
        <p>
          Permanently destroys files so they cannot be recovered by forensic
          software.
        </p>
        <ul>
          <li>
            <strong>Desktop:</strong> Performs a DoD 3-pass overwrite pattern
            (Random - Zeros - Random).
          </li>
          <li>
            <strong>Android:</strong> Performs a standard OS deletion (due to
            flash memory wear-leveling limitations).
          </li>
        </ul>
        <div
          style={{
            borderLeft: "3px solid var(--btn-danger)",
            paddingLeft: 10,
            color: "var(--btn-danger)",
          }}
        >
          <strong>Warning:</strong> Shredded files cannot be recovered. Use with
          caution.
        </div>
      </Section>

      <Section id="backup" title="Backup & Recovery" icon={<LifeBuoy />}>
        <h4 style={{ color: "var(--text-main)", marginTop: 0 }}>
          Important: We have no cloud.
        </h4>
        <p>
          If you lose your device or uninstall the app, your data is gone unless
          you have a backup.
        </p>

        <h4 style={{ color: "var(--text-main)", marginTop: 20 }}>
          How to Backup
        </h4>
        <ol style={{ paddingLeft: 20 }}>
          <li>
            Go to <strong>Options (Sidebar) -&gt; Backup Keychain</strong>.
          </li>
          <li>
            Save the <code>QRE_Backup.json</code> file to a secure location
            (e.g., a USB drive or encrypted cloud storage).
          </li>
        </ol>

        <h4 style={{ color: "var(--text-main)", marginTop: 20 }}>
          How to Restore
        </h4>
        <p>
          To restore on a new computer:
          <br />
          Copy your backup file into the app's data folder:
        </p>
        <div
          style={{
            background: "#000",
            padding: 10,
            borderRadius: 6,
            fontFamily: "monospace",
            fontSize: "0.8rem",
            overflowX: "auto",
          }}
        >
          <strong>Windows:</strong> %APPDATA%\com.qre.locker
          <br />
          <strong>macOS:</strong> ~/Library/Application Support/com.qre.locker
          <br />
          <strong>Linux:</strong> ~/.local/share/com.qre.locker
        </div>

        <h4 style={{ color: "var(--text-main)", marginTop: 20 }}>
          Forgot Password?
        </h4>
        <p>
          Use the <strong>Recovery Code</strong> (<code>QRE-XXXX...</code>) that
          was displayed when you first created your account. Click "Forgot
          Password?" on the login screen to reset your master key.
        </p>
      </Section>

      <Section id="settings" title="Advanced Settings" icon={<Settings />}>
        <ul style={{ paddingLeft: 20, display: "grid", gap: 10 }}>
          <li>
            <strong>Paranoid Mode:</strong> Forces you to move your mouse/touch
            the screen to generate "Human Entropy" before any encryption
            operation.
          </li>
          <li>
            <strong>Keyfiles:</strong> Use a physical file (like a photo or mp3)
            as a "Second Factor" key. You must have this file present to unlock
            your data.
          </li>
          <li>
            <strong>Panic Button:</strong> Press{" "}
            <kbd
              style={{
                background: "#333",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              Ctrl
            </kbd>{" "}
            +{" "}
            <kbd
              style={{
                background: "#333",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              Shift
            </kbd>{" "}
            +{" "}
            <kbd
              style={{
                background: "#333",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              Q
            </kbd>{" "}
            to instantly kill the app and wipe keys from memory.
          </li>
        </ul>
      </Section>

      <Section
        id="troubleshoot"
        title="Troubleshooting"
        icon={<AlertTriangle />}
      >
        <div style={{ marginBottom: 20 }}>
          <strong style={{ color: "var(--text-main)" }}>
            macOS: "App is damaged and can't be opened"
          </strong>
          <p style={{ marginTop: 5 }}>
            This happens because the app is not notarized by Apple. To fix it:
          </p>
          <ol style={{ paddingLeft: 20 }}>
            <li>
              Open the <strong>Terminal</strong> app.
            </li>
            <li>Paste the following command and press Enter:</li>
          </ol>
          <div
            style={{
              background: "#000",
              padding: 10,
              borderRadius: 6,
              display: "flex",
              gap: 10,
              alignItems: "center",
            }}
          >
            <Terminal size={16} color="var(--accent)" />
            <code style={{ fontFamily: "monospace", color: "var(--accent)" }}>
              sudo xattr -cr /Applications/"QRE Privacy Toolkit.app"
            </code>
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <strong style={{ color: "var(--text-main)" }}>
            "Integrity Error" when unlocking
          </strong>
          <p style={{ marginTop: 5 }}>
            This means the file has been corrupted or modified by another
            program. To prevent executing malicious code or decrypting garbage,
            QRE Toolkit refuses to open it. Try restoring from a backup.
          </p>
        </div>

        <div>
          <strong style={{ color: "var(--text-main)" }}>
            Cannot Save Notes / Permission Denied
          </strong>
          <p style={{ marginTop: 5 }}>
            Ensure you dragged the app to the <strong>Applications</strong>{" "}
            folder. Running directly from the DMG / Zip often puts the app in
            "Read-Only" mode.
          </p>
        </div>
      </Section>

      <div
        style={{
          textAlign: "center",
          marginTop: 50,
          color: "var(--text-dim)",
          fontSize: "0.8rem",
        }}
      >
        End of Manual • QRE Privacy Toolkit v{pkg.version}
      </div>
    </div>
  );
}
