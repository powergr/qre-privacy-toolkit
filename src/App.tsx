import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import "./App.css";

function App() {
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("Ready");
  const [statusType, setStatusType] = useState("");
  const [isParanoid, setIsParanoid] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // 1. Select Target Files (Multiple)
  async function selectTargetFile() {
    const selected = await open({ multiple: true });
    if (selected) {
      if (Array.isArray(selected)) {
        setSelectedFiles(selected);
      } else {
        setSelectedFiles([selected]);
      }
      setStatus("Files selected.");
      setStatusType("");
    }
  }

  // 2. Select Key File
  async function selectKeyFile() {
    const selected = await open({ multiple: false });
    if (selected && typeof selected === "string") {
      setKeyFile(selected);
    }
  }

  function generateBrowserEntropy(): number[] | null {
    if (!isParanoid) return null;
    const array = new Uint8Array(32);
    window.crypto.getRandomValues(array);
    return Array.from(array);
  }

  async function runAction(command: "lock_file" | "unlock_file") {
    if (selectedFiles.length === 0) {
      setStatus("Please select files to process.");
      setStatusType("error");
      return;
    }
    if (!password && !keyFile) {
      setStatus("Enter a passphrase OR select a keyfile.");
      setStatusType("error");
      return;
    }

    setStatus(`Processing ${selectedFiles.length} file(s)...`);
    setStatusType("");

    try {
      const entropy = command === "lock_file" ? generateBrowserEntropy() : null;

      const msg = await invoke(command, {
        filePaths: selectedFiles,
        password: password,
        keyfilePath: keyFile,
        extraEntropy: entropy,
      });

      setStatus(msg as string);
      setStatusType("success");
      // Optional: Clear after success?
      // setSelectedFiles([]);
    } catch (e) {
      setStatus("Error: " + e);
      setStatusType("error");
    }
  }

  return (
    <div className="container">
      {/* HEADER */}
      <div className="header">
        <div className="logo">
          <h1>QRE Locker</h1>
        </div>
        <div className="menu">
          <button
            className="menu-link"
            onClick={() =>
              openUrl("https://github.com/powergr/quantum-locker/")
            }
          >
            GitHub
          </button>
          <button className="menu-link" onClick={() => setShowHelp(true)}>
            Help & Info
          </button>
        </div>
      </div>

      {/* HELP MODAL */}
      {showHelp && (
        <div className="modal-overlay" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>How to use QRE</h2>

            <h3>🔒 To Encrypt</h3>
            <p>
              1. Select one or more files.
              <br />
              2. Enter a strong passphrase.
              <br />
              3. Click <b>Lock</b>. The original files will be replaced by{" "}
              <code>.qre</code> files.
            </p>

            <h3>🔓 To Decrypt</h3>
            <p>
              1. Select the <code>.qre</code> files.
              <br />
              2. Enter the passphrase used to lock them.
              <br />
              3. Click <b>Unlock</b>.
            </p>

            <h3>🛡️ Advanced Features</h3>
            <p>
              <b>Keyfile:</b> Use an image or file as a second key (2FA). You
              must have this file to decrypt.
              <br />
              <b>Paranoid Mode:</b> Injects extra randomness from your computer
              for key generation.
            </p>

            <button className="close-btn" onClick={() => setShowHelp(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {/* MAIN CARD */}
      <div className="card">
        {/* FILE SELECTION */}
        <div className="file-area">
          <button className="select-btn" onClick={selectTargetFile}>
            {selectedFiles.length > 0
              ? "Add / Change Files"
              : "Select Files to Secure"}
          </button>

          {/* Scrollable List */}
          <div className="file-list-container">
            {selectedFiles.length === 0 ? (
              <div className="file-item-empty">No files selected</div>
            ) : (
              selectedFiles.map((file, idx) => (
                <div key={idx} className="file-item">
                  {file}
                </div>
              ))
            )}
          </div>
        </div>

        {/* PASSWORD */}
        <div className="input-group">
          <label>Passphrase</label>
          <input
            onChange={(e) => setPassword(e.currentTarget.value)}
            placeholder="Type your secret phrase..."
            type="password"
          />
        </div>

        {/* ADVANCED OPTIONS ROW */}
        <div className="secondary-controls">
          <button
            className={`keyfile-btn ${keyFile ? "active" : ""}`}
            onClick={selectKeyFile}
            title={keyFile ? keyFile : "Select a file to use as a key"}
          >
            {keyFile ? "Keyfile Active ✓" : "🔑 Add Keyfile (Opt)"}
          </button>

          <label className="checkbox-container">
            <input
              type="checkbox"
              checked={isParanoid}
              onChange={(e) => setIsParanoid(e.target.checked)}
            />
            <span>Paranoid Mode</span>
          </label>
        </div>

        {/* ACTION BUTTONS WITH DARK ICONS */}
        <div className="actions">
          <button
            className="action-btn btn-lock"
            onClick={() => runAction("lock_file")}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1a1b26"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            Lock
          </button>

          <button
            className="action-btn btn-unlock"
            onClick={() => runAction("unlock_file")}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1a1b26"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
            </svg>
            Unlock
          </button>
        </div>
      </div>

      <div className={`status-bar ${statusType}`}>{status}</div>
    </div>
  );
}

export default App;
