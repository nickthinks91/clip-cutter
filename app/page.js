"use client";
import { useState, useRef, useEffect } from "react";
import { getSongs, createSong, deleteSong as dbDeleteSong, uploadAudio, getAudioUrl, saveAiClips, getAiClips, submitPicks as dbSubmitPicks, getSubmissions, subscribeToSubmissions } from "../lib/supabase";

/* ═══ AUDIO ANALYSIS ═══ */
function analyzeAudio(audioBuffer) {
  const sr = audioBuffer.sampleRate, data = audioBuffer.getChannelData(0), duration = audioBuffer.duration;
  const frameSize = Math.floor(sr * 0.05), hopSize = Math.floor(frameSize / 2);
  const numFrames = Math.floor((data.length - frameSize) / hopSize);
  if (numFrames < 10) return { duration, bpm: 120, energy: [], topClips: [], scoreClip: () => ({ score: 0 }) };
  const energy = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) { const s = i * hopSize; let sum = 0; for (let j = s; j < s + frameSize && j < data.length; j++) sum += data[j] * data[j]; energy[i] = Math.sqrt(sum / frameSize); }
  const zcr = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) { const s = i * hopSize; let c = 0; for (let j = s + 1; j < s + frameSize && j < data.length; j++) { if ((data[j] >= 0) !== (data[j - 1] >= 0)) c++; } zcr[i] = c / frameSize; }
  const norm = arr => { let mx = -Infinity, mn = Infinity; for (let i = 0; i < arr.length; i++) { if (arr[i] > mx) mx = arr[i]; if (arr[i] < mn) mn = arr[i]; } const out = new Float32Array(arr.length); if (mx > mn) for (let i = 0; i < arr.length; i++) out[i] = (arr[i] - mn) / (mx - mn); else for (let i = 0; i < arr.length; i++) out[i] = 0.5; return out; };
  const nE = norm(energy), nZ = norm(zcr);
  const eD = new Float32Array(nE.length); for (let i = 1; i < nE.length; i++) eD[i] = nE[i] - nE[i - 1];
  const onsets = []; for (let i = 2; i < nE.length - 2; i++) { if (eD[i] > 0.02 && eD[i] > eD[i - 1] && eD[i] > eD[i + 1]) onsets.push({ frame: i, strength: eD[i] }); }
  const dsStep = 4, dsLen = Math.floor(nE.length / dsStep), dsE = new Float32Array(dsLen);
  for (let i = 0; i < dsLen; i++) dsE[i] = nE[i * dsStep];
  const acLen = Math.min(dsLen, Math.floor(sr * 2 / (hopSize * dsStep))), ac = new Float32Array(acLen);
  for (let lag = 0; lag < acLen; lag++) { let s2 = 0; for (let i = 0; i < dsLen - lag; i++) s2 += dsE[i] * dsE[i + lag]; ac[lag] = s2; }
  const mnL = Math.max(1, Math.floor(60 / (180 * hopSize * dsStep / sr))), mxL = Math.floor(60 / (60 * hopSize * dsStep / sr));
  let bL = mnL; for (let l = mnL; l < Math.min(mxL, acLen); l++) if (ac[l] > ac[bL]) bL = l;
  const bpm = Math.round(60 * sr / (bL * hopSize * dsStep)), f2t = f => f * hopSize / sr;
  function scoreClip(startTime, endTime) {
    const sf = Math.floor(startTime * sr / hopSize), ef = Math.min(Math.floor(endTime * sr / hopSize), numFrames);
    const hF = Math.min(sf + Math.floor(15 * sr / hopSize), ef), hookLen = Math.max(1, hF - sf);
    let hE = 0; for (let f = sf; f < hF; f++) hE += nE[f] || 0; hE /= hookLen;
    const hO = onsets.filter(o => o.frame >= sf && o.frame < hF).length;
    const f6 = Math.min(sf + Math.floor(6 * sr / hopSize), ef);
    let mD = 0; for (let f = sf + 1; f < f6; f++) mD = Math.max(mD, Math.abs(eD[f] || 0));
    let eSum = 0, eSum2 = 0, cnt = 0; for (let f = sf; f < ef; f++) { eSum += nE[f] || 0; eSum2 += (nE[f] || 0) ** 2; cnt++; }
    const vr = cnt > 0 ? eSum2 / cnt - (eSum / cnt) ** 2 : 0;
    let hB = 0; for (let f = sf; f < hF; f++) hB += nZ[f] || 0; hB /= hookLen;
    const lW = Math.floor(0.5 * sr / hopSize); let sE = 0, eE2 = 0;
    for (let f = 0; f < lW && sf + f < numFrames; f++) sE += nE[sf + f] || 0;
    for (let f = 0; f < lW; f++) eE2 += nE[Math.min(ef - lW + f, numFrames - 1)] || 0;
    const lS = lW > 0 ? 1 - Math.abs(sE / lW - eE2 / lW) : 0.5;
    return { hookEnergy: hE, hookOnsetCount: hO, maxEnergyDelta: mD, brightness: hB, loopScore: lS, score: hE * 3 + Math.min(hO / 10, 1) * 2 + mD * 2.5 + Math.sqrt(Math.max(0, vr)) * 1.5 + hB * 1.5 + lS };
  }
  const clipFrames = Math.floor(60 * sr / hopSize), step2 = Math.floor(2 * sr / hopSize), cands = [];
  for (let sf = 0; sf + clipFrames <= numFrames; sf += step2) { const st = f2t(sf), et = f2t(sf + clipFrames); cands.push({ startTime: st, endTime: et, ...scoreClip(st, et) }); }
  cands.sort((a, b) => b.score - a.score);
  const top = []; for (const c of cands) { if (top.every(t => Math.abs(t.startTime - c.startTime) > 5)) top.push(c); if (top.length >= 5) break; }
  let displayEnergy;
  if (nE.length > 4000) { const factor = Math.ceil(nE.length / 4000); displayEnergy = []; for (let i = 0; i < nE.length; i += factor) { let mx = 0; for (let j = i; j < Math.min(i + factor, nE.length); j++) if (nE[j] > mx) mx = nE[j]; displayEnergy.push(mx); } } else displayEnergy = Array.from(nE);
  return { duration, bpm: Math.min(200, Math.max(60, bpm)), energy: displayEnergy, topClips: top, scoreClip };
}

/* ═══ CONSENSUS ═══ */
function buildConsensus(submissions, threshold = 8) {
  const all = []; submissions.forEach(s => (s.clips || []).forEach(c => all.push({ ...c, member: s.member })));
  if (!all.length) return [];
  const sorted = [...all].sort((a, b) => a.startTime - b.startTime);
  const clusters = []; let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) { if (sorted[i].startTime - cur[cur.length - 1].startTime <= threshold) cur.push(sorted[i]); else { clusters.push(cur); cur = [sorted[i]]; } } clusters.push(cur);
  return clusters.map(cl => {
    const avgS = cl.reduce((s, c) => s + c.startTime, 0) / cl.length, avgE = cl.reduce((s, c) => s + c.endTime, 0) / cl.length;
    const members = [...new Set(cl.map(c => c.member))];
    return { startTime: avgS, endTime: avgE, dur: Math.round(avgE - avgS), memberCount: members.length, members, total: submissions.length, agreement: members.length / submissions.length, picks: cl };
  }).sort((a, b) => b.memberCount - a.memberCount);
}

/* ═══ WAV ═══ */
function encodeWav(ab) {
  const nc = ab.numberOfChannels, sr = ab.sampleRate, ns = ab.length, bps = 2, ds = ns * nc * bps;
  const buf = new ArrayBuffer(44 + ds), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + ds, true); ws(8, "WAVE"); ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, 16, true);
  ws(36, "data"); v.setUint32(40, ds, true); let o = 44; const ch = []; for (let c = 0; c < nc; c++) ch.push(ab.getChannelData(c));
  for (let i = 0; i < ns; i++) for (let c = 0; c < nc; c++) { const s = Math.max(-1, Math.min(1, ch[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
  return new Blob([buf], { type: "audio/wav" });
}

const fmt = s => { const m = Math.floor(s / 60), sc = Math.floor(s % 60); return `${m}:${sc.toString().padStart(2, "0")}`; };

/* ═══ WAVEFORM ═══ */
function Waveform({ energy, duration, clips, highlights, selClip, onSel, onCreate, onEdge, onMove, zoom, onZoom, readonly, onPlayFrom, playheadTime }) {
  const ref = useRef(null), [drag, setDrag] = useState(null), [hover, setHover] = useState(null);
  const zS = zoom[0], zE = zoom[1], zD = zE - zS;
  const t2x = (t, w) => ((t - zS) / zD) * w, x2t = (x, w) => zS + (x / w) * zD;
  useEffect(() => {
    const c = ref.current; if (!c || !energy.length) return;
    const ctx = c.getContext("2d"), w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#0a0a12"; ctx.fillRect(0, 0, w, h);
    // Full track highlight when no clips
    if ((!clips || clips.length === 0) && !readonly) { ctx.fillStyle = "rgba(0,240,255,0.06)"; ctx.fillRect(0, 0, w, h); }
    const gs = zD < 30 ? 1 : zD < 120 ? 5 : 10;
    ctx.strokeStyle = "rgba(255,255,255,0.03)"; ctx.lineWidth = 1;
    for (let t = Math.ceil(zS / gs) * gs; t <= zE; t += gs) { const x = t2x(t, w); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    (highlights || []).forEach(hl => { const x1 = Math.max(0, t2x(hl.startTime, w)), x2 = Math.min(w, t2x(hl.endTime, w)); if (x2 < 0 || x1 > w) return; ctx.fillStyle = hl.color || "rgba(255,215,0,0.08)"; ctx.fillRect(x1, 0, x2 - x1, h); if (hl.label && x2 - x1 > 30) { ctx.fillStyle = hl.lc || "rgba(255,215,0,0.5)"; ctx.font = "bold 9px monospace"; ctx.fillText(hl.label, x1 + 4, h - 5); } });
    (clips || []).forEach((cl, idx) => { const x1 = Math.max(0, t2x(cl.startTime, w)), x2 = Math.min(w, t2x(cl.endTime, w)); if (x2 < 0 || x1 > w) return; const isSel = idx === selClip; ctx.fillStyle = isSel ? "rgba(0,240,255,0.12)" : "rgba(255,255,255,0.025)"; ctx.fillRect(x1, 0, x2 - x1, h); if (!readonly) { ctx.fillStyle = isSel ? "rgba(0,240,255,0.5)" : "rgba(255,255,255,0.12)"; ctx.fillRect(x1, 0, 3, h); ctx.fillRect(x2 - 3, 0, 3, h); } ctx.fillStyle = isSel ? "#00f0ff" : "rgba(255,255,255,0.3)"; ctx.font = "bold 10px monospace"; const lbl = cl.isManual ? "✎" : `#${idx + 1}`; if (x2 - x1 > 30) ctx.fillText(lbl, x1 + 5, 13); });
    const si = Math.floor((zS / duration) * energy.length), ei = Math.floor((zE / duration) * energy.length);
    ctx.beginPath(); ctx.moveTo(0, h); for (let x = 0; x < w; x++) { const eI = si + Math.floor((x / w) * (ei - si)); ctx.lineTo(x, h - (energy[Math.min(eI, energy.length - 1)] || 0) * h * 0.85); } ctx.lineTo(w, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "rgba(0,240,255,0.5)"); g.addColorStop(0.5, "rgba(179,102,255,0.2)"); g.addColorStop(1, "rgba(255,51,102,0.02)"); ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.2)"; ctx.font = "9px monospace"; for (let t = Math.ceil(zS / gs) * gs; t <= zE; t += gs) ctx.fillText(fmt(t), t2x(t, w) + 2, h - 3);
    // Playhead
    if (playheadTime != null && playheadTime >= zS && playheadTime <= zE) { const px = t2x(playheadTime, w); ctx.strokeStyle = "#ff3366"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke(); ctx.fillStyle = "#ff3366"; ctx.font = "bold 9px monospace"; ctx.fillText(fmt(playheadTime), px + 4, 12); }
    if (hover !== null && playheadTime == null) { const hx = t2x(hover, w); ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.font = "9px monospace"; ctx.fillText(fmt(hover), hx + 3, h - 14); }
  }, [energy, clips, highlights, selClip, duration, zoom, hover, drag, playheadTime]);
  const gx = e => { const r = ref.current.getBoundingClientRect(); return (e.clientX - r.left) * (800 / r.width); };
  const findEdge = cx => { if (readonly) return null; for (let i = 0; i < (clips || []).length; i++) { const x1 = t2x(clips[i].startTime, 800), x2 = t2x(clips[i].endTime, 800); if (Math.abs(cx - x1) < 10) return { idx: i, edge: "start" }; if (Math.abs(cx - x2) < 10) return { idx: i, edge: "end" }; } return null; };
  const findClip = cx => { const t = x2t(cx, 800), hits = []; for (let i = 0; i < (clips || []).length; i++) if (t >= clips[i].startTime && t <= clips[i].endTime) hits.push(i); if (!hits.length) return null; if (hits.includes(selClip)) return selClip; return hits[0]; };
  const onDown = e => { if (readonly) return; const x = gx(e); const eh = findEdge(x); if (eh) { setDrag({ type: "edge", ...eh }); return; } const hit = findClip(x); if (hit !== null) { onSel(hit); setDrag({ type: "move", idx: hit, startT: x2t(x, 800), origS: clips[hit].startTime, origE: clips[hit].endTime }); } else if (onPlayFrom) { onPlayFrom(Math.max(0, x2t(x, 800))); } };
  const onMv = e => { const x = gx(e); setHover(x2t(x, 800)); if (drag?.type === "move") { const dt = x2t(x, 800) - drag.startT, cd = drag.origE - drag.origS; let ns = drag.origS + dt, ne = drag.origE + dt; if (ns < 0) { ns = 0; ne = cd; } if (ne > duration) { ne = duration; ns = duration - cd; } onMove(drag.idx, ns, ne); } else if (drag?.type === "edge") onEdge(drag.idx, drag.edge, Math.max(0, Math.min(duration, x2t(x, 800)))); };
  const onUp = () => setDrag(null);
  const onDbl = e => { if (readonly) return; onCreate(Math.max(0, x2t(gx(e), 800)), null); };
  const onWhl = e => { e.preventDefault(); const x = gx(e), p = x2t(x, 800), f = e.deltaY > 0 ? 1.3 : 0.7, nd = Math.max(5, Math.min(duration, zD * f)), r = (p - zS) / zD; let ns = p - r * nd, ne = p + (1 - r) * nd; if (ns < 0) { ne -= ns; ns = 0; } if (ne > duration) { ns -= (ne - duration); ne = duration; } onZoom([Math.max(0, ns), Math.min(duration, ne)]); };
  return <canvas ref={ref} width={800} height={120} onMouseDown={onDown} onMouseMove={onMv} onMouseUp={onUp} onMouseLeave={() => { setHover(null); setDrag(null); }} onDoubleClick={onDbl} onWheel={onWhl} style={{ width: "100%", height: 120, borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)", cursor: "default", display: "block" }} />;
}

/* ═══ UI ═══ */
function AgreementBar({ count, total }) { const pct = total > 0 ? (count / total) * 100 : 0; const color = pct >= 70 ? "#44ff88" : pct >= 40 ? "#ffd700" : "#ff8844"; return <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} /></div><span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: "monospace", minWidth: 40 }}>{count}/{total}</span></div>; }


function ClipCard({ c, idx, sel, playing, isModified, bs, onSel, onPlay, onExport, onDur, onNote, onAB, onRevert, onDel, editNote, setEditNote, ab, clips }) {
  const isSel = idx === sel;
  return (
    <div onClick={() => onSel(idx)} style={{ background: isSel ? "rgba(0,240,255,0.035)" : "rgba(255,255,255,0.01)", border: `1px solid ${isSel ? "rgba(0,240,255,0.15)" : "rgba(255,255,255,0.035)"}`, borderRadius: 8, padding: "10px 12px", cursor: "pointer", transition: "all 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 800, minWidth: 28, textAlign: "center", color: c.isManual ? "#ffd700" : idx === 0 ? "#00f0ff" : idx === 1 ? "#b366ff" : "#7a7a8e" }}>{c.isManual ? "✎" : `#${idx + 1}`}</div>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>{fmt(c.startTime)} → {fmt(c.endTime)}</span>
          <span style={{ fontSize: 9, color: "#7a7a8e", marginLeft: 5 }}>({c.dur}s)</span>
          {isModified && <span style={{ fontSize: 8, color: "#ff8844", marginLeft: 5, fontFamily: "monospace" }}>● edited</span>}
          {c.notes && <span style={{ fontSize: 9, color: "#b366ff", marginLeft: 6, fontStyle: "italic" }}>📝 {c.notes}</span>}
        </div>
        <div style={{ display: "flex", gap: 3, alignItems: "center", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 2 }}>{[15, 30, 60].map(d => <button key={d} onClick={e => { e.stopPropagation(); onDur(idx, d); }} style={{ ...bs(c.dur === d), padding: "2px 5px", fontSize: 8 }}>{d}s</button>)}</div>
          <button onClick={e => { e.stopPropagation(); onPlay(idx); }} style={{ width: 28, height: 28, borderRadius: "50%", background: playing && isSel ? "linear-gradient(135deg,#ff3366,#ff6644)" : "linear-gradient(135deg,#00f0ff,#0088aa)", border: "none", color: "#fff", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{playing && isSel ? "■" : "▶"}</button>
          <button onClick={e => { e.stopPropagation(); onExport(idx); }} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", color: "#ccc", fontSize: 9, padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace" }}>⬇</button>
        </div>
      </div>
      {isSel && <div style={{ display: "flex", gap: 4, marginTop: 4, paddingLeft: 36, flexWrap: "wrap" }}>
        <button onClick={e => { e.stopPropagation(); setEditNote(editNote === idx ? null : idx); }} style={{ ...bs(editNote === idx), padding: "2px 8px", fontSize: 8 }}>📝 {c.notes ? "Edit" : "Add"} Note</button>
        {clips.length >= 2 && <button onClick={e => { e.stopPropagation(); onAB(idx); }} style={{ ...bs(false), padding: "2px 8px", fontSize: 8 }}>⚡ A/B Compare</button>}
        {isModified && <button onClick={e => { e.stopPropagation(); onRevert(idx); }} style={{ ...bs(false), padding: "2px 8px", fontSize: 8, color: "#00f0ff" }}>↩ Revert</button>}
        {c.isManual && <button onClick={e => { e.stopPropagation(); onDel(idx); }} style={{ background: "rgba(255,51,102,0.05)", border: "1px solid rgba(255,51,102,0.1)", color: "#ff3366", padding: "2px 8px", borderRadius: 4, fontSize: 8, cursor: "pointer" }}>🗑 Delete</button>}
      </div>}
      {editNote === idx && <div style={{ marginTop: 6, paddingLeft: 36 }} onClick={e => e.stopPropagation()}>
        <input type="text" value={c.notes || ""} onChange={e => onNote(idx, e.target.value)} placeholder="e.g. 'Best for lip-sync'" autoFocus style={{ width: "100%", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 5, padding: "6px 9px", color: "#e8e8f0", fontSize: 10, outline: "none" }} onKeyDown={e => { if (e.key === "Enter") setEditNote(null); }} />
      </div>}
      {ab && isSel && <div style={{ marginTop: 5, paddingLeft: 36, display: "flex", gap: 3, flexWrap: "wrap" }}>
        <span style={{ fontSize: 8, color: "#555", fontFamily: "monospace" }}>Compare vs:</span>
        {clips.map((_, i) => i !== idx && <button key={i} onClick={e => { e.stopPropagation(); onAB(idx, i); }} style={{ ...bs(ab?.b === i), padding: "1px 6px", fontSize: 8 }}>#{i + 1}</button>)}
      </div>}
    </div>
  );
}

/* ═══ MAIN APP ═══ */
export default function App() {
  const [user, setUser] = useState(null), [userLoaded, setUserLoaded] = useState(false);
  const [songs, setSongs] = useState([]);
  const [page, setPage] = useState("home"), [activeSong, setActiveSong] = useState(null);
  const [analysis, setAnalysis] = useState(null), [energy, setEnergy] = useState([]);
  const actx = useRef(null), abuf = useRef(null), src = useRef(null), stT = useRef(0), af = useRef(null), scoreFn = useRef(null);
  const [clips, setClips] = useState([]), [sel, setSel] = useState(0);
  const [playing, setPlaying] = useState(false), [progress, setProgress] = useState(0);
  const [defDur, setDefDur] = useState(60), [zoom, setZoom] = useState(null);
  const [ab, setAb] = useState(null), [editNote, setEditNote] = useState(null);
  const [dl, setDl] = useState({}), [expIdx, setExpIdx] = useState(null);
  const [subs, setSubs] = useState([]), [consensus, setConsensus] = useState([]), [aiClips, setAiClips] = useState([]);
  const [showIndiv, setShowIndiv] = useState(true);
  const [analyzing, setAnalyzing] = useState(false), [submitted, setSubmitted] = useState(false);
  const [notice, setNotice] = useState(null);
  const [shareLink, setShareLink] = useState(""), [linkSongName, setLinkSongName] = useState("");
  const [audioLoading, setAudioLoading] = useState(false);
  const [playingFull, setPlayingFull] = useState(false), [fullProgress, setFullProgress] = useState(0);

  // Load user from localStorage & songs from Supabase
  useEffect(() => {
    const saved = localStorage.getItem("cc-user");
    if (saved) setUser(JSON.parse(saved));
    setUserLoaded(true);
    getSongs().then(setSongs).catch(console.error);
  }, []);

  const flash = msg => { setNotice(msg); setTimeout(() => setNotice(null), 2500); };
  const setupUser = (name, role) => { const u = { name: name.trim(), role }; setUser(u); localStorage.setItem("cc-user", JSON.stringify(u)); };
  const isLeader = user?.role === "leader";
  const hasAudio = energy.length > 0;
  const activeSongData = songs.find(s => s.id === activeSong);

  // Stream audio from Supabase storage
  const loadAudioFromUrl = async (url) => {
    setAudioLoading(true);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); actx.current = ctx;
      const resp = await fetch(url);
      const ab = await resp.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab); abuf.current = buf;
      const res = analyzeAudio(buf); setAnalysis(res); setEnergy(res.energy); scoreFn.current = res.scoreClip;
      return res;
    } catch (e) { console.error(e); flash("Error loading audio"); return null; }
    finally { setAudioLoading(false); }
  };

  const loadAudioFromFile = async (e) => {
    const f = e.target?.files?.[0] || e.dataTransfer?.files?.[0]; if (!f) return;
    setAudioLoading(true);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); actx.current = ctx;
      const buf = await ctx.decodeAudioData(await f.arrayBuffer()); abuf.current = buf;
      const res = analyzeAudio(buf); setAnalysis(res); setEnergy(res.energy); scoreFn.current = res.scoreClip;
      return { res, file: f };
    } catch (e2) { console.error(e2); flash("Error loading audio"); return null; }
    finally { setAudioLoading(false); }
  };

  // Leader: upload song (file → Supabase storage + analysis)
  const handleUpload = async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0] || e.target?.files?.[0]; if (!f) return;
    setAnalyzing(true);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); actx.current = ctx;
      const buf = await ctx.decodeAudioData(await f.arrayBuffer()); abuf.current = buf;
      const res = analyzeAudio(buf); setAnalysis(res); setEnergy(res.energy); scoreFn.current = res.scoreClip;
      // Create song in DB
      const song = await createSong({ name: f.name, duration: res.duration, bpm: res.bpm, shareLink: "" });
      // Upload audio to storage
      await uploadAudio(f, song.id);
      // Save AI clips
      await saveAiClips(song.id, res.topClips);
      // Refresh songs list
      const allSongs = await getSongs(); setSongs(allSongs);
      setActiveSong(song.id); setAiClips(res.topClips);
      setClips(res.topClips.map((c, i) => ({ ...c, id: `a${i}`, isManual: false, notes: "", dur: Math.round(c.endTime - c.startTime), origStart: c.startTime, origEnd: c.endTime })));
      setSel(0); setDl({}); setZoom(null); setPage("analyze");
    } catch (e2) { console.error(e2); flash("Error uploading — try again"); }
    setAnalyzing(false);
  };

  // Leader: create song from just a link
  const createSongFromLink = async () => {
    if (!shareLink.trim() || !linkSongName.trim()) return;
    await createSong({ name: linkSongName.trim(), duration: 0, bpm: 0, shareLink: shareLink.trim() });
    const allSongs = await getSongs(); setSongs(allSongs);
    setShareLink(""); setLinkSongName(""); flash("Song added!");
  };

  // Load audio for a song (streams from Supabase)
  const streamSongAudio = async (song) => {
    if (!song?.audio_path) return false;
    const url = getAudioUrl(song.audio_path);
    if (!url) return false;
    const res = await loadAudioFromUrl(url);
    return !!res;
  };

  // Clip ops
  const createClip = (st, et) => { const d = analysis?.duration || 300; let s = Math.max(0, st), e = et !== null ? Math.min(d, et) : Math.min(d, s + defDur); if (e - s < 2) e = Math.min(d, s + defDur); const sc = scoreFn.current ? scoreFn.current(s, e) : {}; setClips(p => [...p, { ...sc, startTime: s, endTime: e, id: `m${Date.now()}`, isManual: true, notes: "", dur: Math.round(e - s) }]); setSel(clips.length); };
  const dragEdge = (idx, edge, t) => { setClips(p => { const u = [...p], c = { ...u[idx] }; if (edge === "start") c.startTime = Math.min(t, c.endTime - 1); else c.endTime = Math.max(t, c.startTime + 1); c.dur = Math.round(c.endTime - c.startTime); if (scoreFn.current) Object.assign(c, scoreFn.current(c.startTime, c.endTime)); u[idx] = c; return u; }); };
  const moveClip = (idx, ns, ne) => { setClips(p => { const u = [...p], c = { ...u[idx] }; c.startTime = ns; c.endTime = ne; c.dur = Math.round(ne - ns); if (scoreFn.current) Object.assign(c, scoreFn.current(ns, ne)); u[idx] = c; return u; }); };
  const setClipDur = (idx, nd) => { setClips(p => { const u = [...p], c = { ...u[idx] }, d = analysis?.duration || 300; c.endTime = Math.min(d, c.startTime + nd); c.dur = Math.round(c.endTime - c.startTime); if (scoreFn.current) Object.assign(c, scoreFn.current(c.startTime, c.endTime)); u[idx] = c; return u; }); };
  const updateNote = (idx, n) => setClips(p => { const u = [...p]; u[idx] = { ...u[idx], notes: n }; return u; });
  const delClip = idx => { setClips(p => p.filter((_, i) => i !== idx)); if (sel >= idx && sel > 0) setSel(sel - 1); };
  const revertClip = idx => { setClips(p => { const u = [...p], c = { ...u[idx] }; if (c.origStart == null) return p; c.startTime = c.origStart; c.endTime = c.origEnd; c.dur = Math.round(c.endTime - c.startTime); if (scoreFn.current) Object.assign(c, scoreFn.current(c.startTime, c.endTime)); u[idx] = c; return u; }); };
  const isModified = c => !c.isManual && c.origStart != null && (Math.abs(c.startTime - c.origStart) > 0.5 || Math.abs(c.endTime - c.origEnd) > 0.5);

  // Playback
  const stopPlay = () => { if (src.current) try { src.current.stop(); } catch (e) { } src.current = null; cancelAnimationFrame(af.current); setPlaying(false); setProgress(0); setPlayingFull(false); setFullProgress(0); };
  const playClip = idx => {
    const cl = clips[idx]; if (!actx.current || !abuf.current || !cl) return;
    if (playing) { const wasSame = sel === idx; stopPlay(); if (wasSame) return; }
    const s = actx.current.createBufferSource(); s.buffer = abuf.current; s.connect(actx.current.destination);
    s.start(0, cl.startTime, cl.endTime - cl.startTime); src.current = s; stT.current = actx.current.currentTime;
    setPlaying(true); setSel(idx); const dur = cl.endTime - cl.startTime;
    const tick = () => { const el = actx.current.currentTime - stT.current; setProgress(Math.min(1, el / dur)); if (el < dur) af.current = requestAnimationFrame(tick); else { setPlaying(false); setProgress(0); } };
    af.current = requestAnimationFrame(tick); s.onended = () => { setPlaying(false); setProgress(0); cancelAnimationFrame(af.current); };
  };
  const playRange = (st, et) => { if (!actx.current || !abuf.current) return; stopPlay(); const s = actx.current.createBufferSource(); s.buffer = abuf.current; s.connect(actx.current.destination); s.start(0, st, et - st); src.current = s; setPlaying(true); s.onended = () => setPlaying(false); };

  const playFull = (startFrom = 0) => {
    if (!actx.current || !abuf.current) return;
    if (playingFull) { stopPlay(); setPlayingFull(false); setFullProgress(0); return; }
    stopPlay();
    const dur = abuf.current.duration;
    const s = actx.current.createBufferSource(); s.buffer = abuf.current; s.connect(actx.current.destination);
    s.start(0, startFrom, dur - startFrom); src.current = s; stT.current = actx.current.currentTime - startFrom;
    setPlaying(true); setPlayingFull(true);
    const tick = () => { const el = actx.current.currentTime - stT.current; const p = Math.min(1, el / dur); setFullProgress(p); if (el < dur) af.current = requestAnimationFrame(tick); else { setPlaying(false); setPlayingFull(false); setFullProgress(0); } };
    af.current = requestAnimationFrame(tick);
    s.onended = () => { setPlaying(false); setPlayingFull(false); setFullProgress(0); cancelAnimationFrame(af.current); };
  };

  // Export
  const expClip = async idx => { setExpIdx(idx); const cl = clips[idx]; if (!abuf.current || !cl) { setExpIdx(null); return; } const sr = abuf.current.sampleRate, ns = Math.floor((cl.endTime - cl.startTime) * sr); const oc = new OfflineAudioContext(abuf.current.numberOfChannels, ns, sr); const s = oc.createBufferSource(); s.buffer = abuf.current; s.connect(oc.destination); s.start(0, cl.startTime, cl.endTime - cl.startTime); const r = await oc.startRendering(); const blob = encodeWav(r); const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = `${(activeSongData?.name || "clip").replace(/\.[^.]+$/, "")}_clip${idx + 1}_${fmt(cl.startTime)}-${fmt(cl.endTime)}.wav`; a.click(); URL.revokeObjectURL(url); setDl(p => ({ ...p, [idx]: true })); setExpIdx(null); };
  const expAll = async () => { for (let i = 0; i < clips.length; i++) { await expClip(i); await new Promise(r => setTimeout(r, 400)); } };
  const expRange = async (st, et, label) => { if (!abuf.current) return; const sr = abuf.current.sampleRate, ns = Math.floor((et - st) * sr); const oc = new OfflineAudioContext(abuf.current.numberOfChannels, ns, sr); const s = oc.createBufferSource(); s.buffer = abuf.current; s.connect(oc.destination); s.start(0, st, et - st); const r = await oc.startRendering(); const blob = encodeWav(r); const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = `${(activeSongData?.name || "clip").replace(/\.[^.]+$/, "")}_${label}.wav`; a.click(); URL.revokeObjectURL(url); };

  // Team
  const submitMyPicks = async () => { if (!activeSong || clips.length < 2) return; await dbSubmitPicks(activeSong, user.name, clips.map(c => ({ startTime: c.startTime, endTime: c.endTime, notes: c.notes || "", dur: c.dur }))); setSubmitted(true); flash("Picks submitted!"); };
  const retractClip = async (idx) => { const newClips = clips.filter((_, i) => i !== idx); setClips(newClips); if (sel >= idx && sel > 0) setSel(sel - 1); if (submitted && activeSong) { if (newClips.length > 0) { await dbSubmitPicks(activeSong, user.name, newClips.map(c => ({ startTime: c.startTime, endTime: c.endTime, notes: c.notes || "", dur: c.dur }))); flash("Clip retracted — submission updated"); } else { await dbSubmitPicks(activeSong, user.name, []); setSubmitted(false); flash("All clips retracted"); } } };

  const loadReview = async songId => {
    const song = songs.find(s => s.id === songId);
    const sameSong = songId === activeSong;
    setActiveSong(songId);
    const s = await getSubmissions(songId);
    const ai = await getAiClips(songId);
    setSubs(s); setAiClips(ai); setConsensus(buildConsensus(s)); setPage("review");
    if (!sameSong) {
      setEnergy([]); abuf.current = null; actx.current = null;
      setAnalysis(song ? { duration: song.duration, bpm: song.bpm } : null);
      // Auto-stream audio if available
      if (song?.audio_path) streamSongAudio(song);
    }
    setClips(ai.map((c, i) => ({ ...c, id: `a${i}`, isManual: false, notes: "", dur: Math.round(c.endTime - c.startTime), origStart: c.startTime, origEnd: c.endTime })));
    setSel(0); setDl({}); setZoom(null);
  };

  const loadSubmit = async songId => {
    const song = songs.find(s => s.id === songId);
    setActiveSong(songId); setClips([]); setSel(0); setZoom(null); setSubmitted(false); setEnergy([]); setAnalysis(null); setPage("submit");
    // Auto-stream audio if available
    if (song?.audio_path) {
      const url = getAudioUrl(song.audio_path);
      if (url) loadAudioFromUrl(url);
    }
  };

  const refreshSubs = async () => { if (!activeSong) return; const s = await getSubmissions(activeSong); setSubs(s); setConsensus(buildConsensus(s)); flash("Refreshed!"); };
  const delSong = async id => { await dbDeleteSong(id); const allSongs = await getSongs(); setSongs(allSongs); };

  // Realtime subscription
  useEffect(() => {
    if (page === "review" && activeSong) {
      const unsub = subscribeToSubmissions(activeSong, refreshSubs);
      return unsub;
    }
  }, [page, activeSong]);

  const bs = active => ({ background: active ? "rgba(0,240,255,0.1)" : "rgba(255,255,255,0.03)", border: `1px solid ${active ? "rgba(0,240,255,0.25)" : "rgba(255,255,255,0.07)"}`, color: active ? "#00f0ff" : "#7a7a8e", padding: "5px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontFamily: "monospace", transition: "all 0.2s" });
  const cs = active => ({ background: active ? "rgba(0,240,255,0.035)" : "rgba(255,255,255,0.012)", border: `1px solid ${active ? "rgba(0,240,255,0.15)" : "rgba(255,255,255,0.04)"}`, borderRadius: 9, padding: "12px 14px", cursor: "pointer", transition: "all 0.2s" });
  const selC = clips[sel];
  const playheadTime = playingFull && analysis?.duration ? fullProgress * analysis.duration : null;
  const startAB = (idx, other) => setAb({ a: idx, b: other !== undefined ? other : (idx === 0 ? 1 : 0) });

  if (!userLoaded) return <div style={{ minHeight: "100vh", background: "#08080d", display: "flex", alignItems: "center", justifyContent: "center", color: "#555" }}>Loading...</div>;
  if (!user) return <div style={{ minHeight: "100vh", background: "#08080d", color: "#e8e8f0", fontFamily: "'Segoe UI',system-ui,sans-serif", display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ maxWidth: 400, width: "100%", padding: 24 }}><div style={{ textAlign: "center", marginBottom: 32 }}><div style={{ fontSize: 36, marginBottom: 12 }}>🎵</div><h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6, background: "linear-gradient(135deg,#e8e8f0 30%,#00f0ff 70%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Clip Cutter</h1><p style={{ color: "#7a7a8e", fontSize: 13 }}>Team Collaboration</p></div><SetupForm onSetup={setupUser} /></div></div>;

  return (
    <div style={{ minHeight: "100vh", background: "#08080d", color: "#e8e8f0", fontFamily: "'Segoe UI',system-ui,sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.015)", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 15 }}>🎵</span><span style={{ fontWeight: 700, fontSize: 13 }}>Clip Cutter</span><span style={{ fontFamily: "monospace", fontSize: 8, color: isLeader ? "#ff3366" : "#00f0ff", letterSpacing: 2, background: isLeader ? "rgba(255,51,102,0.1)" : "rgba(0,240,255,0.1)", padding: "2px 6px", borderRadius: 3 }}>{user.role.toUpperCase()}</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 11, color: "#7a7a8e" }}>{user.name}</span><button onClick={() => setPage("home")} style={bs(page === "home")}>Home</button><button onClick={() => { setUser(null); localStorage.removeItem("cc-user"); }} style={{ ...bs(false), fontSize: 9, padding: "3px 8px" }}>Logout</button></div>
      </div>
      {notice && <div style={{ position: "fixed", top: 50, left: "50%", transform: "translateX(-50%)", background: "rgba(68,255,136,0.15)", border: "1px solid rgba(68,255,136,0.3)", color: "#44ff88", padding: "8px 20px", borderRadius: 8, fontSize: 12, fontFamily: "monospace", zIndex: 100 }}>{notice}</div>}
      {audioLoading && <div style={{ position: "fixed", top: 50, left: "50%", transform: "translateX(-50%)", background: "rgba(0,240,255,0.1)", border: "1px solid rgba(0,240,255,0.2)", color: "#00f0ff", padding: "8px 20px", borderRadius: 8, fontSize: 12, fontFamily: "monospace", zIndex: 100 }}>Loading audio...</div>}

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 16px 80px" }}>

        {/* HOME */}
        {page === "home" && <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{isLeader ? "Your Songs" : "Assigned Songs"}</h2>
          {isLeader && <div style={{ marginBottom: 20 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 12, alignItems: "center" }}>
              <div onDrop={handleUpload} onDragOver={e => e.preventDefault()} onClick={() => document.getElementById("fi2").click()} style={{ border: "2px dashed rgba(0,240,255,0.15)", borderRadius: 12, padding: "20px 16px", textAlign: "center", cursor: "pointer", background: "rgba(0,240,255,0.01)", minHeight: 100, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>Upload audio</div>
                <div style={{ fontSize: 10, color: "#7a7a8e" }}>Drop file or click</div>
                <input id="fi2" type="file" accept="audio/*" onChange={handleUpload} style={{ display: "none" }} />
              </div>
              <div style={{ fontSize: 11, color: "#555", fontFamily: "monospace" }}>or</div>
              <div style={{ border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "12px 14px", background: "rgba(255,255,255,0.015)" }}>
                <input type="text" value={linkSongName} onChange={e => setLinkSongName(e.target.value)} placeholder="Song name" style={{ width: "100%", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, padding: "6px 10px", color: "#e8e8f0", fontSize: 11, outline: "none", marginBottom: 6, boxSizing: "border-box" }} />
                <input type="text" value={shareLink} onChange={e => setShareLink(e.target.value)} placeholder="Dropbox / Drive link" style={{ width: "100%", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, padding: "6px 10px", color: "#e8e8f0", fontSize: 11, outline: "none", marginBottom: 6, boxSizing: "border-box" }} />
                <button onClick={createSongFromLink} disabled={!shareLink.trim() || !linkSongName.trim()} style={{ ...bs(shareLink.trim() && linkSongName.trim()), width: "100%", padding: "6px", fontSize: 10 }}>Add Song</button>
              </div>
            </div>
          </div>}
          {analyzing && <div style={{ textAlign: "center", padding: 30 }}><div style={{ width: 36, height: 36, border: "3px solid rgba(0,240,255,0.12)", borderTop: "3px solid #00f0ff", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} /><div style={{ fontSize: 12, color: "#7a7a8e" }}>Analyzing & uploading...</div></div>}
          {songs.length === 0 && !analyzing && <div style={{ textAlign: "center", padding: 40, border: "1px dashed rgba(255,255,255,0.06)", borderRadius: 12 }}><div style={{ fontSize: 28, opacity: 0.3, marginBottom: 8 }}>📂</div><div style={{ color: "#555", fontSize: 12 }}>{isLeader ? "Upload a song to get started" : "No songs assigned yet"}</div></div>}
          <div style={{ display: "grid", gap: 8 }}>{songs.map(song => <div key={song.id} style={{ ...cs(false), display: "flex", alignItems: "center", gap: 12 }} onClick={() => isLeader ? loadReview(song.id) : loadSubmit(song.id)}>
            <div style={{ width: 38, height: 38, borderRadius: 8, background: "linear-gradient(135deg,rgba(0,240,255,0.1),rgba(179,102,255,0.1))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>🎵</div>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.name}</div><div style={{ fontSize: 10, color: "#7a7a8e", fontFamily: "monospace" }}>{song.duration > 0 ? `${fmt(song.duration)} · ~${song.bpm} BPM` : song.share_link ? "📎 shared link" : "pending"}</div></div>
            {isLeader && <button onClick={ev => { ev.stopPropagation(); delSong(song.id); }} style={{ background: "rgba(255,51,102,0.05)", border: "1px solid rgba(255,51,102,0.1)", color: "#ff3366", fontSize: 8, padding: "3px 7px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace" }}>Delete</button>}
            <div style={{ fontSize: 10, color: "#00f0ff", fontFamily: "monospace" }}>{isLeader ? "Review →" : "Submit →"}</div>
          </div>)}</div>
        </div>}

        {/* LEADER: ANALYZE */}
        {page === "analyze" && isLeader && <div>
          <button onClick={() => setPage("home")} style={{ ...bs(false), marginBottom: 12, fontSize: 9 }}>← Back</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "9px 12px", background: "rgba(255,255,255,0.025)", borderRadius: 8, marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 11 }}>{activeSongData?.name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#7a7a8e" }}>{analysis && `${fmt(analysis.duration)} · ~${analysis.bpm} BPM`} · {clips.length} clips</div>
            <div style={{ marginLeft: "auto" }}><button onClick={() => loadReview(activeSong)} style={bs(true)}>Team Review →</button></div>
          </div>
          <div style={{ background: "rgba(0,240,255,0.02)", border: "1px solid rgba(0,240,255,0.06)", borderRadius: 7, padding: "7px 11px", marginBottom: 12, fontSize: 10, color: "#00f0ff" }}>🔒 AI analysis is private — your team won't see these</div>
          {hasAudio && <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, flexWrap: "wrap", gap: 6 }}>
              <div style={{ fontSize: 8, fontFamily: "monospace", color: "#555", letterSpacing: 1 }}>CLICK = SELECT & DRAG · DOUBLE-CLICK = NEW · DRAG EDGES = RESIZE · SCROLL = ZOOM</div>
              <div style={{ display: "flex", gap: 3 }}><span style={{ fontSize: 8, fontFamily: "monospace", color: "#555" }}>Default:</span>{[15, 30, 60].map(d => <button key={d} onClick={() => setDefDur(d)} style={{ ...bs(defDur === d), padding: "2px 7px", fontSize: 9 }}>{d}s</button>)}</div>
            </div>
            <Waveform energy={energy} duration={analysis.duration} clips={clips} highlights={[]} selClip={sel} onSel={setSel} onCreate={createClip} onEdge={dragEdge} onMove={moveClip} zoom={zoom || [0, analysis.duration]} onZoom={setZoom} readonly={false} onPlayFrom={t => playFull(t)} playheadTime={playheadTime} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 4 }}>
              <button onClick={() => playFull(0)} style={{ width: 32, height: 32, borderRadius: "50%", background: playingFull ? "linear-gradient(135deg,#ff3366,#ff6644)" : "linear-gradient(135deg,#00f0ff,#0088aa)", border: "none", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{playingFull ? "■" : "▶"}</button>
              <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}><div style={{ width: `${fullProgress * 100}%`, height: "100%", background: "linear-gradient(90deg,#00f0ff,#b366ff)", transition: "width 0.1s linear" }} /></div>
              <span style={{ fontSize: 10, fontFamily: "monospace", color: "#7a7a8e" }}>{playheadTime != null ? fmt(playheadTime) : "0:00"} / {fmt(analysis.duration)}</span>
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 2 }}><button onClick={() => setZoom(null)} style={{ ...bs(!zoom), padding: "2px 8px", fontSize: 8 }}>Full Track</button>{selC && <button onClick={() => setZoom([Math.max(0, selC.startTime - 3), Math.min(analysis.duration, selC.endTime + 3)])} style={{ ...bs(false), padding: "2px 8px", fontSize: 8 }}>Zoom Selected</button>}</div>
          </div>}
          {ab && <div style={{ background: "rgba(179,102,255,0.05)", border: "1px solid rgba(179,102,255,0.15)", borderRadius: 7, padding: "8px 12px", marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><span style={{ fontSize: 10, color: "#b366ff", fontWeight: 600, fontFamily: "monospace" }}>A/B</span><button onClick={() => playClip(ab.a)} style={{ ...bs(playing && sel === ab.a), padding: "4px 12px" }}>▶ A ({fmt(clips[ab.a]?.startTime)})</button><span style={{ color: "#444", fontSize: 10 }}>vs</span><button onClick={() => playClip(ab.b)} style={{ ...bs(playing && sel === ab.b), padding: "4px 12px" }}>▶ B ({fmt(clips[ab.b]?.startTime)})</button><button onClick={() => { stopPlay(); setAb(null); }} style={{ marginLeft: "auto", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#7a7a8e", fontSize: 9, padding: "3px 8px", borderRadius: 4, cursor: "pointer" }}>✕</button></div>}
          {clips.length > 0 && <div style={{ display: "flex", gap: 5, marginBottom: 12, alignItems: "center" }}><button onClick={expAll} style={{ background: "linear-gradient(135deg,rgba(0,240,255,0.1),rgba(179,102,255,0.06))", border: "1px solid rgba(0,240,255,0.18)", color: "#00f0ff", fontSize: 10, fontWeight: 600, padding: "7px 14px", borderRadius: 6, cursor: "pointer", fontFamily: "monospace" }}>⬇ Download All {clips.length}</button>{Object.keys(dl).length > 0 && <span style={{ fontSize: 9, color: "#44ff88", fontFamily: "monospace" }}>✓ {Object.keys(dl).length}/{clips.length}</span>}</div>}
          <div style={{ display: "grid", gap: 7, marginBottom: 20 }}>{clips.map((c, idx) => <ClipCard key={c.id || idx} c={c} idx={idx} sel={sel} playing={playing} isModified={isModified(c)} bs={bs} onSel={setSel} onPlay={playClip} onExport={expClip} onDur={setClipDur} onNote={updateNote} onAB={startAB} onRevert={revertClip} onDel={delClip} editNote={editNote} setEditNote={setEditNote} ab={ab} clips={clips} />)}</div>
        </div>}

        {/* LEADER: REVIEW */}
        {page === "review" && isLeader && <div>
          <button onClick={() => setPage("home")} style={{ ...bs(false), marginBottom: 12, fontSize: 9 }}>← Back</button>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
            <div><h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 2 }}>Team Review — {activeSongData?.name}</h2><p style={{ color: "#7a7a8e", fontSize: 11, margin: 0 }}>{subs.length} submission{subs.length !== 1 ? "s" : ""} · updates live</p></div>
            <button onClick={refreshSubs} style={bs(false)}>↻ Refresh</button>
          </div>
          {consensus.length > 0 && <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, fontFamily: "monospace", color: "#44ff88", letterSpacing: 2, marginBottom: 8 }}>CONSENSUS CLIPS</div>
            <div style={{ display: "grid", gap: 8 }}>{consensus.map((c, idx) => <div key={idx} style={{ ...cs(false), borderColor: c.agreement >= 0.7 ? "rgba(68,255,136,0.2)" : c.agreement >= 0.4 ? "rgba(255,215,0,0.15)" : "rgba(255,255,255,0.04)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: c.agreement >= 0.7 ? "#44ff88" : c.agreement >= 0.4 ? "#ffd700" : "#7a7a8e" }}>C{idx + 1}</div>
                <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{fmt(c.startTime)} → {fmt(c.endTime)} <span style={{ color: "#7a7a8e", fontWeight: 400 }}>({c.dur}s)</span></div><div style={{ fontSize: 10, color: "#7a7a8e", marginTop: 2 }}>Picked by: {c.members.join(", ")}</div></div>
                <div style={{ minWidth: 100 }}><AgreementBar count={c.memberCount} total={c.total} /></div>
                {hasAudio && <button onClick={() => playRange(c.startTime, c.endTime)} style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg,#44ff88,#228844)", border: "none", color: "#fff", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>▶</button>}
                {hasAudio && <button onClick={() => expRange(c.startTime, c.endTime, `consensus${idx + 1}`)} style={{ ...bs(false), padding: "3px 8px", fontSize: 9 }}>⬇</button>}
              </div>
              <div style={{ paddingLeft: 26, fontSize: 10, color: "#555" }}>{c.picks.map((p, i) => <span key={i} style={{ marginRight: 10 }}>{p.member}: {fmt(p.startTime)}–{fmt(p.endTime)}</span>)}</div>
            </div>)}</div>
          </div>}
          {hasAudio && <div style={{ marginBottom: 20 }}>
            <Waveform energy={energy} duration={analysis.duration} clips={clips} highlights={[...consensus.map((c, i) => ({ startTime: c.startTime, endTime: c.endTime, color: c.agreement >= 0.7 ? "rgba(68,255,136,0.1)" : "rgba(255,215,0,0.06)", label: `C${i + 1} (${c.memberCount}/${c.total})`, lc: c.agreement >= 0.7 ? "rgba(68,255,136,0.5)" : "rgba(255,215,0,0.4)" })), ...(showIndiv ? subs.flatMap(s => (s.clips || []).map(c => ({ startTime: c.startTime, endTime: c.endTime, color: "rgba(179,102,255,0.04)", label: "" }))) : [])]} selClip={sel} onSel={setSel} onCreate={createClip} onEdge={dragEdge} onMove={moveClip} zoom={zoom || [0, analysis.duration]} onZoom={setZoom} readonly={false} onPlayFrom={t => playFull(t)} playheadTime={playheadTime} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 4 }}>
              <button onClick={() => playFull(0)} style={{ width: 32, height: 32, borderRadius: "50%", background: playingFull ? "linear-gradient(135deg,#ff3366,#ff6644)" : "linear-gradient(135deg,#00f0ff,#0088aa)", border: "none", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{playingFull ? "■" : "▶"}</button>
              <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}><div style={{ width: `${fullProgress * 100}%`, height: "100%", background: "linear-gradient(90deg,#00f0ff,#b366ff)", transition: "width 0.1s linear" }} /></div>
              <span style={{ fontSize: 10, fontFamily: "monospace", color: "#7a7a8e" }}>{playheadTime != null ? fmt(playheadTime) : "0:00"} / {fmt(analysis.duration)}</span>
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 2 }}><button onClick={() => setZoom(null)} style={{ ...bs(!zoom), padding: "2px 8px", fontSize: 8 }}>Full</button><button onClick={() => setShowIndiv(!showIndiv)} style={{ ...bs(showIndiv), padding: "2px 8px", fontSize: 8 }}>{showIndiv ? "Hide" : "Show"} Individual</button></div>
          </div>}
          {clips.length > 0 && <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", gap: 5, marginBottom: 8, alignItems: "center" }}><div style={{ fontSize: 10, fontFamily: "monospace", color: "#00f0ff", letterSpacing: 2 }}>YOUR CLIPS (AI + CUSTOM)</div>{hasAudio && <div style={{ marginLeft: "auto" }}><button onClick={expAll} style={{ ...bs(true), padding: "4px 12px", fontSize: 9 }}>⬇ Download All</button></div>}</div>
            <div style={{ display: "grid", gap: 7 }}>{clips.map((c, idx) => <ClipCard key={c.id || idx} c={c} idx={idx} sel={sel} playing={playing} isModified={isModified(c)} bs={bs} onSel={setSel} onPlay={playClip} onExport={expClip} onDur={setClipDur} onNote={updateNote} onAB={startAB} onRevert={revertClip} onDel={delClip} editNote={editNote} setEditNote={setEditNote} ab={ab} clips={clips} />)}</div>
          </div>}
          <div style={{ fontSize: 10, fontFamily: "monospace", color: "#b366ff", letterSpacing: 2, marginBottom: 8 }}>INDIVIDUAL SUBMISSIONS</div>
          {subs.length === 0 && <div style={{ color: "#555", fontSize: 12, padding: 20, textAlign: "center", border: "1px dashed rgba(255,255,255,0.06)", borderRadius: 8 }}>Waiting for team picks...</div>}
          <div style={{ display: "grid", gap: 8 }}>{subs.map((sub, si) => <div key={si} style={{ ...cs(false) }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}><div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg,rgba(179,102,255,0.2),rgba(0,240,255,0.1))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#b366ff" }}>{sub.member.charAt(0).toUpperCase()}</div><div style={{ fontWeight: 600, fontSize: 12 }}>{sub.member}</div><div style={{ fontSize: 9, color: "#555", fontFamily: "monospace", marginLeft: "auto" }}>{sub.clips.length} clips</div></div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingLeft: 36 }}>{(sub.clips || []).map((c, ci) => <div key={ci} onClick={() => hasAudio && playRange(c.startTime, c.endTime)} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, padding: "4px 10px", fontSize: 10, fontFamily: "monospace", color: "#aaa", cursor: hasAudio ? "pointer" : "default" }}>{hasAudio && <span style={{ marginRight: 4 }}>▶</span>}{fmt(c.startTime)}–{fmt(c.endTime)} ({c.dur}s)</div>)}</div>
          </div>)}</div>
        </div>}

        {/* MEMBER: SUBMIT */}
        {page === "submit" && !isLeader && <div>
          <button onClick={() => setPage("home")} style={{ ...bs(false), marginBottom: 12, fontSize: 9 }}>← Back</button>
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{activeSongData?.name}</h2>
          <p style={{ color: "#7a7a8e", fontSize: 11, marginBottom: 16 }}>Pick 3-5 clips you think would go viral on TikTok</p>
          {!hasAudio && !audioLoading && <div style={{ marginBottom: 16 }}>
            {activeSongData?.share_link && <a href={activeSongData.share_link} target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(0,240,255,0.04)", border: "1px solid rgba(0,240,255,0.15)", borderRadius: 10, padding: "14px 16px", marginBottom: 12, textDecoration: "none", color: "#00f0ff", fontSize: 12, fontWeight: 600 }}><span style={{ fontSize: 18 }}>📁</span><div style={{ flex: 1 }}><div>Download song file</div><div style={{ fontSize: 9, color: "#7a7a8e", fontWeight: 400, marginTop: 2, wordBreak: "break-all" }}>{activeSongData.share_link}</div></div><span>↗</span></a>}
            {!activeSongData?.audio_path && <div onDrop={e => { e.preventDefault(); loadAudioFromFile(e); }} onDragOver={e => e.preventDefault()} onClick={() => document.getElementById("fi3").click()} style={{ border: "2px dashed rgba(0,240,255,0.15)", borderRadius: 10, padding: "20px 16px", textAlign: "center", cursor: "pointer", background: "rgba(0,240,255,0.01)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>Drop or select the audio file</div>
              <div style={{ fontSize: 10, color: "#7a7a8e" }}>MP3, WAV, M4A, AAC, OGG, FLAC</div>
              <input id="fi3" type="file" accept="audio/*" onChange={loadAudioFromFile} style={{ display: "none" }} />
            </div>}
          </div>}
          {audioLoading && <div style={{ textAlign: "center", padding: 30 }}><div style={{ width: 36, height: 36, border: "3px solid rgba(0,240,255,0.12)", borderTop: "3px solid #00f0ff", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} /><div style={{ fontSize: 12, color: "#7a7a8e" }}>Loading song...</div></div>}
          {hasAudio && <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, flexWrap: "wrap", gap: 4 }}>
              <div style={{ fontSize: 8, fontFamily: "monospace", color: "#555", letterSpacing: 1 }}>DOUBLE-CLICK = NEW CLIP · DRAG EDGES = RESIZE · DRAG CLIP = MOVE · SCROLL = ZOOM</div>
              <div style={{ display: "flex", gap: 2 }}>{[15, 30, 60].map(d => <button key={d} onClick={() => setDefDur(d)} style={{ ...bs(defDur === d), padding: "2px 7px", fontSize: 9 }}>{d}s</button>)}</div>
            </div>
            <Waveform energy={energy} duration={analysis.duration} clips={clips} highlights={[]} selClip={sel} onSel={setSel} onCreate={createClip} onEdge={dragEdge} onMove={moveClip} zoom={zoom || [0, analysis.duration]} onZoom={setZoom} readonly={false} onPlayFrom={t => playFull(t)} playheadTime={playheadTime} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 4 }}>
              <button onClick={() => playFull(0)} style={{ width: 32, height: 32, borderRadius: "50%", background: playingFull ? "linear-gradient(135deg,#ff3366,#ff6644)" : "linear-gradient(135deg,#00f0ff,#0088aa)", border: "none", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{playingFull ? "■" : "▶"}</button>
              <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}><div style={{ width: `${fullProgress * 100}%`, height: "100%", background: "linear-gradient(90deg,#00f0ff,#b366ff)", transition: "width 0.1s linear" }} /></div>
              <span style={{ fontSize: 10, fontFamily: "monospace", color: "#7a7a8e" }}>{playheadTime != null ? fmt(playheadTime) : "0:00"} / {fmt(analysis.duration)}</span>
            </div>
            <div style={{ fontSize: 9, fontFamily: "monospace", color: "#555", margin: "8px 0 6px", letterSpacing: 1 }}>YOUR PICKS ({clips.length}/5)</div>
            {clips.length === 0 && <div style={{ textAlign: "center", padding: 20, border: "1px dashed rgba(255,255,255,0.06)", borderRadius: 8, marginBottom: 12 }}><div style={{ fontSize: 10, color: "#7a7a8e" }}>Double-click the waveform to create a clip</div></div>}
            <div style={{ display: "grid", gap: 6, marginBottom: 16 }}>{clips.map((c, idx) => <div key={c.id} onClick={() => setSel(idx)} style={{ ...cs(idx === sel), display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#ffd700", minWidth: 24 }}>✎</div>
              <div style={{ flex: 1, fontSize: 11 }}>{fmt(c.startTime)} → {fmt(c.endTime)} <span style={{ color: "#7a7a8e" }}>({c.dur}s)</span></div>
              <div style={{ display: "flex", gap: 2 }}>{[15, 30, 60].map(d => <button key={d} onClick={e => { e.stopPropagation(); setClipDur(idx, d); }} style={{ ...bs(c.dur === d), padding: "2px 5px", fontSize: 8 }}>{d}s</button>)}</div>
              <input type="text" placeholder="Note..." value={c.notes || ""} onChange={e => { e.stopPropagation(); updateNote(idx, e.target.value); }} onClick={e => e.stopPropagation()} style={{ width: 100, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 4, padding: "3px 6px", color: "#ccc", fontSize: 9, outline: "none" }} />
              <button onClick={e => { e.stopPropagation(); playClip(idx); }} style={{ width: 26, height: 26, borderRadius: "50%", background: playing && sel === idx ? "linear-gradient(135deg,#ff3366,#ff6644)" : "linear-gradient(135deg,#00f0ff,#0088aa)", border: "none", color: "#fff", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{playing && sel === idx ? "■" : "▶"}</button>
              {submitted ? <button onClick={e => { e.stopPropagation(); retractClip(idx); }} style={{ background: "rgba(255,136,68,0.08)", border: "1px solid rgba(255,136,68,0.2)", color: "#ff8844", fontSize: 8, padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace" }}>Retract</button> : <button onClick={e => { e.stopPropagation(); delClip(idx); }} style={{ background: "rgba(255,51,102,0.05)", border: "1px solid rgba(255,51,102,0.1)", color: "#ff3366", fontSize: 8, padding: "3px 6px", borderRadius: 4, cursor: "pointer" }}>✕</button>}
            </div>)}</div>
            {submitted && <div style={{ background: "rgba(68,255,136,0.08)", border: "1px solid rgba(68,255,136,0.2)", borderRadius: 8, padding: "10px 14px", textAlign: "center", color: "#44ff88", fontSize: 13, fontWeight: 600, marginBottom: 8 }}>✓ Submitted! Retract individual clips above or add more below.</div>}
            {clips.length < 2 && !submitted && <div style={{ fontSize: 10, color: "#ff8844", fontFamily: "monospace", textAlign: "center", marginBottom: 6 }}>Add at least 2 clips to submit</div>}
            <button onClick={submitMyPicks} disabled={clips.length < 2} style={{ ...bs(clips.length >= 2), padding: "10px 24px", fontSize: 13, fontWeight: 600, opacity: clips.length < 2 ? 0.3 : 1, width: "100%", cursor: clips.length < 2 ? "not-allowed" : "pointer" }}>{submitted ? "Update Submission" : `Submit ${clips.length} Pick${clips.length !== 1 ? "s" : ""}`}</button>
          </div>}
        </div>}
      </div>

      {playing && <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: 3, zIndex: 100, background: "rgba(0,240,255,0.08)" }}><div style={{ height: "100%", width: `${progress * 100}%`, background: "linear-gradient(90deg,#00f0ff,#b366ff)", transition: "width 0.1s linear" }} /></div>}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}*{box-sizing:border-box}button:hover{filter:brightness(1.12)}input:focus{border-color:rgba(0,240,255,0.25)!important}`}</style>
    </div>
  );
}

function SetupForm({ onSetup }) {
  const [name, setName] = useState(""), [role, setRole] = useState(null);
  return <div>
    <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name (e.g. Dylan)" autoFocus style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "12px 14px", color: "#e8e8f0", fontSize: 14, outline: "none", marginBottom: 16 }} />
    <div style={{ fontSize: 11, color: "#7a7a8e", marginBottom: 8, fontFamily: "monospace" }}>I am a:</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
      {[["leader", "👑", "Team Lead", "#ff3366", "Upload, analyze, review picks"], ["member", "🎧", "Team Member", "#00f0ff", "Listen & submit clip picks"]].map(([r, icon, title, color, desc]) =>
        <div key={r} onClick={() => setRole(r)} style={{ background: role === r ? `rgba(${color === "#ff3366" ? "255,51,102" : "0,240,255"},0.1)` : "rgba(255,255,255,0.02)", border: `2px solid ${role === r ? `rgba(${color === "#ff3366" ? "255,51,102" : "0,240,255"},0.4)` : "rgba(255,255,255,0.06)"}`, borderRadius: 12, padding: 16, cursor: "pointer", textAlign: "center" }}>
          <div style={{ fontSize: 24, marginBottom: 6 }}>{icon}</div>
          <div style={{ fontWeight: 700, fontSize: 13, color: role === r ? color : "#ccc" }}>{title}</div>
          <div style={{ fontSize: 10, color: "#7a7a8e", marginTop: 4 }}>{desc}</div>
        </div>
      )}
    </div>
    <button onClick={() => name.trim() && role && onSetup(name, role)} disabled={!name.trim() || !role} style={{ width: "100%", padding: "12px", borderRadius: 8, border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer", background: name.trim() && role ? "linear-gradient(135deg,#00f0ff,#0088aa)" : "rgba(255,255,255,0.05)", color: name.trim() && role ? "#fff" : "#555" }}>Get Started</button>
  </div>;
}
