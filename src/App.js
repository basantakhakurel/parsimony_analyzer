import { useState, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer
} from "recharts";

// ─── Newick Parser ────────────────────────────────────────────────────────────
function parseNewick(s) {
  s = s.trim().replace(/\s/g, "").replace(/;+$/, "");
  let i = 0;
  function parseNode() {
    const n = { ch: [], label: "" };
    if (s[i] === "(") {
      i++;
      n.ch.push(parseNode());
      while (s[i] === ",") { i++; n.ch.push(parseNode()); }
      if (s[i] === ")") i++;
    }
    let lbl = "";
    while (i < s.length && !",():".includes(s[i])) lbl += s[i++];
    n.label = lbl.replace(/^['"]|['"]$/g, "");
    if (s[i] === ":") { i++; while (i < s.length && !",():".includes(s[i])) i++; }
    return n;
  }
  return parseNode();
}

function getTips(n, acc = []) {
  if (!n.ch.length) { acc.push(n.label); return acc; }
  n.ch.forEach(c => getTips(c, acc));
  return acc;
}

// ─── NEXUS Parser (state-machine, handles Mesquite output) ────────────────────
function parseNexus(raw) {
  // Strip block comments [...]  (non-greedy, handles nested brackets poorly but ok for Mesquite)
  const text = raw.replace(/\[([^\]]*)\]/g, "");

  const ncM = text.match(/NCHAR\s*=\s*(\d+)/i);
  const nchar = ncM ? +ncM[1] : null;

  // Tokenise lines for state machine
  const lines = text.split(/\r?\n/);
  const taxa = [], seqMap = {};
  let inMatrix = false;

  for (let li = 0; li < lines.length; li++) {
    const raw2 = lines[li];
    const t = raw2.trim();
    const tUp = t.toUpperCase();

    if (!inMatrix) {
      // Look for MATRIX keyword (possibly alone on a line or followed by data)
      if (/\bMATRIX\b/i.test(t)) {
        inMatrix = true;
        // If there's content after MATRIX on the same line, handle it below
        const after = t.replace(/.*?\bMATRIX\b\s*/i, "").trim();
        if (after && after !== "" && !after.startsWith(";")) {
          // data on same line as MATRIX (unusual)
          const m = after.match(/^(\S+)\s+(.+)/);
          if (m) {
            const [, name, seq] = m;
            const cleanSeq = seq.replace(/\s+/g, "");
            if (cleanSeq && !cleanSeq.startsWith(";")) {
              if (!seqMap[name]) { taxa.push(name); seqMap[name] = ""; }
              seqMap[name] += cleanSeq;
            }
          }
        }
      }
      continue;
    }

    // Inside matrix block
    if (t === ";" || t === "") {
      if (t === ";") { inMatrix = false; break; }
      continue;
    }
    // Skip sub-keywords
    if (/^(END|BEGIN|FORMAT|TITLE|DIMENSIONS|CHARSTATELABELS|CHARLABELS|STATELABELS)\b/i.test(t)) continue;

    // Parse taxon + sequence — split on first run of whitespace
    // Taxon names may have apostrophes in some NEXUS flavors
    const m = t.match(/^'([^']+)'\s+(.+)/) || t.match(/^(\S+)\s+(.+)/);
    if (!m) continue;
    let name = m[1], seq = m[2].replace(/\s+/g, "");
    if (!seq || seq === ";") { if (seq === ";") { inMatrix = false; break; } continue; }
    // Remove trailing semicolon if present
    if (seq.endsWith(";")) { seq = seq.slice(0, -1); inMatrix = false; }
    if (!seqMap[name]) { taxa.push(name); seqMap[name] = ""; }
    seqMap[name] += seq;
  }

  if (!taxa.length) throw new Error(
    "No taxa found in MATRIX block.\n" +
    "Make sure the file is a valid NEXUS file with a MATRIX block.\n" +
    `File length: ${raw.length} chars, lines checked: ${lines.length}`
  );

  const resolvedNchar = nchar ?? seqMap[taxa[0]].length;
  return { taxa, raw: seqMap, nchar: resolvedNchar };
}

// ─── Sequence tokenizer ───────────────────────────────────────────────────────
// Returns array of Set<string> | null for each character
function tokenize(seq) {
  const out = [];
  let i = 0;
  while (i < seq.length) {
    const c = seq[i];
    if (c === "(" || c === "{") {
      const cl = c === "(" ? ")" : "}";
      let poly = ""; i++;
      while (i < seq.length && seq[i] !== cl) poly += seq[i++];
      i++;
      out.push((poly === "?" || poly === "-") ? null : new Set(poly.split("")));
    } else {
      out.push((c === "?" || c === "-") ? null : new Set([c]));
      i++;
    }
  }
  return out;
}

// ─── Fitch Parsimony ──────────────────────────────────────────────────────────
function fitchScore(tree, stateMap) {
  let cost = 0;
  function post(n) {
    if (!n.ch.length) return stateMap[n.label] ?? null;
    const kids = n.ch.map(post).filter(Boolean);
    if (!kids.length) return null;
    let inter = new Set(kids[0]);
    for (let k = 1; k < kids.length; k++)
      inter = new Set([...inter].filter(x => kids[k].has(x)));
    if (inter.size) return inter;
    cost++;
    const union = new Set();
    kids.forEach(s => s.forEach(x => union.add(x)));
    return union;
  }
  post(tree);
  return cost;
}

// ─── Color palette by state count ────────────────────────────────────────────
const STATE_KEYS = ["2", "3", "4", "5+"];
const STATE_PALETTE = {
  "2": "#34d399",
  "3": "#60a5fa",
  "4": "#c084fc",
  "5+": "#fb7185",
};

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value || 0), 0);
  return (
    <div style={{
      background: "#0f172a", border: "1px solid #334155",
      borderRadius: 8, padding: "10px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 13
    }}>
      <div style={{ color: "#94a3b8", marginBottom: 6 }}>Parsimony score: <span style={{ color: "#f1f5f9", fontWeight: 700 }}>{label}</span></div>
      {payload.map(p => p.value > 0 && (
        <div key={p.name} style={{ color: STATE_PALETTE[p.name], display: "flex", justifyContent: "space-between", gap: 24 }}>
          <span>{p.name === "5+" ? "5+ states" : `${p.name} states`}</span>
          <span style={{ color: "#f1f5f9" }}>{p.value}</span>
        </div>
      ))}
      <div style={{ color: "#64748b", borderTop: "1px solid #1e293b", marginTop: 6, paddingTop: 6 }}>
        Total: <span style={{ color: "#f1f5f9" }}>{total}</span>
      </div>
    </div>
  );
};

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function ParsimonyApp() {
  const [nexusText, setNexusText] = useState("");
  const [treeText, setTreeText] = useState("");
  const [nexusName, setNexusName] = useState("");
  const [treeName, setTreeName] = useState("");
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const nexusRef = useRef();
  const treeRef = useRef();

  function downloadCSV(results, nexusName) {
    if (!results || !results.charResults || !results.charResults.length) return;
    const header = ["char_index", "parsimony_score", "num_states"];
    const rows = results.charResults.map(({ char, score, nStates }) =>
      [char, score, nStates].join(",")
    );
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const baseName = (nexusName || "parsimony_scores").replace(/\.[^./\\]+$/, "");
    a.download = `${baseName}_scores.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const loadFile = (textSetter, nameSetter) => (e) => {
    const f = e.target.files[0];
    if (!f) return;
    nameSetter(f.name);
    const r = new FileReader();
    r.onload = ev => textSetter(ev.target.result);
    r.readAsText(f);
  };

  function analyze() {
    setError(""); setResults(null); setRunning(true);
    try {
      if (!nexusText) throw new Error("Please load a NEXUS matrix file.");
      if (!treeText) throw new Error("Please load a Newick tree file.");

      const tree = parseNewick(treeText);
      const tips = getTips(tree);
      const tipSet = new Set(tips);

      const { taxa, raw, nchar } = parseNexus(nexusText);
      const matched = taxa.filter(t => tipSet.has(t));

      if (matched.length === 0)
        throw new Error(
          `No taxa overlap between tree and matrix.\n` +
          `Tree tips (first 5): ${tips.slice(0, 5).join(", ")}\n` +
          `Matrix taxa (first 5): ${taxa.slice(0, 5).join(", ")}`
        );

      // Pre-tokenize all sequences
      const parsed = {};
      for (const t of taxa) parsed[t] = tokenize(raw[t]);

      // Per-character Fitch + state count
      const charResults = [];
      for (let c = 0; c < nchar; c++) {
        const stateMap = {}, allStates = new Set();
        for (const t of matched) {
          const s = parsed[t]?.[c] ?? null;
          stateMap[t] = s;
          if (s) s.forEach(x => allStates.add(x));
        }
        const nStates = allStates.size;
        if (nStates === 0) { charResults.push({ char: c + 1, score: 0, nStates: 0 }); continue; }
        const score = fitchScore(tree, stateMap);
        charResults.push({ char: c + 1, score, nStates });
      }

      // Build histogram
      const maxScore = Math.max(...charResults.map(d => d.score), 0);
      const hist = [];
      for (let s = 0; s <= maxScore; s++) {
        const entry = { score: s, "2": 0, "3": 0, "4": 0, "5+": 0 };
        charResults.forEach(({ score, nStates }) => {
          if (score !== s || nStates < 2) return;
          const k = nStates >= 5 ? "5+" : String(nStates);
          entry[k]++;
        });
        hist.push(entry);
      }

      const scores = charResults.map(d => d.score);
      const validScores = charResults.filter(d => d.nStates >= 2).map(d => d.score);
      const totalPS = validScores.reduce((a, b) => a + b, 0);
      const mean = validScores.length ? (totalPS / validScores.length).toFixed(3) : "—";
      const sorted = [...validScores].sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : "—";
      const invariant = charResults.filter(d => d.score === 0 && d.nStates >= 2).length;
      const missing = charResults.filter(d => d.nStates === 0).length;
      const warnings = [];
      if (matched.length < taxa.length)
        warnings.push(`${taxa.length - matched.length} matrix taxa not found in tree tips (excluded from analysis).`);

      setResults({ charResults, hist, nchar, nTaxa: matched.length, totalPS, mean, median, invariant, missing, warnings, maxScore });
    } catch (e) {
      setError(e.message);
    }
    setRunning(false);
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  const mono = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace";
  const sans = "'IBM Plex Sans', 'DM Sans', system-ui, sans-serif";

  return (
    <div style={{
      minHeight: "100vh", background: "#060e1c",
      backgroundImage: "radial-gradient(ellipse at 20% 10%, #0d1f3c 0%, transparent 60%), radial-gradient(ellipse at 80% 90%, #0d2210 0%, transparent 60%)",
      color: "#e2e8f0", fontFamily: sans, padding: "40px 24px"
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        input[type=file] { display: none; }
        .upload-btn:hover { background: #1e3a5f !important; border-color: #3b82f6 !important; }
        .run-btn:hover:not(:disabled) { background: #059669 !important; transform: translateY(-1px); box-shadow: 0 6px 24px #05966944; }
        .run-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .stat-card { background: #0d1b2e; border: 1px solid #1e3a5f; border-radius: 10px; padding: 16px 20px; }
      `}</style>

      {/* Header */}
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: "linear-gradient(135deg, #10b981, #3b82f6)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18
            }}>🌿</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", color: "#f1f5f9" }}>
              Parsimony Score Calculator
            </h1>
          </div>
          <p style={{ margin: 0, color: "#64748b", fontSize: 14, fontFamily: mono }}>
            Fitch parsimony · morphological nexus matrix · per-character analysis
          </p>
        </div>

        {/* Upload row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          {[
            { label: "NEXUS Matrix", icon: "🧬", name: nexusName, ref: nexusRef, setter: (t, n) => loadFile(setNexusText, setNexusName)({ target: { files: [t] } }), accept: ".nex,.nexus,.nxs,.txt", onRef: nexusRef, handler: loadFile(setNexusText, setNexusName) },
            { label: "Newick Tree", icon: "🌳", name: treeName, ref: treeRef, accept: ".tre,.nwk,.newick,.txt", onRef: treeRef, handler: loadFile(setTreeText, setTreeName) },
          ].map(({ label, icon, name, onRef, accept, handler }) => (
            <div key={label}>
              <input type="file" ref={onRef} accept={accept} onChange={handler} />
              <button
                className="upload-btn"
                onClick={() => onRef.current.click()}
                style={{
                  width: "100%", padding: "18px 20px", cursor: "pointer",
                  background: name ? "#0d1f3c" : "#0a1628",
                  border: `1.5px dashed ${name ? "#3b82f6" : "#1e3a5f"}`,
                  borderRadius: 10, color: "#e2e8f0", textAlign: "left",
                  transition: "all 0.18s ease", display: "flex", alignItems: "center", gap: 12
                }}
              >
                <span style={{ fontSize: 22 }}>{icon}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: name ? "#93c5fd" : "#94a3b8" }}>{label}</div>
                  <div style={{ fontSize: 12, color: name ? "#60a5fa" : "#475569", fontFamily: mono, marginTop: 2 }}>
                    {name || "Click to upload"}
                  </div>
                </div>
                {name && <span style={{ marginLeft: "auto", color: "#34d399", fontSize: 18 }}>✓</span>}
              </button>
            </div>
          ))}
        </div>

        {/* Paste area hint */}
        <div style={{
          background: "#0a1628", border: "1px solid #1e293b", borderRadius: 10,
          padding: "12px 16px", marginBottom: 20, fontSize: 12, color: "#475569", fontFamily: mono
        }}>
          <span style={{ color: "#334155" }}>Or paste Newick tree directly: </span>
          <input
            value={treeText}
            onChange={e => { setTreeText(e.target.value); setTreeName(e.target.value ? "pasted" : ""); }}
            placeholder="(taxon1:0.1,taxon2:0.2,(taxon3:0.1,taxon4:0.3):0.2);"
            style={{
              background: "transparent", border: "none", outline: "none", color: "#94a3b8",
              fontFamily: mono, fontSize: 12, width: "calc(100% - 200px)"
            }}
          />
        </div>

        {/* Run button */}
        <button
          className="run-btn"
          onClick={analyze}
          disabled={!nexusText || (!treeText)}
          style={{
            width: "100%", padding: "14px", background: "#047857",
            border: "none", borderRadius: 10, color: "#fff",
            fontSize: 15, fontWeight: 600, cursor: "pointer",
            transition: "all 0.18s ease", letterSpacing: "0.01em",
            marginBottom: 32
          }}
        >
          {running ? "⏳ Computing..." : "▶ Run Fitch Parsimony"}
        </button>

        {/* Error */}
        {error && (
          <div style={{
            background: "#1a0a0a", border: "1px solid #7f1d1d", borderRadius: 10,
            padding: "14px 18px", marginBottom: 24, color: "#fca5a5",
            fontFamily: mono, fontSize: 13, whiteSpace: "pre-wrap"
          }}>
            ⚠ {error}
          </div>
        )}

        {/* Results */}
        {results && (
          <>
            {/* Warnings */}
            {results.warnings.map((w, i) => (
              <div key={i} style={{
                background: "#1a150a", border: "1px solid #78350f", borderRadius: 8,
                padding: "10px 16px", marginBottom: 16, color: "#fcd34d", fontSize: 13, fontFamily: mono
              }}>ℹ {w}</div>
            ))}

            {/* Stats row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 28 }}>
              {[
                { label: "Characters", value: results.nchar },
                { label: "Taxa (matched)", value: results.nTaxa },
                { label: "Total PS", value: results.totalPS },
                { label: "Mean PS", value: results.mean },
                { label: "Invariant chars", value: results.invariant },
              ].map(({ label, value }) => (
                <div key={label} className="stat-card">
                  <div style={{ color: "#475569", fontSize: 11, fontFamily: mono, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
                  <div style={{ color: "#34d399", fontSize: 24, fontWeight: 700, fontFamily: mono }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Histogram */}
            <div style={{
              background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 14,
              padding: "28px 20px 20px", marginBottom: 28
            }}>
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#f1f5f9" }}>
                  Parsimony Score Distribution
                </h2>
                <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 12, fontFamily: mono }}>
                  Characters grouped by parsimony score, colored by number of states
                </p>
              </div>

              {/* Legend */}
              <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
                {STATE_KEYS.map(k => (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 12, height: 12, borderRadius: 3, background: STATE_PALETTE[k] }} />
                    <span style={{ color: "#94a3b8", fontSize: 12, fontFamily: mono }}>
                      {k === "5+" ? "5+ states" : `${k} states`}
                    </span>
                  </div>
                ))}
              </div>

              <ResponsiveContainer width="100%" height={340}>
                <BarChart data={results.hist} margin={{ top: 4, right: 20, left: -10, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="score"
                    tick={{ fill: "#64748b", fontSize: 12, fontFamily: mono }}
                    axisLine={{ stroke: "#1e3a5f" }}
                    tickLine={false}
                    label={{ value: "Parsimony Score", position: "insideBottom", offset: -2, fill: "#475569", fontSize: 12, fontFamily: mono }}
                  />
                  <YAxis
                    tick={{ fill: "#64748b", fontSize: 12, fontFamily: mono }}
                    axisLine={false}
                    tickLine={false}
                    label={{ value: "# Characters", angle: -90, position: "insideLeft", offset: 12, fill: "#475569", fontSize: 12, fontFamily: mono }}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "#1e3a5f55" }} />
                  {STATE_KEYS.map(k => (
                    <Bar key={k} dataKey={k} stackId="a" fill={STATE_PALETTE[k]} radius={k === "5+" ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Per-character table (first 100) */}
            <div style={{
              background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 14,
              padding: "24px 20px"
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#f1f5f9" }}>
                  Per-Character Detail
                  <span style={{ fontSize: 12, fontWeight: 400, color: "#475569", marginLeft: 10, fontFamily: mono }}>
                    first {Math.min(100, results.charResults.length)} of {results.charResults.length}
                  </span>
                </h2>
                <button
                  onClick={() => downloadCSV(results, nexusName)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid #1e3a5f",
                    background: "#020617",
                    color: "#e2e8f0",
                    fontFamily: mono,
                    fontSize: 11,
                    cursor: "pointer"
                  }}
                >
                  Download CSV
                </button>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: 12 }}>
                  <thead>
                    <tr>
                      {["Char #", "Parsimony Score", "# States", "Type"].map(h => (
                        <th key={h} style={{
                          textAlign: "left", padding: "8px 12px",
                          color: "#475569", fontWeight: 500, borderBottom: "1px solid #1e293b",
                          textTransform: "uppercase", fontSize: 10, letterSpacing: "0.08em"
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.charResults.slice(0, 100).map(({ char, score, nStates }) => {
                      const key = nStates >= 5 ? "5+" : String(nStates);
                      const color = nStates < 2 ? "#475569" : STATE_PALETTE[key];
                      return (
                        <tr key={char} style={{ borderBottom: "1px solid #0d1b2e" }}>
                          <td style={{ padding: "7px 12px", color: "#64748b" }}>{char}</td>
                          <td style={{ padding: "7px 12px" }}>
                            <span style={{
                              background: score === 0 ? "#0d2a1a" : "#0d1f3c",
                              color: score === 0 ? "#34d399" : "#93c5fd",
                              padding: "2px 8px", borderRadius: 4
                            }}>{score}</span>
                          </td>
                          <td style={{ padding: "7px 12px", color }}>
                            {nStates === 0 ? <span style={{ color: "#374151" }}>—</span> : nStates}
                          </td>
                          <td style={{ padding: "7px 12px", color: "#475569" }}>
                            {nStates === 0 ? "missing" : score === 0 ? "invariant" : "informative"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
