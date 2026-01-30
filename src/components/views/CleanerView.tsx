import { useState } from "react";
import { 
    ScanSearch, MapPin, User, Calendar, Camera, CheckCircle, X, 
    Upload, Sliders, FileText, List, ChevronLeft, ChevronRight 
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useDragDrop } from "../../hooks/useDragDrop";

interface MetaTag {
    key: string;
    value: string;
}

interface MetaReport {
  has_gps: boolean;
  has_author: boolean;
  camera_info?: string;
  software_info?: string;
  creation_date?: string;
  gps_info?: string;
  file_type: string;
  raw_tags: MetaTag[];
}

export function CleanerView() {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<string[]>([]); 
  
  const [previewIndex, setPreviewIndex] = useState(0); 
  const [previewReport, setPreviewReport] = useState<MetaReport | null>(null);
  const [analyzingPreview, setAnalyzingPreview] = useState(false);
  
  const [showRaw, setShowRaw] = useState(false);
  const [opts, setOpts] = useState({ gps: true, author: true, date: true });

  const { isDragging } = useDragDrop(async (newFiles) => {
    addFiles(newFiles);
  });

  const addFiles = (newPaths: string[]) => {
    const unique = [...new Set([...files, ...newPaths])];
    setFiles(unique);
    if (files.length === 0 && newPaths.length > 0) {
      setPreviewIndex(0);
      analyze(newPaths[0]);
    }
  };

  async function handleBrowse() {
    try {
        const selected = await open({
            multiple: true,
            filters: [{ name: "Media & Docs", extensions: ["jpg", "jpeg", "png", "pdf", "docx", "xlsx", "pptx", "zip"] }] 
        });
        if (selected) {
            const paths = Array.isArray(selected) ? selected : [selected];
            addFiles(paths);
        }
    } catch (e) {
        console.error(e);
    }
  }

  async function analyze(path: string) {
    setAnalyzingPreview(true);
    setPreviewReport(null);
    try {
      const res = await invoke<MetaReport>("analyze_file_metadata", { path });
      setPreviewReport(res);
    } catch (e) {
      console.error(e);
    } finally {
      setAnalyzingPreview(false);
    }
  }

  async function cleanAll() {
    if (files.length === 0) return;
    setLoading(true);
    setResults([]);
    
    const cleaned: string[] = [];
    for (const file of files) {
        try {
            const res = await invoke<string>("clean_file_metadata", { path: file, options: opts });
            cleaned.push(res);
        } catch (e) {
            console.error(`Failed to clean ${file}:`, e);
        }
    }

    setResults(cleaned);
    setLoading(false);
    setFiles([]); 
    setPreviewReport(null);
    setPreviewIndex(0);
    setShowRaw(false);
  }

  function removeFile(path: string) {
      const idxToRemove = files.indexOf(path);
      const newFiles = files.filter(f => f !== path);
      setFiles(newFiles);

      if (newFiles.length === 0) {
          setPreviewReport(null);
          setPreviewIndex(0);
      } else {
          if (idxToRemove === previewIndex) {
              const newIdx = idxToRemove >= newFiles.length ? newFiles.length - 1 : idxToRemove;
              setPreviewIndex(newIdx);
              analyze(newFiles[newIdx]);
          } else if (idxToRemove < previewIndex) {
              setPreviewIndex(previewIndex - 1);
          }
      }
  }

  const handleNext = () => {
      if (previewIndex < files.length - 1) {
          const newIdx = previewIndex + 1;
          setPreviewIndex(newIdx);
          analyze(files[newIdx]);
      }
  };

  const handlePrev = () => {
      if (previewIndex > 0) {
          const newIdx = previewIndex - 1;
          setPreviewIndex(newIdx);
          analyze(files[newIdx]);
      }
  };

  const currentFileName = files[previewIndex] ? files[previewIndex].split(/[/\\]/).pop() : "Unknown";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      
      {/* Scrollable Content */}
      <div style={{ 
          flex: 1, overflowY: "auto", padding: "30px", 
          display: "flex", flexDirection: "column", alignItems: "center" // Center children horizontally
      }}>
        
        {/* CENTERED EMPTY STATE */}
        {files.length === 0 && results.length === 0 && (
             <div 
                className={`shred-zone ${isDragging ? "active" : ""}`} 
                style={{ 
                    borderColor: "var(--accent)", 
                    flex: 1, 
                    width: '100%', 
                    maxWidth: '600px', // Constrain width for better look
                    minHeight: '400px', 
                    display: 'flex', 
                    flexDirection: 'column', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    alignSelf: 'center' // Center in parent
                }}
                onClick={handleBrowse}
            >
                <div style={{
                    background: 'rgba(34, 197, 94, 0.1)', 
                    padding: 20, borderRadius: '50%', marginBottom: 20
                }}>
                    <ScanSearch size={48} color="#22c55e" />
                </div>
                <h2 style={{margin: '0 0 10px 0'}}>Metadata Scrubbing</h2>
                <p style={{ color: "var(--text-dim)", marginBottom: 25, maxWidth: 300, textAlign: 'center', lineHeight: 1.5 }}>
                Remove hidden GPS location, camera details, and personal data from photos and documents.
                </p>
                <button className="secondary-btn" onClick={(e) => { e.stopPropagation(); handleBrowse(); }}>
                    <Upload size={16} style={{marginRight: 8}}/> Select Files
                </button>
            </div>
        )}

        {/* RESULTS SCREEN */}
        {results.length > 0 && (
            <div style={{ textAlign: "center", color: "#42b883", width: "100%", maxWidth: 600 }}>
                <CheckCircle size={64} style={{ marginBottom: 15 }} />
                <h3 style={{fontSize: '1.5rem', margin: '0 0 10px 0'}}>Cleanup Complete</h3>
                <p style={{color: "var(--text-dim)", fontSize: '1rem'}}>
                    {results.length} files scrubbed successfully.
                </p>
                <div style={{ textAlign: "left", background: "var(--bg-card)", padding: 15, borderRadius: 8, margin: "20px 0", maxHeight: 200, overflowY: "auto", border: '1px solid var(--border)' }}>
                    {results.map((r, i) => (
                        <div key={i} style={{fontSize: "0.9rem", color: "var(--text-main)", marginBottom: 5, display: 'flex', alignItems: 'center', gap: 10}}>
                            <CheckCircle size={14} color="var(--accent)" /> {r.split(/[/\\]/).pop()}
                        </div>
                    ))}
                </div>
                <button className="auth-btn" onClick={() => setResults([])} style={{ width: "100%" }}>Clean More Files</button>
            </div>
        )}

        {/* PROCESSING SCREEN */}
        {files.length > 0 && (
          <div style={{ width: "100%", textAlign: "left", maxWidth: 600 }}>
            
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: 'center', marginBottom: 15 }}>
                <span style={{fontWeight: "bold", fontSize: '1.2rem'}}>{files.length} Files Selected</span>
                <button 
                    className="icon-btn-ghost" 
                    style={{color: 'var(--btn-danger)', fontSize: '0.9rem'}} 
                    onClick={() => { setFiles([]); setPreviewReport(null); }}
                >
                    Cancel All
                </button>
            </div>

            {/* File List */}
            <div style={{ 
                maxHeight: "100px", 
                overflowY: "auto", 
                marginBottom: 15, 
                background: 'rgba(0,0,0,0.1)', 
                borderRadius: 6,
                padding: 5 
            }}>
                {files.map((f, i) => (
                    <div key={i} style={{ 
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        fontSize: "0.85rem", padding: "6px 10px", 
                        background: "var(--bg-card)", marginBottom: 4, borderRadius: 4,
                        border: '1px solid var(--border)'
                    }}>
                        <div style={{display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden'}}>
                            <FileText size={14} color="var(--text-dim)"/>
                            <span style={{overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                                {f.split(/[/\\]/).pop()}
                            </span>
                        </div>
                        <X 
                            size={16} 
                            style={{cursor:"pointer", color: "var(--text-dim)"}} 
                            onClick={() => removeFile(f)} 
                        />
                    </div>
                ))}
            </div>

            {/* PREVIEW CARD */}
            <div style={{ background: "var(--bg-card)", borderRadius: 10, marginBottom: 20, border: '1px solid var(--border)', overflow: 'hidden' }}>
                  
                  {/* Card Header */}
                  <div style={{ 
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
                      padding: '15px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border)' 
                  }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Camera size={20} color="var(--accent)" />
                          <div style={{display: 'flex', flexDirection: 'column'}}>
                              <span style={{fontWeight: 'bold', fontSize: '0.95rem'}}>Metadata Report</span>
                              <span style={{fontSize: '0.8rem', color: 'var(--text-dim)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                                  {currentFileName}
                              </span>
                          </div>
                      </div>

                      {/* Navigation */}
                      {files.length > 1 && (
                          <div style={{display: 'flex', alignItems: 'center', gap: 5}}>
                              <button 
                                  className="icon-btn-ghost" 
                                  disabled={previewIndex === 0}
                                  onClick={handlePrev}
                                  style={{padding: 5}}
                              >
                                  <ChevronLeft size={20} />
                              </button>
                              <span style={{fontSize: '0.85rem', color: 'var(--text-dim)', minWidth: '60px', textAlign: 'center'}}>
                                  {previewIndex + 1} / {files.length}
                              </span>
                              <button 
                                  className="icon-btn-ghost"
                                  disabled={previewIndex === files.length - 1}
                                  onClick={handleNext}
                                  style={{padding: 5}}
                              >
                                  <ChevronRight size={20} />
                              </button>
                          </div>
                      )}
                  </div>
                  
                  <div style={{ padding: 20 }}>
                      {analyzingPreview ? (
                          <div style={{textAlign: 'center', padding: 20, color: 'var(--text-dim)'}}>Scanning...</div>
                      ) : previewReport ? (
                          <div style={{ display: 'grid', gap: 15 }}>
                              
                              <div style={{ display: "flex", gap: 12, alignItems: 'flex-start' }}>
                                  <div style={{
                                      background: previewReport.has_gps ? 'rgba(248, 113, 113, 0.1)' : 'rgba(255,255,255,0.05)',
                                      padding: 8, borderRadius: 6, color: previewReport.has_gps ? '#f87171' : 'var(--text-dim)'
                                  }}>
                                      <MapPin size={20} />
                                  </div>
                                  <div>
                                      <div style={{fontWeight: 600, color: previewReport.has_gps ? '#f87171' : 'var(--text-dim)'}}>
                                          {previewReport.has_gps ? "GPS Location Detected" : "No Location Data"}
                                      </div>
                                      {previewReport.gps_info && (
                                          <div style={{fontSize: '0.85rem', opacity: 0.8, marginTop: 4, fontFamily: 'monospace', background: 'rgba(0,0,0,0.2)', padding: '2px 6px', borderRadius: 4, display: 'inline-block'}}>
                                              {previewReport.gps_info}
                                          </div>
                                      )}
                                  </div>
                              </div>

                              <div style={{ display: "flex", gap: 12, alignItems: 'flex-start' }}>
                                  <div style={{
                                      background: previewReport.has_author ? 'rgba(250, 204, 21, 0.1)' : 'rgba(255,255,255,0.05)',
                                      padding: 8, borderRadius: 6, color: previewReport.has_author ? '#facc15' : 'var(--text-dim)'
                                  }}>
                                      <User size={20} />
                                  </div>
                                  <div>
                                      <div style={{fontWeight: 600, color: previewReport.has_author ? '#facc15' : 'var(--text-dim)'}}>
                                          {previewReport.has_author ? "Device / Author Info" : "No Device Info"}
                                      </div>
                                      {previewReport.camera_info && <div style={{fontSize: '0.85rem', color: 'var(--text-dim)', marginTop: 2}}>{previewReport.camera_info}</div>}
                                  </div>
                              </div>

                              <div style={{ display: "flex", gap: 12, alignItems: 'flex-start' }}>
                                  <div style={{
                                      background: previewReport.creation_date ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)',
                                      padding: 8, borderRadius: 6, color: previewReport.creation_date ? 'var(--text-main)' : 'var(--text-dim)'
                                  }}>
                                      <Calendar size={20} />
                                  </div>
                                  <div>
                                      <div style={{fontWeight: 600, color: previewReport.creation_date ? 'var(--text-main)' : 'var(--text-dim)'}}>
                                          {previewReport.creation_date ? "Creation Timestamp" : "No Date Found"}
                                      </div>
                                      {previewReport.creation_date && <div style={{fontSize: '0.85rem', color: 'var(--text-dim)', marginTop: 2}}>{previewReport.creation_date}</div>}
                                  </div>
                              </div>

                              {/* RAW METADATA TOGGLE */}
                              <div style={{borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 5}}>
                                  <button 
                                    onClick={() => setShowRaw(!showRaw)}
                                    style={{
                                        background: 'transparent', border: 'none', color: 'var(--text-dim)', 
                                        fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, padding: 0
                                    }}
                                  >
                                      <List size={14}/> {showRaw ? "Hide" : "View"} Full Metadata ({previewReport.raw_tags.length} tags)
                                  </button>

                                  {showRaw && (
                                      <div style={{
                                          marginTop: 10, maxHeight: 150, overflowY: 'auto', 
                                          background: 'rgba(0,0,0,0.2)', padding: 10, borderRadius: 6
                                      }}>
                                          <table style={{width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse'}}>
                                              <tbody>
                                                  {previewReport.raw_tags.map((tag, i) => (
                                                      <tr key={i} style={{borderBottom: '1px solid rgba(255,255,255,0.05)'}}>
                                                          <td style={{color: 'var(--accent)', padding: '4px 0', fontWeight: 600, width: '40%'}}>{tag.key}</td>
                                                          <td style={{color: 'var(--text-dim)', padding: '4px 0', textAlign: 'right', wordBreak: 'break-all'}}>{tag.value}</td>
                                                      </tr>
                                                  ))}
                                              </tbody>
                                          </table>
                                      </div>
                                  )}
                              </div>

                          </div>
                      ) : (
                          <div style={{textAlign: 'center', color: 'var(--text-dim)'}}>Unable to read metadata</div>
                      )}
               </div>
            </div>

            {/* Options Toggles */}
            <div style={{ marginBottom: 20 }}>
                <div style={{fontSize: '0.9rem', fontWeight: 'bold', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8}}>
                    <Sliders size={16} /> Scrubbing Options
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-card)', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', border: opts.gps ? '1px solid var(--accent)' : '1px solid var(--border)', flex: 1, justifyContent: 'center' }}>
                        <input type="checkbox" checked={opts.gps} onChange={() => setOpts({...opts, gps: !opts.gps})} />
                        GPS
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-card)', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', border: opts.author ? '1px solid var(--accent)' : '1px solid var(--border)', flex: 1, justifyContent: 'center' }}>
                        <input type="checkbox" checked={opts.author} onChange={() => setOpts({...opts, author: !opts.author})} />
                        Info
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-card)', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', border: opts.date ? '1px solid var(--accent)' : '1px solid var(--border)', flex: 1, justifyContent: 'center' }}>
                        <input type="checkbox" checked={opts.date} onChange={() => setOpts({...opts, date: !opts.date})} />
                        Dates
                    </label>
                </div>
            </div>

            <button 
                className="auth-btn" 
                style={{ width: '100%', padding: '14px', fontSize: '1rem' }} 
                onClick={cleanAll}
                disabled={loading}
            >
                {loading ? "Scrubbing Files..." : `Clean All ${files.length} Files`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}