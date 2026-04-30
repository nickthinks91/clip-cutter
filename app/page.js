"use client";
import { useState, useRef, useEffect } from "react";
import { getSongs, createSong, deleteSong as dbDeleteSong, uploadAudio, getAudioUrl, saveAiClips, getAiClips, saveLeaderClips, getLeaderClips, submitPicks as dbSubmitPicks, getSubmissions, subscribeToSubmissions, findViralMatch, getViralPatterns, getTopViralSounds, getViralPositionPatterns, getAlbums, createAlbum, updateAlbum, deleteAlbum, getAlbumSongs, getAlbumProgress, getAlbumAllProgress, updateSong } from "../lib/supabase";

/* ═══ AUDIO CONVERSION ═══ */
// Convert any audio file to a browser-friendly WAV (16-bit 44.1kHz mono)
// This handles 24-bit, 96kHz, and other exotic formats
async function convertToWebAudio(file) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    const ab = await file.arrayBuffer();
    let buf;
    try {
      buf = await ctx.decodeAudioData(ab);
    } catch (decodeErr) {
      // If browser can't decode, try manual WAV parsing for 24-bit files
      buf = await manualWavDecode(ab, ctx);
    }
    if (!buf) { ctx.close(); return null; }
    // Re-encode as 16-bit 44.1kHz WAV
    const numSamples = Math.floor(buf.duration * 44100);
    const offCtx = new OfflineAudioContext(1, numSamples, 44100);
    const src = offCtx.createBufferSource();
    src.buffer = buf;
    src.connect(offCtx.destination);
    src.start(0);
    const rendered = await offCtx.startRendering();
    const wavBlob = encodeWav(rendered);
    ctx.close();
    return { blob: wavBlob, duration: buf.duration, buffer: rendered };
  } catch (e) {
    console.error('Conversion error:', e);
    return null;
  }
}

// Manual WAV parser for 24-bit and other formats browsers can't decode
async function manualWavDecode(arrayBuffer, ctx) {
  const view = new DataView(arrayBuffer);
  // Check RIFF header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') return null;
  
  // Find fmt chunk
  let offset = 12;
  let fmtOffset = -1, dataOffset = -1, dataSize = 0;
  let channels = 1, sampleRate = 44100, bitsPerSample = 16;
  
  while (offset < view.byteLength - 8) {
    const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1), view.getUint8(offset+2), view.getUint8(offset+3));
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      fmtOffset = offset + 8;
      channels = view.getUint16(fmtOffset + 2, true);
      sampleRate = view.getUint32(fmtOffset + 4, true);
      bitsPerSample = view.getUint16(fmtOffset + 14, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size;
    if (size % 2 !== 0) offset++; // padding byte
  }
  
  if (dataOffset < 0 || fmtOffset < 0) return null;
  
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataSize / (bytesPerSample * channels));
  const buffer = ctx.createBuffer(1, numSamples, sampleRate);
  const output = buffer.getChannelData(0);
  
  for (let i = 0; i < numSamples; i++) {
    const bytePos = dataOffset + i * bytesPerSample * channels;
    if (bytePos + bytesPerSample > view.byteLength) break;
    
    let sample = 0;
    if (bitsPerSample === 24) {
      // 24-bit signed integer
      const b0 = view.getUint8(bytePos);
      const b1 = view.getUint8(bytePos + 1);
      const b2 = view.getUint8(bytePos + 2);
      sample = ((b2 << 16) | (b1 << 8) | b0);
      if (sample >= 0x800000) sample -= 0x1000000;
      sample /= 0x800000;
    } else if (bitsPerSample === 32) {
      sample = view.getFloat32(bytePos, true);
    } else if (bitsPerSample === 16) {
      sample = view.getInt16(bytePos, true) / 32768;
    }
    output[i] = sample;
  }
  
  return buffer;
}


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
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#1e1812"; ctx.fillRect(0, 0, w, h);
    if ((!clips || clips.length === 0) && !readonly) { ctx.fillStyle = "rgba(245,166,35,0.05)"; ctx.fillRect(0, 0, w, h); }
    const gs = zD < 30 ? 1 : zD < 120 ? 5 : 10;
    ctx.strokeStyle = "rgba(245,230,200,0.04)"; ctx.lineWidth = 1;
    for (let t = Math.ceil(zS / gs) * gs; t <= zE; t += gs) { const x = t2x(t, w); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    (highlights || []).forEach(hl => { const x1 = Math.max(0, t2x(hl.startTime, w)), x2 = Math.min(w, t2x(hl.endTime, w)); if (x2 < 0 || x1 > w) return; ctx.fillStyle = hl.color || "rgba(245,166,35,0.08)"; ctx.fillRect(x1, 0, x2 - x1, h); if (hl.label && x2 - x1 > 30) { ctx.fillStyle = hl.lc || "rgba(245,166,35,0.5)"; ctx.font = "bold 9px Fredoka, sans-serif"; ctx.fillText(hl.label, x1 + 4, h - 5); } });
    (clips || []).forEach((cl, idx) => { const x1 = Math.max(0, t2x(cl.startTime, w)), x2 = Math.min(w, t2x(cl.endTime, w)); if (x2 < 0 || x1 > w) return; const isSel = idx === selClip; ctx.fillStyle = isSel ? "rgba(245,166,35,0.15)" : "rgba(245,230,200,0.03)"; ctx.fillRect(x1, 0, x2 - x1, h); if (!readonly) { ctx.fillStyle = isSel ? "rgba(245,166,35,0.6)" : "rgba(245,230,200,0.12)"; ctx.fillRect(x1, 0, 3, h); ctx.fillRect(x2 - 3, 0, 3, h); } ctx.fillStyle = isSel ? "#F5A623" : "rgba(245,230,200,0.3)"; ctx.font = "bold 10px Fredoka, sans-serif"; const lbl = cl.isManual ? "✎" : `#${idx + 1}`; if (x2 - x1 > 30) ctx.fillText(lbl, x1 + 5, 13); });
    const si = Math.floor((zS / duration) * energy.length), ei = Math.floor((zE / duration) * energy.length);
    ctx.beginPath(); ctx.moveTo(0, h); for (let x = 0; x < w; x++) { const eI = si + Math.floor((x / w) * (ei - si)); ctx.lineTo(x, h - (energy[Math.min(eI, energy.length - 1)] || 0) * h * 0.85); } ctx.lineTo(w, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "rgba(245,166,35,0.6)"); g.addColorStop(0.5, "rgba(199,62,62,0.25)"); g.addColorStop(1, "rgba(212,148,28,0.03)"); ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = "rgba(245,230,200,0.25)"; ctx.font = "9px Fredoka, sans-serif"; for (let t = Math.ceil(zS / gs) * gs; t <= zE; t += gs) ctx.fillText(fmt(t), t2x(t, w) + 2, h - 3);
    if (playheadTime != null && playheadTime >= zS && playheadTime <= zE) { const px = t2x(playheadTime, w); ctx.strokeStyle = "#C73E3E"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke(); ctx.fillStyle = "#C73E3E"; ctx.font = "bold 9px Fredoka, sans-serif"; ctx.fillText(fmt(playheadTime), px + 4, 12); }
    if (hover !== null && playheadTime == null) { const hx = t2x(hover, w); ctx.strokeStyle = "rgba(245,230,200,0.2)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = "rgba(245,230,200,0.4)"; ctx.font = "9px Fredoka, sans-serif"; ctx.fillText(fmt(hover), hx + 3, h - 14); }
  }, [energy, clips, highlights, selClip, duration, zoom, hover, drag, playheadTime]);
  const gx = e => { const r = ref.current.getBoundingClientRect(); const cx = e.touches ? e.touches[0].clientX : e.clientX; return (cx - r.left) * (800 / r.width); };
  const findEdge = cx => { if (readonly) return null; const thresh = 'ontouchstart' in window ? 20 : 10; for (let i = 0; i < (clips || []).length; i++) { const x1 = t2x(clips[i].startTime, 800), x2 = t2x(clips[i].endTime, 800); if (Math.abs(cx - x1) < thresh) return { idx: i, edge: "start" }; if (Math.abs(cx - x2) < thresh) return { idx: i, edge: "end" }; } return null; };
  const findClip = cx => { const t = x2t(cx, 800), hits = []; for (let i = 0; i < (clips || []).length; i++) if (t >= clips[i].startTime && t <= clips[i].endTime) hits.push(i); if (!hits.length) return null; if (hits.includes(selClip)) return selClip; return hits[0]; };
  const onDown = e => { if (readonly) return; const x = gx(e); const eh = findEdge(x); if (eh) { setDrag({ type: "edge", ...eh }); return; } const hit = findClip(x); if (hit !== null) { onSel(hit); setDrag({ type: "move", idx: hit, startT: x2t(x, 800), origS: clips[hit].startTime, origE: clips[hit].endTime }); } if (onPlayFrom) { onPlayFrom(Math.max(0, x2t(x, 800))); } };
  const onMv = e => { const x = gx(e); setHover(x2t(x, 800)); if (drag?.type === "move") { const dt = x2t(x, 800) - drag.startT, cd = drag.origE - drag.origS; let ns = drag.origS + dt, ne = drag.origE + dt; if (ns < 0) { ns = 0; ne = cd; } if (ne > duration) { ne = duration; ns = duration - cd; } onMove(drag.idx, ns, ne); } else if (drag?.type === "edge") onEdge(drag.idx, drag.edge, Math.max(0, Math.min(duration, x2t(x, 800)))); };
  const onUp = () => setDrag(null);
  const onDbl = e => { if (readonly) return; onCreate(Math.max(0, x2t(gx(e), 800)), null); };
  const onWhl = e => { e.preventDefault(); const x = gx(e), p = x2t(x, 800), f = e.deltaY > 0 ? 1.3 : 0.7, nd = Math.max(5, Math.min(duration, zD * f)), r = (p - zS) / zD; let ns = p - r * nd, ne = p + (1 - r) * nd; if (ns < 0) { ne -= ns; ns = 0; } if (ne > duration) { ns -= (ne - duration); ne = duration; } onZoom([Math.max(0, ns), Math.min(duration, ne)]); };
  const onTouchStart = e => { e.preventDefault(); onDown(e); };
  const onTouchMove = e => { e.preventDefault(); onMv(e); };
  const onTouchEnd = e => { e.preventDefault(); onUp(); };
  return <canvas ref={ref} width={800} height={120} onMouseDown={onDown} onMouseMove={onMv} onMouseUp={onUp} onMouseLeave={() => { setHover(null); setDrag(null); }} onDoubleClick={onDbl} onWheel={onWhl} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} style={{ width: "100%", height: 120, borderRadius: 10, border: "2px solid rgba(245,166,35,0.15)", cursor: "default", display: "block", touchAction: "none" }} />;
}

/* ═══ UI ═══ */
function AgreementBar({ count, total }) { const pct = total > 0 ? (count / total) * 100 : 0; const color = pct >= 70 ? "#44cc66" : pct >= 40 ? "#F5A623" : "#C73E3E"; return <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ flex: 1, height: 6, background: "rgba(245,230,200,0.08)", borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} /></div><span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: "Fredoka, sans-serif", minWidth: 40 }}>{count}/{total}</span></div>; }


function ClipCard({ c, idx, sel, playing, isModified, bs, onSel, onPlay, onExport, onDur, onNote, onAB, onRevert, onDel, editNote, setEditNote, ab, clips }) {
  const isSel = idx === sel;
  return (
    <div onClick={() => onSel(idx)} style={{ background: isSel ? "rgba(245,166,35,0.035)" : "rgba(245,230,200,0.01)", border: `1px solid ${isSel ? "rgba(245,166,35,0.15)" : "rgba(245,230,200,0.035)"}`, borderRadius: 8, padding: "10px 12px", cursor: "pointer", transition: "all 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 800, minWidth: 28, textAlign: "center", color: c.isManual ? "#F5A623" : idx === 0 ? "#F5A623" : idx === 1 ? "#C73E3E" : "#9B8B73" }}>{c.isManual ? "✎" : `#${idx + 1}`}</div>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>{fmt(c.startTime)} → {fmt(c.endTime)}</span>
          <span style={{ fontSize: 9, color: "#9B8B73", marginLeft: 5 }}>({c.dur}s)</span>
          {c.viralBoost && parseFloat(c.viralBoost) > 0.3 && <span style={{ fontSize: 7, color: "#F5A623", marginLeft: 5, fontFamily: "Fredoka, sans-serif", background: "rgba(245,166,35,0.1)", padding: "0 4px", borderRadius: 2 }}>🔥 VIRAL</span>}
          {isModified && <span style={{ fontSize: 8, color: "#D4941C", marginLeft: 5, fontFamily: "Fredoka, sans-serif" }}>● edited</span>}
          {c.notes && <span style={{ fontSize: 9, color: "#C73E3E", marginLeft: 6, fontStyle: "italic" }}>📝 {c.notes}</span>}
        </div>
        <div style={{ display: "flex", gap: 3, alignItems: "center", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 2 }}>{[15, 30, 60].map(d => <button key={d} onClick={e => { e.stopPropagation(); onDur(idx, d); }} style={{ ...bs(c.dur === d), padding: "2px 5px", fontSize: 8 }}>{d}s</button>)}</div>
          <button onClick={e => { e.stopPropagation(); onPlay(idx); }} style={{ width: 28, height: 28, borderRadius: "50%", background: playing && isSel ? "linear-gradient(135deg,#C73E3E,#ff6644)" : "linear-gradient(135deg,#F5A623,#0088aa)", border: "none", color: "#fff", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{playing && isSel ? "■" : "▶"}</button>
          <button onClick={e => { e.stopPropagation(); onExport(idx); }} style={{ background: "rgba(245,230,200,0.04)", border: "1px solid rgba(245,230,200,0.07)", color: "#ccc", fontSize: 9, padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontFamily: "Fredoka, sans-serif" }}>⬇</button>
        </div>
      </div>
      {isSel && <div style={{ display: "flex", gap: 4, marginTop: 4, paddingLeft: 36, flexWrap: "wrap" }}>
        <button onClick={e => { e.stopPropagation(); setEditNote(editNote === idx ? null : idx); }} style={{ ...bs(editNote === idx), padding: "2px 8px", fontSize: 8 }}>📝 {c.notes ? "Edit" : "Add"} Note</button>
        {clips.length >= 2 && <button onClick={e => { e.stopPropagation(); onAB(idx); }} style={{ ...bs(false), padding: "2px 8px", fontSize: 8 }}>⚡ A/B Compare</button>}
        {isModified && <button onClick={e => { e.stopPropagation(); onRevert(idx); }} style={{ ...bs(false), padding: "2px 8px", fontSize: 8, color: "#F5A623" }}>↩ Revert</button>}
        {c.isManual && <button onClick={e => { e.stopPropagation(); onDel(idx); }} style={{ background: "rgba(199,62,62,0.05)", border: "1px solid rgba(199,62,62,0.1)", color: "#C73E3E", padding: "2px 8px", borderRadius: 4, fontSize: 8, cursor: "pointer" }}>🗑 Delete</button>}
      </div>}
      {editNote === idx && <div style={{ marginTop: 6, paddingLeft: 36 }} onClick={e => e.stopPropagation()}>
        <input type="text" value={c.notes || ""} onChange={e => onNote(idx, e.target.value)} placeholder="e.g. 'Best for lip-sync'" autoFocus style={{ width: "100%", background: "rgba(245,230,200,0.03)", border: "1px solid rgba(245,230,200,0.08)", borderRadius: 5, padding: "6px 9px", color: "#F5E6C8", fontSize: 10, outline: "none" }} onKeyDown={e => { if (e.key === "Enter") setEditNote(null); }} />
      </div>}
      {ab && isSel && <div style={{ marginTop: 5, paddingLeft: 36, display: "flex", gap: 3, flexWrap: "wrap" }}>
        <span style={{ fontSize: 8, color: "#555", fontFamily: "Fredoka, sans-serif" }}>Compare vs:</span>
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
  const playGen = useRef(0);
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
  const [lastTapTime, setLastTapTime] = useState(0);
  const [playingFull, setPlayingFull] = useState(false), [fullProgress, setFullProgress] = useState(0);
  const [activeRange, setActiveRange] = useState(null);
  const [viralInfo, setViralInfo] = useState(null); // { matches, matchType, patterns, genre }
  const [selectedGenre, setSelectedGenre] = useState(null); // genre for viral intelligence
  const [albums, setAlbums] = useState([]);
  const [activeAlbum, setActiveAlbum] = useState(null);
  const [albumSongs, setAlbumSongs] = useState([]);
  const [albumProgress, setAlbumProgress] = useState(null);
  const [albumTeamProgress, setAlbumTeamProgress] = useState({});
  const [newAlbumName, setNewAlbumName] = useState("");
  const [albumUploading, setAlbumUploading] = useState(false);
  const [albumUploadProgress, setAlbumUploadProgress] = useState("");
  const [editingSongId, setEditingSongId] = useState(null);
  const [editingSongName, setEditingSongName] = useState("");
  const [dirty, setDirty] = useState(false);

  // Load user from localStorage & songs from Supabase
  useEffect(() => {
    const saved = localStorage.getItem("cc-user");
    if (saved) setUser(JSON.parse(saved));
    setUserLoaded(true);
    getSongs().then(setSongs).catch(console.error);
    getAlbums().then(setAlbums).catch(console.error);
  }, []);

  const flash = msg => { setNotice(msg); setTimeout(() => setNotice(null), 2500); };
  const setupUser = (name, role) => { const u = { name: name.trim(), role }; setUser(u); localStorage.setItem("cc-user", JSON.stringify(u)); };
  const isLeader = user?.role === "leader";
  const hasAudio = energy.length > 0;
  const activeSongData = songs.find(s => s.id === activeSong) || albumSongs.find(s => s.id === activeSong);

  // Stream audio from Supabase storage
  const loadAudioFromUrl = async (url) => {
    setAudioLoading(true);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); actx.current = ctx;
      const resp = await fetch(url);
      const ab = await resp.arrayBuffer();
      let buf;
      try {
        buf = await ctx.decodeAudioData(ab.slice(0)); // slice to copy since decodeAudioData detaches
      } catch (decodeErr) {
        console.log('Standard decode failed, trying manual WAV parse...');
        buf = await manualWavDecode(ab, ctx);
      }
      if (!buf) throw new Error('Could not decode audio');
      abuf.current = buf;
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
      const ab = await f.arrayBuffer();
      let buf;
      try {
        buf = await ctx.decodeAudioData(ab.slice(0));
      } catch (decodeErr) {
        console.log('Standard decode failed, trying manual WAV parse...');
        buf = await manualWavDecode(ab, ctx);
      }
      if (!buf) throw new Error('Could not decode audio');
      abuf.current = buf;
      const res = analyzeAudio(buf); setAnalysis(res); setEnergy(res.energy); scoreFn.current = res.scoreClip;
      return { res, file: f };
    } catch (e2) { console.error(e2); flash("Error loading audio"); return null; }
    finally { setAudioLoading(false); }
  };

  // Leader: upload song (file → Supabase storage + analysis)
  const handleUpload = async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0] || e.target?.files?.[0]; if (!f) return;
    setAnalyzing(true); setViralInfo(null);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); actx.current = ctx;
      const buf = await ctx.decodeAudioData(await f.arrayBuffer()); abuf.current = buf;
      const res = analyzeAudio(buf); setAnalysis(res); setEnergy(res.energy); scoreFn.current = res.scoreClip;
      const duration = res.duration;
      
      // ═══ VIRAL INTELLIGENCE ═══
      let viralData = null;
      let positionPattern = null;
      const genre = selectedGenre;

      try {
        // 1. Check for direct song match in viral database
        const viral = await findViralMatch(f.name);
        if (viral.matches.length > 0) {
          const topMatch = viral.matches[0];
          const matchGenre = genre || topMatch.genre;
          const patterns = matchGenre ? await getViralPatterns(matchGenre) : null;
          viralData = { ...viral, patterns, genre: matchGenre, topMatch };
        }

        // 2. Fetch learned position patterns for genre (from audio matching pipeline)
        if (genre) {
          positionPattern = await getViralPositionPatterns(genre);
        }

        setViralInfo({ 
          ...(viralData || { matches: [], matchType: 'none' }),
          positionPattern, 
          genre,
          patterns: viralData?.patterns || null
        });
      } catch (ve) { console.log('Viral lookup skipped:', ve.message); }

      // ═══ RE-SCORE CLIPS WITH VIRAL POSITION DATA ═══
      let topClips = res.topClips;
      if (positionPattern && positionPattern.avg_start_position_pct != null) {
        const idealPct = positionPattern.avg_start_position_pct / 100;
        const medianPct = (positionPattern.median_start_position_pct || positionPattern.avg_start_position_pct) / 100;
        const rangeLow = (positionPattern.position_range?.min || 0) / 100;
        const rangeHigh = (positionPattern.position_range?.max || 100) / 100;

        // Generate NEW candidates focused around the viral sweet spot
        // Scan every 2 seconds across the full song, score with position weighting
        const allCands = [];
        const step = 2;
        for (let st = 0; st + 60 <= duration; st += step) {
          const et = st + 60;
          const baseScore = res.scoreClip(st, et);
          const clipPct = st / duration;
          
          // Position scoring - gaussian-like curve centered on ideal position
          const distFromIdeal = Math.abs(clipPct - idealPct);
          const distFromMedian = Math.abs(clipPct - medianPct);
          const bestDist = Math.min(distFromIdeal, distFromMedian);
          const inRange = clipPct >= rangeLow && clipPct <= rangeHigh;
          
          // Position is now 60% of the total score, energy is 40%
          const positionWeight = inRange 
            ? Math.exp(-bestDist * bestDist * 20) * 10  // strong gaussian boost in range
            : Math.exp(-bestDist * bestDist * 8) * 3;   // weaker outside range
          const combinedScore = baseScore.score * 0.4 + positionWeight * 0.6;
          
          allCands.push({
            ...baseScore,
            startTime: st,
            endTime: et,
            score: combinedScore,
            viralBoost: positionWeight.toFixed(2),
            viralPct: Math.round(clipPct * 100)
          });
        }
        
        allCands.sort((a, b) => b.score - a.score);
        
        // Pick top 5 with at least 10s spacing
        topClips = [];
        for (const c of allCands) {
          if (topClips.every(t => Math.abs(t.startTime - c.startTime) > 10)) topClips.push(c);
          if (topClips.length >= 5) break;
        }
      }

      // Create song in DB
      const song = await createSong({ name: f.name, duration: res.duration, bpm: res.bpm, shareLink: "" });
      // Upload audio to storage
      await uploadAudio(f, song.id);
      // Save AI clips
      await saveAiClips(song.id, topClips);
      // Refresh songs list
      const allSongs = await getSongs(); setSongs(allSongs);
      setActiveSong(song.id); setAiClips(topClips);
      setClips(topClips.map((c, i) => ({ ...c, id: `a${i}`, isManual: false, notes: "", dur: Math.round(c.endTime - c.startTime), origStart: c.startTime, origEnd: c.endTime })));
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
    if (!song?.audio_path) return null;
    const url = getAudioUrl(song.audio_path);
    if (!url) return null;
    const res = await loadAudioFromUrl(url);
    return res;
  };

  // Clip ops
  const createClip = (st, et) => { const d = analysis?.duration || 300; let s = Math.max(0, st), e = et !== null ? Math.min(d, et) : Math.min(d, s + defDur); if (e - s < 2) e = Math.min(d, s + defDur); const sc = scoreFn.current ? scoreFn.current(s, e) : {}; setClips(p => [...p, { ...sc, startTime: s, endTime: e, id: `m${Date.now()}`, isManual: true, notes: "", dur: Math.round(e - s) }]); setSel(clips.length); setDirty(true); };
  const dragEdge = (idx, edge, t) => { setClips(p => { const u = [...p], c = { ...u[idx] }; if (edge === "start") c.startTime = Math.min(t, c.endTime - 1); else c.endTime = Math.max(t, c.startTime + 1); c.dur = Math.round(c.endTime - c.startTime); if (scoreFn.current) Object.assign(c, scoreFn.current(c.startTime, c.endTime)); u[idx] = c; return u; }); setDirty(true); };
  const moveClip = (idx, ns, ne) => { setClips(p => { const u = [...p], c = { ...u[idx] }; c.startTime = ns; c.endTime = ne; c.dur = Math.round(ne - ns); if (scoreFn.current) Object.assign(c, scoreFn.current(ns, ne)); u[idx] = c; return u; }); setDirty(true); };
  const setClipDur = (idx, nd) => { setClips(p => { const u = [...p], c = { ...u[idx] }, d = analysis?.duration || 300; c.endTime = Math.min(d, c.startTime + nd); c.dur = Math.round(c.endTime - c.startTime); if (scoreFn.current) Object.assign(c, scoreFn.current(c.startTime, c.endTime)); u[idx] = c; return u; }); setDirty(true); };
  const updateNote = (idx, n) => { setClips(p => { const u = [...p]; u[idx] = { ...u[idx], notes: n }; return u; }); setDirty(true); };
  const delClip = idx => { setClips(p => p.filter((_, i) => i !== idx)); if (sel >= idx && sel > 0) setSel(sel - 1); setDirty(true); };
  const revertClip = idx => { setClips(p => { const u = [...p], c = { ...u[idx] }; if (c.origStart == null) return p; c.startTime = c.origStart; c.endTime = c.origEnd; c.dur = Math.round(c.endTime - c.startTime); if (scoreFn.current) Object.assign(c, scoreFn.current(c.startTime, c.endTime)); u[idx] = c; return u; }); setDirty(true); };
  const isModified = c => !c.isManual && c.origStart != null && (Math.abs(c.startTime - c.origStart) > 0.5 || Math.abs(c.endTime - c.origEnd) > 0.5);

  // Playback
  const playingClipRef = useRef(null);
  const stopPlay = () => { playGen.current++; if (src.current) try { src.current.onended = null; src.current.stop(); } catch (e) { } src.current = null; cancelAnimationFrame(af.current); setPlaying(false); setProgress(0); setPlayingFull(false); setFullProgress(0); setActiveRange(null); playingClipRef.current = null; };
  const playClip = idx => {
    const cl = clips[idx]; if (!actx.current || !abuf.current || !cl) return;
    const wasSame = playingClipRef.current === idx && playing;
    stopPlay();
    if (wasSame) { playingClipRef.current = null; return; }
    playGen.current++; const gen = playGen.current;
    const s = actx.current.createBufferSource(); s.buffer = abuf.current; s.connect(actx.current.destination);
    s.start(0, cl.startTime, cl.endTime - cl.startTime); src.current = s; stT.current = actx.current.currentTime;
    setPlaying(true); setSel(idx); setActiveRange(null); playingClipRef.current = idx; const dur = cl.endTime - cl.startTime;
    const tick = () => { if (playGen.current !== gen) return; const el = actx.current.currentTime - stT.current; setProgress(Math.min(1, el / dur)); if (el < dur) af.current = requestAnimationFrame(tick); else { setPlaying(false); setProgress(0); playingClipRef.current = null; } };
    af.current = requestAnimationFrame(tick); s.onended = () => { if (playGen.current !== gen) return; setPlaying(false); setProgress(0); playingClipRef.current = null; cancelAnimationFrame(af.current); };
  };
  const playRange = (st, et, rangeKey) => { if (!actx.current || !abuf.current) return; stopPlay(); playGen.current++; const gen = playGen.current; const s = actx.current.createBufferSource(); s.buffer = abuf.current; s.connect(actx.current.destination); s.start(0, st, et - st); src.current = s; setPlaying(true); if (rangeKey) setActiveRange(rangeKey); s.onended = () => { if (playGen.current !== gen) return; setPlaying(false); setActiveRange(null); }; };

  const playFull = (startFrom = 0) => {
    if (!actx.current || !abuf.current) return;
    if (playingFull && startFrom === 0) { stopPlay(); return; }
    stopPlay(); playGen.current++; const gen = playGen.current;
    const dur = abuf.current.duration;
    const s = actx.current.createBufferSource(); s.buffer = abuf.current; s.connect(actx.current.destination);
    s.start(0, startFrom, dur - startFrom); src.current = s; stT.current = actx.current.currentTime - startFrom;
    setPlaying(true); setPlayingFull(true);
    const tick = () => { if (playGen.current !== gen) return; const el = actx.current.currentTime - stT.current; const p = Math.min(1, el / dur); setFullProgress(p); if (el < dur) af.current = requestAnimationFrame(tick); else { setPlaying(false); setPlayingFull(false); setFullProgress(0); } };
    af.current = requestAnimationFrame(tick);
    s.onended = () => { if (playGen.current !== gen) return; setPlaying(false); setPlayingFull(false); setFullProgress(0); cancelAnimationFrame(af.current); };
  };

  // Export
  const expClip = async idx => { setExpIdx(idx); const cl = clips[idx]; if (!abuf.current || !cl) { setExpIdx(null); return; } const sr = abuf.current.sampleRate, ns = Math.floor((cl.endTime - cl.startTime) * sr); const oc = new OfflineAudioContext(abuf.current.numberOfChannels, ns, sr); const s = oc.createBufferSource(); s.buffer = abuf.current; s.connect(oc.destination); s.start(0, cl.startTime, cl.endTime - cl.startTime); const r = await oc.startRendering(); const blob = encodeWav(r); const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = `${(activeSongData?.name || "clip").replace(/\.[^.]+$/, "")}_clip${idx + 1}_${fmt(cl.startTime)}-${fmt(cl.endTime)}.wav`; a.click(); URL.revokeObjectURL(url); setDl(p => ({ ...p, [idx]: true })); setExpIdx(null); };
  const expAll = async () => { for (let i = 0; i < clips.length; i++) { await expClip(i); await new Promise(r => setTimeout(r, 400)); } };
  const expRange = async (st, et, label) => { if (!abuf.current) return; const sr = abuf.current.sampleRate, ns = Math.floor((et - st) * sr); const oc = new OfflineAudioContext(abuf.current.numberOfChannels, ns, sr); const s = oc.createBufferSource(); s.buffer = abuf.current; s.connect(oc.destination); s.start(0, st, et - st); const r = await oc.startRendering(); const blob = encodeWav(r); const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = `${(activeSongData?.name || "clip").replace(/\.[^.]+$/, "")}_${label}.wav`; a.click(); URL.revokeObjectURL(url); };

  // Team
  const submitMyPicks = async () => { if (!activeSong || clips.length < 2) return; await dbSubmitPicks(activeSong, user.name, clips.map(c => ({ startTime: c.startTime, endTime: c.endTime, notes: c.notes || "", dur: c.dur }))); setSubmitted(true); flash("Picks submitted!"); };
  const retractClip = async (idx) => { const newClips = clips.filter((_, i) => i !== idx); setClips(newClips); if (sel >= idx && sel > 0) setSel(sel - 1); if (submitted && activeSong) { if (newClips.length > 0) { await dbSubmitPicks(activeSong, user.name, newClips.map(c => ({ startTime: c.startTime, endTime: c.endTime, notes: c.notes || "", dur: c.dur }))); flash("Clip retracted — submission updated"); } else { await dbSubmitPicks(activeSong, user.name, []); setSubmitted(false); flash("All clips retracted"); } } };

  const loadReview = async songId => {
    const song = songs.find(s => s.id === songId) || albumSongs.find(s => s.id === songId);
    const sameSong = songId === activeSong;
    setActiveSong(songId);
    const s = await getSubmissions(songId);
    let ai = await getAiClips(songId);
    const leaderSaved = await getLeaderClips(songId);
    setSubs(s); setAiClips(ai); setConsensus(buildConsensus(s)); setPage("review");
    if (!sameSong) {
      setEnergy([]); abuf.current = null; actx.current = null;
      setAnalysis(song ? { duration: song.duration, bpm: song.bpm } : null);
      if (song?.audio_path) {
        const res = await streamSongAudio(song);
        // If no AI clips exist yet (album upload), generate them now
        if (res && ai.length === 0) {
          const analysis = analyzeAudio(abuf.current);
          const topClips = analysis.topClips;
          await saveAiClips(songId, topClips);
          // Also update song duration/bpm if missing
          if (!song.duration || song.duration === 0) {
            await updateSong(songId, { duration: analysis.duration, bpm: analysis.bpm });
          }
          ai = topClips;
          setAiClips(ai);
        }
      }
    }
    if (leaderSaved.length > 0) {
      setClips(leaderSaved.map((c, i) => ({ ...c, id: `l${i}`, dur: Math.round(c.endTime - c.startTime), origStart: c.startTime, origEnd: c.endTime })));
    } else {
      setClips(ai.map((c, i) => ({ ...c, id: `a${i}`, isManual: false, notes: "", dur: Math.round(c.endTime - c.startTime), origStart: c.startTime, origEnd: c.endTime })));
    }
    setSel(0); setDl({}); setZoom(null); setDirty(false);
  };

  const loadSubmit = async songId => {
    const song = songs.find(s => s.id === songId) || albumSongs.find(s => s.id === songId);
    setActiveSong(songId); setClips([]); setSel(0); setZoom(null); setSubmitted(false); setEnergy([]); setAnalysis(null); setPage("submit");
    // Auto-stream audio if available
    if (song?.audio_path) {
      const url = getAudioUrl(song.audio_path);
      if (url) loadAudioFromUrl(url);
    }
    // Restore prior submission if one exists for this member
    const subs = await getSubmissions(songId);
    const mine = subs.find(s => s.member === user?.name);
    if (mine && mine.clips.length > 0) {
      setClips(mine.clips.map((c, i) => ({ ...c, id: `s${i}`, isManual: true, dur: Math.round(c.endTime - c.startTime) })));
      setSubmitted(true);
    }
  };

  const refreshSubs = async () => { if (!activeSong) return; const s = await getSubmissions(activeSong); setSubs(s); setConsensus(buildConsensus(s)); flash("Refreshed!"); };
  const handleSaveLeaderClips = async () => { if (!activeSong) return; await saveLeaderClips(activeSong, clips); setDirty(false); flash("Clips saved!"); };
  const delSong = async id => { await dbDeleteSong(id); const allSongs = await getSongs(); setSongs(allSongs); if (activeAlbum) { const as = await getAlbumSongs(activeAlbum); setAlbumSongs(as); } };

  // ═══ ALBUM FUNCTIONS ═══
  const handleCreateAlbum = async () => {
    if (!newAlbumName.trim()) return;
    const album = await createAlbum({ name: newAlbumName.trim(), genre: selectedGenre });
    setAlbums(await getAlbums());
    setNewAlbumName("");
    setActiveAlbum(album.id);
    setAlbumSongs([]);
    setPage("album");
  };

  const handleAlbumUpload = async (e) => {
    const files = e.target?.files || e.dataTransfer?.files;
    if (!files?.length || !activeAlbum) return;
    e.preventDefault?.();
    setAlbumUploading(true);

    const audioFiles = [];
    for (const f of files) {
      if (f.name.endsWith('.zip')) {
        setAlbumUploadProgress("Extracting zip...");
        try {
          const JSZip = (await import('jszip')).default;
          const zip = await JSZip.loadAsync(await f.arrayBuffer());
          const entries = Object.values(zip.files).filter(e => !e.dir && /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(e.name));
          for (const entry of entries) {
            const blob = await entry.async('blob');
            const name = entry.name.split('/').pop();
            audioFiles.push(new File([blob], name, { type: 'audio/' + name.split('.').pop() }));
          }
        } catch (ze) { console.error('Zip error:', ze); flash("Error extracting zip"); }
      } else if (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name)) {
        audioFiles.push(f);
      }
    }

    if (!audioFiles.length) { setAlbumUploading(false); flash("No audio files found"); return; }

    const existingSongs = await getAlbumSongs(activeAlbum);
    let trackNum = existingSongs.length;

    for (let i = 0; i < audioFiles.length; i++) {
      const af = audioFiles[i];
      setAlbumUploadProgress(`Converting & uploading ${i + 1}/${audioFiles.length}: ${af.name.replace(/\.[^.]+$/, '').slice(0, 35)}`);
      try {
        const songName = af.name.replace(/\.[^.]+$/, '');
        
        // Convert to browser-friendly WAV (handles 24-bit, 96kHz, etc)
        const converted = await convertToWebAudio(af);
        let uploadFile = af;
        let duration = 0;
        let bpm = 0;
        
        if (converted) {
          uploadFile = new File([converted.blob], songName + '.wav', { type: 'audio/wav' });
          duration = Math.round(converted.duration * 10) / 10;
          // Quick BPM from the already-decoded buffer
          try {
            const res = analyzeAudio(converted.buffer);
            bpm = res.bpm;
            // Save AI clips too since we already have the analysis
            const song = await createSong({ name: songName, duration, bpm, shareLink: "", albumId: activeAlbum, trackNumber: trackNum });
            await uploadAudio(uploadFile, song.id);
            await saveAiClips(song.id, res.topClips);
            trackNum++;
            continue;
          } catch (ae) { console.error('Analysis error, uploading without:', ae); }
        }
        
        // Fallback: upload without conversion/analysis
        const song = await createSong({ name: songName, duration, bpm, shareLink: "", albumId: activeAlbum, trackNumber: trackNum });
        await uploadAudio(uploadFile, song.id);
        trackNum++;
      } catch (ue) { console.error('Upload error for', af.name, ue); }
    }

    await updateAlbum(activeAlbum, { track_count: trackNum });
    const updatedSongs = await getAlbumSongs(activeAlbum);
    setAlbumSongs(updatedSongs);
    setSongs(await getSongs());
    setAlbums(await getAlbums());
    setAlbumUploading(false);
    setAlbumUploadProgress("");
    flash(`${audioFiles.length} song${audioFiles.length > 1 ? 's' : ''} added!`);
  };

  const loadAlbum = async (albumId) => {
    setActiveAlbum(albumId);
    const as = await getAlbumSongs(albumId);
    setAlbumSongs(as);
    if (!isLeader && user) {
      const prog = await getAlbumProgress(albumId, user.name);
      setAlbumProgress(prog);
    }
    if (isLeader) {
      const tp = await getAlbumAllProgress(albumId);
      setAlbumTeamProgress(tp);
    }
    setPage("album");
  };

  const renameSong = async (songId, newName) => {
    await updateSong(songId, { name: newName });
    const updatedSongs = await getAlbumSongs(activeAlbum);
    setAlbumSongs(updatedSongs);
    setSongs(await getSongs());
    setEditingSongId(null);
    setEditingSongName("");
  };

  // Smart back: go to album if song is in an album, otherwise home
  const goBack = () => {
    if (activeSongData?.album_id && activeAlbum) {
      loadAlbum(activeAlbum);
    } else if (activeSongData?.album_id) {
      setActiveAlbum(activeSongData.album_id);
      loadAlbum(activeSongData.album_id);
    } else {
      setPage("home");
    }
  };

  // Next/prev song in album
  const albumSongNav = () => {
    if (!activeSongData?.album_id || !albumSongs.length) return null;
    const idx = albumSongs.findIndex(s => s.id === activeSong);
    if (idx < 0) return null;
    return { idx, total: albumSongs.length, prev: idx > 0 ? albumSongs[idx - 1] : null, next: idx < albumSongs.length - 1 ? albumSongs[idx + 1] : null };
  };

  const goToAlbumSong = (songId) => {
    if (isLeader) loadReview(songId);
    else loadSubmit(songId);
  };

  const delAlbum = async (id) => {
    await deleteAlbum(id);
    setAlbums(await getAlbums());
    setSongs(await getSongs());
  };

  // Realtime subscription
  useEffect(() => {
    if (page === "review" && activeSong) {
      const unsub = subscribeToSubmissions(activeSong, refreshSubs);
      return unsub;
    }
  }, [page, activeSong]);

  useEffect(() => {
    const handler = e => { if (dirty && isLeader) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, isLeader]);

  const bs = active => ({ background: active ? "rgba(245,166,35,0.12)" : "rgba(245,230,200,0.04)", border: `1px solid ${active ? "rgba(245,166,35,0.3)" : "rgba(245,230,200,0.08)"}`, color: active ? "#F5A623" : "#9B8B73", padding: "5px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontFamily: "Fredoka, sans-serif", transition: "all 0.2s", letterSpacing: "0.5px" });
  const cs = active => ({ background: active ? "rgba(245,166,35,0.05)" : "rgba(245,230,200,0.015)", border: `1px solid ${active ? "rgba(245,166,35,0.2)" : "rgba(245,230,200,0.05)"}`, borderRadius: 9, padding: "12px 14px", cursor: "pointer", transition: "all 0.2s" });
  const selC = clips[sel];
  const playheadTime = playingFull && analysis?.duration ? fullProgress * analysis.duration : null;
  const startAB = (idx, other) => setAb({ a: idx, b: other !== undefined ? other : (idx === 0 ? 1 : 0) });

  if (!userLoaded) return <div style={{ minHeight: "100vh", background: "#000000", display: "flex", alignItems: "center", justifyContent: "center", color: "#9B8B73", fontFamily: "DM Sans, sans-serif" }}>Loading...</div>;
  if (!user) return <div style={{ minHeight: "100vh", background: "#000000", color: "#F5E6C8", fontFamily: "DM Sans, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}><div style={{ maxWidth: 400, width: "100%", padding: "24px 20px", overflow: "hidden" }}><div style={{ textAlign: "center", marginBottom: 24 }}><img src="/mascot.png?v=2" alt="Clip Cutter" style={{ width: 200, height: "auto", marginBottom: 4, filter: "drop-shadow(0 6px 20px rgba(0,0,0,0.7))" }} /><h1 style={{ fontSize: 32, fontWeight: 800, marginBottom: 6, fontFamily: "'Permanent Marker', cursive", color: "#F5A623", letterSpacing: 2, textShadow: "2px 2px 0px rgba(199,62,62,0.4)" }}>CLIP CUTTER</h1><p style={{ color: "#9B8B73", fontSize: 13, fontFamily: "Fredoka, sans-serif", letterSpacing: 2, textTransform: "uppercase" }}>Team Collaboration</p></div><SetupForm onSetup={setupUser} /></div></div>;

  return (
    <div style={{ minHeight: "100vh", background: "#000000", color: "#F5E6C8", fontFamily: "DM Sans, sans-serif", overflow: "hidden" }}>
      <div style={{ overflowX: "hidden", overflowY: "auto", height: "100vh", WebkitOverflowScrolling: "touch" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "2px solid rgba(245,166,35,0.15)", background: "linear-gradient(180deg, #000000 0%, #000000 100%)", position: "sticky", top: 0, zIndex: 50, flexWrap: "wrap", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}><img src="/mascot.png?v=2" alt="" style={{ width: 32, height: 32, objectFit: "contain", filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.4))" }} /><span style={{ fontWeight: 800, fontSize: 16, fontFamily: "'Permanent Marker', cursive", color: "#F5A623", letterSpacing: 1 }}>CLIP CUTTER</span><span style={{ fontFamily: "Fredoka, sans-serif", fontSize: 9, color: isLeader ? "#C73E3E" : "#F5A623", letterSpacing: 2, background: isLeader ? "rgba(199,62,62,0.15)" : "rgba(245,166,35,0.12)", padding: "2px 8px", borderRadius: 3, border: `1px solid ${isLeader ? "rgba(199,62,62,0.3)" : "rgba(245,166,35,0.25)"}` }}>{user.role.toUpperCase()}</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 11, color: "#9B8B73", fontFamily: "Fredoka, sans-serif" }}>{user.name}</span><button onClick={() => setPage("home")} style={bs(page === "home")}>Home</button><button onClick={() => { setUser(null); localStorage.removeItem("cc-user"); setClips([]); setSel(0); setPage("home"); setActiveSong(null); setEnergy([]); setAnalysis(null); setSubmitted(false); setSubs([]); setConsensus([]); stopPlay(); }} style={{ ...bs(false), fontSize: 9, padding: "3px 8px" }}>Logout</button></div>
      </div>
      {notice && <div style={{ position: "fixed", top: 50, left: "50%", transform: "translateX(-50%)", background: "rgba(68,204,102,0.15)", border: "1px solid rgba(68,204,102,0.3)", color: "#44cc66", padding: "8px 20px", borderRadius: 8, fontSize: 12, fontFamily: "Fredoka, sans-serif", zIndex: 100 }}>{notice}</div>}
      {audioLoading && <div style={{ position: "fixed", top: 50, left: "50%", transform: "translateX(-50%)", background: "rgba(245,166,35,0.12)", border: "1px solid rgba(245,166,35,0.25)", color: "#F5A623", padding: "8px 20px", borderRadius: 8, fontSize: 12, fontFamily: "Fredoka, sans-serif", zIndex: 100 }}>Loading audio...</div>}

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 12px 80px", width: "calc(100% - 0px)", overflowX: "hidden", overflowY: "auto" }}>

        {/* HOME */}
        {page === "home" && <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{isLeader ? "Dashboard" : "Assigned Work"}</h2>
          
          {/* LEADER: Create Album */}
          {isLeader && <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 9, fontFamily: "Fredoka, sans-serif", color: "#555", marginBottom: 6, letterSpacing: 1 }}>CREATE ALBUM</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input type="text" value={newAlbumName} onChange={e => setNewAlbumName(e.target.value)} placeholder="Album name (e.g. Artist X - Untitled)" onKeyDown={e => { if (e.key === "Enter") handleCreateAlbum(); }} style={{ flex: 1, background: "rgba(245,230,200,0.04)", border: "1px solid rgba(245,230,200,0.1)", borderRadius: 8, padding: "10px 12px", color: "#F5E6C8", fontSize: 12, outline: "none" }} />
              <button onClick={handleCreateAlbum} disabled={!newAlbumName.trim()} style={{ ...bs(!!newAlbumName.trim()), padding: "8px 16px", fontSize: 12, fontWeight: 600, opacity: newAlbumName.trim() ? 1 : 0.3 }}>+ Album</button>
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
              {[["country","🤠"],["hiphop","🎤"],["pop","🎵"],["edm","🎧"],["rnb","🎶"],["rock","🎸"],["indie","🌿"],["latin","💃"]].map(([g, icon]) =>
                <button key={g} onClick={() => setSelectedGenre(selectedGenre === g ? null : g)} style={{
                  background: selectedGenre === g ? "rgba(245,166,35,0.12)" : "rgba(245,230,200,0.03)",
                  border: `1px solid ${selectedGenre === g ? "rgba(245,166,35,0.35)" : "rgba(245,230,200,0.07)"}`,
                  color: selectedGenre === g ? "#F5A623" : "#9B8B73",
                  padding: "4px 8px", borderRadius: 5, fontSize: 10, cursor: "pointer", fontFamily: "Fredoka, sans-serif"
                }}>{icon} {g}</button>
              )}
            </div>
          </div>}

          {/* ALBUMS LIST */}
          {albums.length > 0 && <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 9, fontFamily: "Fredoka, sans-serif", color: "#555", marginBottom: 8, letterSpacing: 1 }}>ALBUMS</div>
            <div style={{ display: "grid", gap: 8 }}>{albums.map(album => <div key={album.id} onClick={() => loadAlbum(album.id)} style={{ ...cs(false), display: "flex", alignItems: "center", gap: 10, overflow: "hidden" }}>
              <div style={{ width: 42, height: 42, borderRadius: 8, background: "linear-gradient(135deg,rgba(199,62,62,0.15),rgba(199,62,62,0.1))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>💿</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{album.name}</div>
                <div style={{ fontSize: 10, color: "#9B8B73", fontFamily: "Fredoka, sans-serif" }}>{album.track_count || 0} tracks{album.genre ? ` · ${album.genre}` : ""}</div>
              </div>
              {isLeader && <button onClick={ev => { ev.stopPropagation(); delAlbum(album.id); }} style={{ background: "rgba(199,62,62,0.05)", border: "1px solid rgba(199,62,62,0.1)", color: "#C73E3E", fontSize: 8, padding: "3px 7px", borderRadius: 4, cursor: "pointer", fontFamily: "Fredoka, sans-serif", flexShrink: 0 }}>Delete</button>}
              <div style={{ fontSize: 10, color: "#C73E3E", fontFamily: "Fredoka, sans-serif", flexShrink: 0 }}>Open →</div>
            </div>)}</div>
          </div>}

          {/* STANDALONE SONGS (not in albums) */}
          {isLeader && <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 9, fontFamily: "Fredoka, sans-serif", color: "#555", marginBottom: 6, letterSpacing: 1 }}>SINGLE SONGS</div>
            <div onDrop={handleUpload} onDragOver={e => e.preventDefault()} onClick={() => document.getElementById("fi2").click()} style={{ border: "2px dashed rgba(245,166,35,0.15)", borderRadius: 12, padding: "16px 12px", textAlign: "center", cursor: "pointer", background: "rgba(245,166,35,0.01)", marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Upload single song</div>
              <div style={{ fontSize: 9, color: "#9B8B73" }}>Drop file or click · MP3, WAV, M4A, AAC, OGG, FLAC</div>
              <input id="fi2" type="file" accept="audio/*" onChange={handleUpload} style={{ display: "none" }} />
            </div>
          </div>}
          {analyzing && <div style={{ textAlign: "center", padding: 30 }}><div style={{ width: 36, height: 36, border: "3px solid rgba(245,166,35,0.12)", borderTop: "3px solid #F5A623", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} /><div style={{ fontSize: 12, color: "#9B8B73" }}>Analyzing audio & checking viral database...</div></div>}
          
          {/* Standalone songs list */}
          {songs.filter(s => !s.album_id).length > 0 && <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 9, fontFamily: "Fredoka, sans-serif", color: "#9B8B73", marginBottom: 8, letterSpacing: 1 }}>SINGLES</div>
            <div style={{ display: "grid", gap: 8 }}>{songs.filter(s => !s.album_id).map(song => <div key={song.id} style={{ ...cs(false), display: "flex", alignItems: "center", gap: 10, overflow: "hidden" }} onClick={() => isLeader ? loadReview(song.id) : loadSubmit(song.id)}>
            <div style={{ width: 38, height: 38, borderRadius: 8, background: "linear-gradient(135deg,rgba(245,166,35,0.1),rgba(199,62,62,0.1))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>🎵</div>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.name}</div><div style={{ fontSize: 10, color: "#9B8B73", fontFamily: "Fredoka, sans-serif" }}>{song.duration > 0 ? `${fmt(song.duration)} · ~${song.bpm} BPM` : "pending"}</div></div>
            {isLeader && <button onClick={ev => { ev.stopPropagation(); delSong(song.id); }} style={{ background: "rgba(199,62,62,0.05)", border: "1px solid rgba(199,62,62,0.1)", color: "#C73E3E", fontSize: 8, padding: "3px 7px", borderRadius: 4, cursor: "pointer", fontFamily: "Fredoka, sans-serif", flexShrink: 0 }}>Delete</button>}
            <div style={{ fontSize: 10, color: "#F5A623", fontFamily: "Fredoka, sans-serif", flexShrink: 0, whiteSpace: "nowrap" }}>{isLeader ? "Review →" : "Submit →"}</div>
          </div>)}</div>
          </div>}
          
          {albums.length === 0 && songs.length === 0 && !analyzing && <div style={{ textAlign: "center", padding: 40, border: "1px dashed rgba(245,230,200,0.06)", borderRadius: 12 }}><div style={{ fontSize: 28, opacity: 0.3, marginBottom: 8 }}>📂</div><div style={{ color: "#555", fontSize: 12 }}>{isLeader ? "Create an album or upload a song to get started" : "No assignments yet"}</div></div>}
        </div>}

        {/* ALBUM VIEW */}
        {page === "album" && <div>
          <button onClick={() => { setPage("home"); setActiveAlbum(null); }} style={{ ...bs(false), marginBottom: 12, fontSize: 9 }}>← Back</button>
          {(() => { const album = albums.find(a => a.id === activeAlbum); if (!album) return null; return <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <div style={{ fontSize: 28 }}>💿</div>
              <div style={{ flex: 1 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{album.name}</h2>
                <div style={{ fontSize: 10, color: "#9B8B73", fontFamily: "Fredoka, sans-serif" }}>{albumSongs.length} tracks{album.genre ? ` · ${album.genre}` : ""}</div>
              </div>
            </div>

            {/* Member progress bar */}
            {!isLeader && albumProgress && <div style={{ background: "rgba(245,166,35,0.03)", border: "1px solid rgba(245,166,35,0.1)", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#F5A623" }}>Your Progress</span>
                <span style={{ fontSize: 12, fontWeight: 800, color: albumProgress.completed === albumProgress.total ? "#44cc66" : "#F5A623", fontFamily: "Fredoka, sans-serif" }}>{albumProgress.completed}/{albumProgress.total}</span>
              </div>
              <div style={{ height: 6, background: "rgba(245,230,200,0.06)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${albumProgress.total > 0 ? (albumProgress.completed / albumProgress.total) * 100 : 0}%`, height: "100%", background: albumProgress.completed === albumProgress.total ? "linear-gradient(90deg,#44cc66,#00cc66)" : "linear-gradient(90deg,#F5A623,#C73E3E)", borderRadius: 3, transition: "width 0.3s" }} />
              </div>
              {albumProgress.completed === albumProgress.total && albumProgress.total > 0 && <div style={{ fontSize: 10, color: "#44cc66", marginTop: 4, textAlign: "center", fontWeight: 600 }}>✓ All songs completed!</div>}
            </div>}

            {/* Leader: team progress */}
            {isLeader && Object.keys(albumTeamProgress).length > 0 && <div style={{ background: "rgba(199,62,62,0.03)", border: "1px solid rgba(199,62,62,0.1)", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
              <div style={{ fontSize: 9, fontFamily: "Fredoka, sans-serif", color: "#C73E3E", letterSpacing: 1, marginBottom: 6 }}>TEAM PROGRESS</div>
              {Object.entries(albumTeamProgress).map(([name, p]) => <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: "#ccc", minWidth: 60 }}>{name}</span>
                <div style={{ flex: 1, height: 4, background: "rgba(245,230,200,0.06)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${p.total > 0 ? (p.completed / p.total) * 100 : 0}%`, height: "100%", background: p.completed === p.total ? "#44cc66" : "#C73E3E", borderRadius: 2 }} />
                </div>
                <span style={{ fontSize: 10, fontFamily: "Fredoka, sans-serif", color: p.completed === p.total ? "#44cc66" : "#aaa" }}>{p.completed}/{p.total}</span>
              </div>)}
            </div>}

            {/* Leader: add songs to album */}
            {isLeader && <div style={{ marginBottom: 16 }}>
              <div onDrop={handleAlbumUpload} onDragOver={e => e.preventDefault()} onClick={() => document.getElementById("fi-album").click()} style={{ border: "2px dashed rgba(199,62,62,0.2)", borderRadius: 10, padding: "16px 12px", textAlign: "center", cursor: "pointer", background: "rgba(199,62,62,0.02)" }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Add songs to album</div>
                <div style={{ fontSize: 9, color: "#9B8B73" }}>Select multiple files, or drop a .zip · MP3, WAV, M4A, AAC, OGG, FLAC</div>
                <input id="fi-album" type="file" accept="audio/*,.zip" multiple onChange={handleAlbumUpload} style={{ display: "none" }} />
              </div>
              {albumUploading && <div style={{ textAlign: "center", padding: 12, marginTop: 8 }}>
                <div style={{ width: 30, height: 30, border: "3px solid rgba(199,62,62,0.12)", borderTop: "3px solid #C73E3E", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 8px" }} />
                <div style={{ fontSize: 11, color: "#C73E3E", fontFamily: "Fredoka, sans-serif" }}>{albumUploadProgress}</div>
              </div>}
            </div>}

            {/* Song list */}
            <div style={{ fontSize: 9, fontFamily: "Fredoka, sans-serif", color: "#555", marginBottom: 8, letterSpacing: 1 }}>TRACKLIST</div>
            {albumSongs.length === 0 && <div style={{ textAlign: "center", padding: 30, border: "1px dashed rgba(245,230,200,0.06)", borderRadius: 8 }}><div style={{ color: "#555", fontSize: 12 }}>No songs yet — upload audio files above</div></div>}
            <div style={{ display: "grid", gap: 6 }}>{albumSongs.map((song, idx) => {
              const isComplete = !isLeader && albumProgress?.completedIds?.includes(song.id);
              const isEditing = editingSongId === song.id;
              return <div key={song.id} style={{ ...cs(false), display: "flex", alignItems: "center", gap: 8, overflow: "hidden", opacity: isComplete ? 0.6 : 1 }} onClick={() => { if (isEditing) return; isLeader ? loadReview(song.id) : loadSubmit(song.id); }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: isComplete ? "#44cc66" : "#555", fontFamily: "Fredoka, sans-serif", minWidth: 24, textAlign: "center" }}>{isComplete ? "✓" : `${idx + 1}.`}</div>
                {isEditing ? <input type="text" value={editingSongName} onChange={e => setEditingSongName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") renameSong(song.id, editingSongName); if (e.key === "Escape") { setEditingSongId(null); } }} onClick={e => e.stopPropagation()} autoFocus style={{ flex: 1, background: "rgba(245,230,200,0.06)", border: "1px solid rgba(245,166,35,0.3)", borderRadius: 5, padding: "6px 10px", color: "#F5E6C8", fontSize: 12, outline: "none" }} />
                : <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.name}</div>
                  <div style={{ fontSize: 9, color: "#9B8B73", fontFamily: "Fredoka, sans-serif" }}>{song.duration > 0 ? fmt(song.duration) : "—"}</div>
                </div>}
                {isLeader && !isEditing && <button onClick={ev => { ev.stopPropagation(); setEditingSongId(song.id); setEditingSongName(song.name); }} style={{ background: "rgba(245,230,200,0.03)", border: "1px solid rgba(245,230,200,0.07)", color: "#9B8B73", fontSize: 8, padding: "3px 6px", borderRadius: 3, cursor: "pointer", fontFamily: "Fredoka, sans-serif", flexShrink: 0 }}>✏️</button>}
                {isLeader && <button onClick={ev => { ev.stopPropagation(); delSong(song.id); }} style={{ background: "rgba(199,62,62,0.05)", border: "1px solid rgba(199,62,62,0.1)", color: "#C73E3E", fontSize: 8, padding: "3px 6px", borderRadius: 4, cursor: "pointer", flexShrink: 0 }}>✕</button>}
                <div style={{ fontSize: 9, color: "#F5A623", fontFamily: "Fredoka, sans-serif", flexShrink: 0 }}>{isLeader ? "Review →" : isComplete ? "Done" : "Cut →"}</div>
              </div>;
            })}</div>
          </>; })()}
        </div>}

        {/* LEADER: ANALYZE */}
        {page === "analyze" && isLeader && <div>
          <button onClick={goBack} style={{ ...bs(false), marginBottom: 12, fontSize: 9 }}>← Back</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "9px 12px", background: "rgba(245,230,200,0.025)", borderRadius: 8, marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 11 }}>{activeSongData?.name}</div>
            <div style={{ fontFamily: "Fredoka, sans-serif", fontSize: 9, color: "#9B8B73" }}>{analysis && `${fmt(analysis.duration)} · ~${analysis.bpm} BPM`} · {clips.length} clips</div>
            <div style={{ marginLeft: "auto" }}><button onClick={() => loadReview(activeSong)} style={bs(true)}>Team Review →</button></div>
          </div>
          <div style={{ background: "rgba(245,166,35,0.02)", border: "1px solid rgba(245,166,35,0.06)", borderRadius: 7, padding: "7px 11px", marginBottom: 12, fontSize: 10, color: "#F5A623" }}>🔒 AI analysis is private — your team won't see these</div>
          {viralInfo && viralInfo.matches && viralInfo.matches.length > 0 && <div style={{ background: "linear-gradient(135deg,rgba(245,166,35,0.06),rgba(212,148,28,0.04))", border: "1px solid rgba(245,166,35,0.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 14 }}>🔥</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#F5A623" }}>Viral Intelligence</span>
              <span style={{ fontSize: 8, fontFamily: "Fredoka, sans-serif", color: "#D4941C", background: "rgba(212,148,28,0.1)", padding: "1px 6px", borderRadius: 3 }}>{viralInfo.matchType === 'exact' ? 'MATCH' : 'SIMILAR'}</span>
            </div>
            <div style={{ fontSize: 10, color: "#ccc", marginBottom: 4 }}>
              Found <strong style={{ color: "#F5A623" }}>{viralInfo.matches.length}</strong> trending TikTok sound{viralInfo.matches.length > 1 ? 's' : ''} matching this song
            </div>
            {viralInfo.topMatch && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 9, fontFamily: "Fredoka, sans-serif", color: "#aaa" }}>
              <span>🎵 "{viralInfo.topMatch.title}" by {viralInfo.topMatch.artist}</span>
              {viralInfo.topMatch.usage_count > 0 && <span style={{ color: "#D4941C" }}>📊 {viralInfo.topMatch.usage_count.toLocaleString()} TikToks</span>}
              {viralInfo.topMatch.sound_duration > 0 && <span>⏱ {Math.round(viralInfo.topMatch.sound_duration)}s clip</span>}
              {viralInfo.topMatch.sub_genre && <span style={{ color: "#C73E3E" }}>🏷 {viralInfo.topMatch.sub_genre}</span>}
            </div>}
          </div>}
          {viralInfo?.positionPattern && <div style={{ background: "linear-gradient(135deg,rgba(245,166,35,0.04),rgba(199,62,62,0.03))", border: "1px solid rgba(245,166,35,0.15)", borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 14 }}>🧠</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#F5A623" }}>Learned Pattern: {viralInfo.genre}</span>
              <span style={{ fontSize: 8, fontFamily: "Fredoka, sans-serif", color: "#44cc66", background: "rgba(68,204,102,0.1)", padding: "1px 6px", borderRadius: 3 }}>{viralInfo.positionPattern.sample_size} SONGS ANALYZED</span>
            </div>
            <div style={{ fontSize: 10, color: "#ccc", marginBottom: 4 }}>
              Viral {viralInfo.genre} clips start avg <strong style={{ color: "#F5A623" }}>{viralInfo.positionPattern.avg_start_position_pct}%</strong> through the song
              <span style={{ color: "#9B8B73" }}> (range: {viralInfo.positionPattern.position_range?.min}–{viralInfo.positionPattern.position_range?.max}%)</span>
            </div>
            <div style={{ fontSize: 9, color: "#999" }}>
              💡 AI clip scoring boosted for positions matching this pattern
            </div>
          </div>}
          {viralInfo && !viralInfo.positionPattern && (!viralInfo.matches || viralInfo.matches.length === 0) && <div style={{ background: "rgba(245,230,200,0.015)", border: "1px solid rgba(245,230,200,0.04)", borderRadius: 7, padding: "7px 11px", marginBottom: 12, fontSize: 9, color: "#9B8B73" }}>
            🔍 No genre selected — using waveform analysis only. Go back and select a genre for smarter AI suggestions.
          </div>}
          {hasAudio && <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, flexWrap: "wrap", gap: 6 }}>
              <button onClick={() => createClip(lastTapTime || (playheadTime || 0), null)} style={{ background: "linear-gradient(135deg,rgba(245,166,35,0.15),rgba(245,166,35,0.05))", border: "1px solid rgba(245,166,35,0.3)", color: "#F5A623", fontSize: 10, fontWeight: 600, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "Fredoka, sans-serif" }}>+ New Clip</button>
              <div style={{ display: "flex", gap: 3 }}><span style={{ fontSize: 8, fontFamily: "Fredoka, sans-serif", color: "#555" }}>Default:</span>{[15, 30, 60].map(d => <button key={d} onClick={() => setDefDur(d)} style={{ ...bs(defDur === d), padding: "2px 7px", fontSize: 9 }}>{d}s</button>)}</div>
            </div>
            <Waveform energy={energy} duration={analysis.duration} clips={clips} highlights={viralInfo?.positionPattern ? [{ startTime: analysis.duration * (viralInfo.positionPattern.position_range?.min || 0) / 100, endTime: analysis.duration * (viralInfo.positionPattern.position_range?.max || 100) / 100, color: "rgba(245,166,35,0.06)", label: `🔥 ${viralInfo.genre} viral zone`, lc: "rgba(245,166,35,0.4)" }, { startTime: analysis.duration * viralInfo.positionPattern.avg_start_position_pct / 100 - 2, endTime: analysis.duration * viralInfo.positionPattern.avg_start_position_pct / 100 + 2, color: "rgba(245,166,35,0.15)", label: "", lc: "" }] : []} selClip={sel} onSel={setSel} onCreate={createClip} onEdge={dragEdge} onMove={moveClip} zoom={zoom || [0, analysis.duration]} onZoom={setZoom} readonly={false} onPlayFrom={t => { setLastTapTime(t); playFull(t); }} playheadTime={playheadTime} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 4 }}>
              <button onClick={() => playFull(0)} style={{ width: 32, height: 32, borderRadius: "50%", background: playingFull ? "linear-gradient(135deg,#C73E3E,#ff6644)" : "linear-gradient(135deg,#F5A623,#0088aa)", border: "none", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{playingFull ? "■" : "▶"}</button>
              <div style={{ flex: 1, height: 3, background: "rgba(245,230,200,0.06)", borderRadius: 2, overflow: "hidden" }}><div style={{ width: `${fullProgress * 100}%`, height: "100%", background: "linear-gradient(90deg,#F5A623,#C73E3E)", transition: "width 0.1s linear" }} /></div>
              <span style={{ fontSize: 10, fontFamily: "Fredoka, sans-serif", color: "#9B8B73" }}>{playheadTime != null ? fmt(playheadTime) : "0:00"} / {fmt(analysis.duration)}</span>
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 2 }}><button onClick={() => setZoom(null)} style={{ ...bs(!zoom), padding: "2px 8px", fontSize: 8 }}>Full Track</button>{selC && <button onClick={() => setZoom([Math.max(0, selC.startTime - 3), Math.min(analysis.duration, selC.endTime + 3)])} style={{ ...bs(false), padding: "2px 8px", fontSize: 8 }}>Zoom Selected</button>}</div>
          </div>}
          {ab && <div style={{ background: "rgba(199,62,62,0.05)", border: "1px solid rgba(199,62,62,0.15)", borderRadius: 7, padding: "8px 12px", marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><span style={{ fontSize: 10, color: "#C73E3E", fontWeight: 600, fontFamily: "Fredoka, sans-serif" }}>A/B</span><button onClick={() => playClip(ab.a)} style={{ ...bs(playing && sel === ab.a), padding: "4px 12px" }}>▶ A ({fmt(clips[ab.a]?.startTime)})</button><span style={{ color: "#444", fontSize: 10 }}>vs</span><button onClick={() => playClip(ab.b)} style={{ ...bs(playing && sel === ab.b), padding: "4px 12px" }}>▶ B ({fmt(clips[ab.b]?.startTime)})</button><button onClick={() => { stopPlay(); setAb(null); }} style={{ marginLeft: "auto", background: "rgba(245,230,200,0.04)", border: "1px solid rgba(245,230,200,0.08)", color: "#9B8B73", fontSize: 9, padding: "3px 8px", borderRadius: 4, cursor: "pointer" }}>✕</button></div>}
          {clips.length > 0 && <div style={{ display: "flex", gap: 5, marginBottom: 12, alignItems: "center" }}><button onClick={expAll} style={{ background: "linear-gradient(135deg,rgba(245,166,35,0.1),rgba(199,62,62,0.06))", border: "1px solid rgba(245,166,35,0.18)", color: "#F5A623", fontSize: 10, fontWeight: 600, padding: "7px 14px", borderRadius: 6, cursor: "pointer", fontFamily: "Fredoka, sans-serif" }}>⬇ Download All {clips.length}</button>{Object.keys(dl).length > 0 && <span style={{ fontSize: 9, color: "#44cc66", fontFamily: "Fredoka, sans-serif" }}>✓ {Object.keys(dl).length}/{clips.length}</span>}</div>}
          <div style={{ display: "grid", gap: 7, marginBottom: 20 }}>{clips.map((c, idx) => <ClipCard key={c.id || idx} c={c} idx={idx} sel={sel} playing={playing} isModified={isModified(c)} bs={bs} onSel={setSel} onPlay={playClip} onExport={expClip} onDur={setClipDur} onNote={updateNote} onAB={startAB} onRevert={revertClip} onDel={delClip} editNote={editNote} setEditNote={setEditNote} ab={ab} clips={clips} />)}</div>
        </div>}

        {/* LEADER: REVIEW */}
        {page === "review" && isLeader && <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <button onClick={goBack} style={{ ...bs(false), fontSize: 9 }}>← Back</button>
            {(() => { const nav = albumSongNav(); if (!nav) return null; return <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
              {nav.prev && <button onClick={() => goToAlbumSong(nav.prev.id)} style={{ ...bs(false), fontSize: 9, padding: "4px 10px" }}>← Prev</button>}
              <span style={{ fontSize: 9, color: "#9B8B73", fontFamily: "Fredoka, sans-serif" }}>{nav.idx + 1}/{nav.total}</span>
              {nav.next && <button onClick={() => goToAlbumSong(nav.next.id)} style={{ ...bs(true), fontSize: 9, padding: "4px 10px" }}>Next →</button>}
            </div>; })()}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
            <div><h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 2 }}>Team Review — {activeSongData?.name}</h2><p style={{ color: "#9B8B73", fontSize: 11, margin: 0 }}>{subs.length} submission{subs.length !== 1 ? "s" : ""} · updates live</p></div>
            <button onClick={refreshSubs} style={bs(false)}>↻ Refresh</button>
          </div>
          {consensus.length > 0 && <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, fontFamily: "Fredoka, sans-serif", color: "#44cc66", letterSpacing: 2, marginBottom: 8 }}>CONSENSUS CLIPS</div>
            <div style={{ display: "grid", gap: 8 }}>{consensus.map((c, idx) => <div key={idx} style={{ ...cs(false), borderColor: c.agreement >= 0.7 ? "rgba(68,204,102,0.2)" : c.agreement >= 0.4 ? "rgba(245,166,35,0.15)" : "rgba(245,230,200,0.04)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: c.agreement >= 0.7 ? "#44cc66" : c.agreement >= 0.4 ? "#F5A623" : "#9B8B73" }}>C{idx + 1}</div>
                <div style={{ flex: "1 1 150px", minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{fmt(c.startTime)} → {fmt(c.endTime)} <span style={{ color: "#9B8B73", fontWeight: 400 }}>({c.dur}s)</span></div><div style={{ fontSize: 10, color: "#9B8B73", marginTop: 2 }}>Picked by: {c.members.join(", ")}</div></div>
                <div style={{ minWidth: 80 }}><AgreementBar count={c.memberCount} total={c.total} /></div>
                {hasAudio && <button onClick={() => { if (playing && activeRange === `c${idx}`) stopPlay(); else playRange(c.startTime, c.endTime, `c${idx}`); }} style={{ width: 28, height: 28, borderRadius: "50%", background: playing && activeRange === `c${idx}` ? "linear-gradient(135deg,#C73E3E,#ff6644)" : "linear-gradient(135deg,#44cc66,#228844)", border: "none", color: "#fff", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{playing && activeRange === `c${idx}` ? "■" : "▶"}</button>}
                {hasAudio && <button onClick={() => expRange(c.startTime, c.endTime, `consensus${idx + 1}`)} style={{ ...bs(false), padding: "3px 8px", fontSize: 9, flexShrink: 0 }}>⬇</button>}
              </div>
              <div style={{ paddingLeft: 26, fontSize: 10, color: "#555" }}>{c.picks.map((p, i) => <span key={i} style={{ marginRight: 10 }}>{p.member}: {fmt(p.startTime)}–{fmt(p.endTime)}</span>)}</div>
            </div>)}</div>
          </div>}
          {hasAudio && <div style={{ marginBottom: 20 }}>
            <Waveform energy={energy} duration={analysis.duration} clips={clips} highlights={[...consensus.map((c, i) => ({ startTime: c.startTime, endTime: c.endTime, color: c.agreement >= 0.7 ? "rgba(68,204,102,0.1)" : "rgba(245,166,35,0.06)", label: `C${i + 1} (${c.memberCount}/${c.total})`, lc: c.agreement >= 0.7 ? "rgba(68,204,102,0.5)" : "rgba(245,166,35,0.4)" })), ...(showIndiv ? subs.flatMap(s => (s.clips || []).map(c => ({ startTime: c.startTime, endTime: c.endTime, color: "rgba(199,62,62,0.04)", label: "" }))) : [])]} selClip={sel} onSel={setSel} onCreate={createClip} onEdge={dragEdge} onMove={moveClip} zoom={zoom || [0, analysis.duration]} onZoom={setZoom} readonly={false} onPlayFrom={t => { setLastTapTime(t); playFull(t); }} playheadTime={playheadTime} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 4 }}>
              <button onClick={() => playFull(0)} style={{ width: 32, height: 32, borderRadius: "50%", background: playingFull ? "linear-gradient(135deg,#C73E3E,#ff6644)" : "linear-gradient(135deg,#F5A623,#0088aa)", border: "none", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{playingFull ? "■" : "▶"}</button>
              <div style={{ flex: 1, height: 3, background: "rgba(245,230,200,0.06)", borderRadius: 2, overflow: "hidden" }}><div style={{ width: `${fullProgress * 100}%`, height: "100%", background: "linear-gradient(90deg,#F5A623,#C73E3E)", transition: "width 0.1s linear" }} /></div>
              <span style={{ fontSize: 10, fontFamily: "Fredoka, sans-serif", color: "#9B8B73" }}>{playheadTime != null ? fmt(playheadTime) : "0:00"} / {fmt(analysis.duration)}</span>
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 2 }}><button onClick={() => setZoom(null)} style={{ ...bs(!zoom), padding: "2px 8px", fontSize: 8 }}>Full</button><button onClick={() => setShowIndiv(!showIndiv)} style={{ ...bs(showIndiv), padding: "2px 8px", fontSize: 8 }}>{showIndiv ? "Hide" : "Show"} Individual</button></div>
          </div>}
          {clips.length > 0 && <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", gap: 5, marginBottom: 8, alignItems: "center" }}><div style={{ fontSize: 10, fontFamily: "Fredoka, sans-serif", color: "#F5A623", letterSpacing: 2 }}>YOUR CLIPS (AI + CUSTOM)</div><div style={{ marginLeft: "auto", display: "flex", gap: 5 }}><button onClick={handleSaveLeaderClips} style={{ ...bs(dirty), padding: "4px 12px", fontSize: 9, borderColor: dirty ? "rgba(68,204,102,0.4)" : undefined, color: dirty ? "#44cc66" : undefined }}>{dirty ? "● Save Clips" : "Saved"}</button>{hasAudio && <button onClick={expAll} style={{ ...bs(true), padding: "4px 12px", fontSize: 9 }}>⬇ Download All</button>}</div></div>
            <div style={{ display: "grid", gap: 7 }}>{clips.map((c, idx) => <ClipCard key={c.id || idx} c={c} idx={idx} sel={sel} playing={playing} isModified={isModified(c)} bs={bs} onSel={setSel} onPlay={playClip} onExport={expClip} onDur={setClipDur} onNote={updateNote} onAB={startAB} onRevert={revertClip} onDel={delClip} editNote={editNote} setEditNote={setEditNote} ab={ab} clips={clips} />)}</div>
          </div>}
          <div style={{ fontSize: 10, fontFamily: "Fredoka, sans-serif", color: "#C73E3E", letterSpacing: 2, marginBottom: 8 }}>INDIVIDUAL SUBMISSIONS</div>
          {subs.length === 0 && <div style={{ color: "#555", fontSize: 12, padding: 20, textAlign: "center", border: "1px dashed rgba(245,230,200,0.06)", borderRadius: 8 }}>Waiting for team picks...</div>}
          <div style={{ display: "grid", gap: 8 }}>{subs.map((sub, si) => <div key={si} style={{ ...cs(false) }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}><div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg,rgba(199,62,62,0.2),rgba(245,166,35,0.1))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#C73E3E" }}>{sub.member.charAt(0).toUpperCase()}</div><div style={{ fontWeight: 600, fontSize: 12 }}>{sub.member}</div><div style={{ fontSize: 9, color: "#555", fontFamily: "Fredoka, sans-serif", marginLeft: "auto" }}>{sub.clips.length} clips</div></div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingLeft: 36 }}>{(sub.clips || []).map((c, ci) => <div key={ci} onClick={() => hasAudio && playRange(c.startTime, c.endTime)} style={{ background: "rgba(245,230,200,0.03)", border: "1px solid rgba(245,230,200,0.06)", borderRadius: 6, padding: "4px 10px", fontSize: 10, fontFamily: "Fredoka, sans-serif", color: "#aaa", cursor: hasAudio ? "pointer" : "default" }}>{hasAudio && <span style={{ marginRight: 4 }}>▶</span>}{fmt(c.startTime)}–{fmt(c.endTime)} ({c.dur}s)</div>)}</div>
          </div>)}</div>
        </div>}

        {/* MEMBER: SUBMIT */}
        {page === "submit" && !isLeader && <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <button onClick={goBack} style={{ ...bs(false), fontSize: 9 }}>← Back</button>
            {(() => { const nav = albumSongNav(); if (!nav) return null; return <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
              {nav.prev && <button onClick={() => goToAlbumSong(nav.prev.id)} style={{ ...bs(false), fontSize: 9, padding: "4px 10px" }}>← Prev</button>}
              <span style={{ fontSize: 9, color: "#9B8B73", fontFamily: "Fredoka, sans-serif" }}>{nav.idx + 1}/{nav.total}</span>
              {nav.next && <button onClick={() => goToAlbumSong(nav.next.id)} style={{ ...bs(true), fontSize: 9, padding: "4px 10px" }}>Next →</button>}
            </div>; })()}
          </div>
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{activeSongData?.name}</h2>
          <p style={{ color: "#9B8B73", fontSize: 11, marginBottom: 16 }}>Pick 3-5 clips you think would go viral on TikTok</p>
          {!hasAudio && !audioLoading && <div style={{ marginBottom: 16 }}>
            {!activeSongData?.audio_path && <div onDrop={e => { e.preventDefault(); loadAudioFromFile(e); }} onDragOver={e => e.preventDefault()} onClick={() => document.getElementById("fi3").click()} style={{ border: "2px dashed rgba(245,166,35,0.15)", borderRadius: 10, padding: "20px 16px", textAlign: "center", cursor: "pointer", background: "rgba(245,166,35,0.01)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>Drop or select the audio file</div>
              <div style={{ fontSize: 10, color: "#9B8B73" }}>MP3, WAV, M4A, AAC, OGG, FLAC</div>
              <input id="fi3" type="file" accept="audio/*" onChange={loadAudioFromFile} style={{ display: "none" }} />
            </div>}
          </div>}
          {audioLoading && <div style={{ textAlign: "center", padding: 30 }}><div style={{ width: 36, height: 36, border: "3px solid rgba(245,166,35,0.12)", borderTop: "3px solid #F5A623", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} /><div style={{ fontSize: 12, color: "#9B8B73" }}>Loading song...</div></div>}
          {hasAudio && <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, flexWrap: "wrap", gap: 4 }}>
              <button onClick={() => createClip(lastTapTime || (playheadTime || 0), null)} style={{ background: "linear-gradient(135deg,rgba(245,166,35,0.15),rgba(245,166,35,0.05))", border: "1px solid rgba(245,166,35,0.3)", color: "#F5A623", fontSize: 11, fontWeight: 600, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontFamily: "Fredoka, sans-serif" }}>+ New Clip {lastTapTime > 0 || playheadTime ? `at ${fmt(lastTapTime || playheadTime || 0)}` : ""}</button>
              <div style={{ display: "flex", gap: 2 }}>{[15, 30, 60].map(d => <button key={d} onClick={() => setDefDur(d)} style={{ ...bs(defDur === d), padding: "2px 7px", fontSize: 9 }}>{d}s</button>)}</div>
            </div>
            <Waveform energy={energy} duration={analysis.duration} clips={clips} highlights={[]} selClip={sel} onSel={setSel} onCreate={createClip} onEdge={dragEdge} onMove={moveClip} zoom={zoom || [0, analysis.duration]} onZoom={setZoom} readonly={false} onPlayFrom={t => { setLastTapTime(t); playFull(t); }} playheadTime={playheadTime} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 4 }}>
              <button onClick={() => playFull(0)} style={{ width: 32, height: 32, borderRadius: "50%", background: playingFull ? "linear-gradient(135deg,#C73E3E,#ff6644)" : "linear-gradient(135deg,#F5A623,#0088aa)", border: "none", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{playingFull ? "■" : "▶"}</button>
              <div style={{ flex: 1, height: 3, background: "rgba(245,230,200,0.06)", borderRadius: 2, overflow: "hidden" }}><div style={{ width: `${fullProgress * 100}%`, height: "100%", background: "linear-gradient(90deg,#F5A623,#C73E3E)", transition: "width 0.1s linear" }} /></div>
              <span style={{ fontSize: 10, fontFamily: "Fredoka, sans-serif", color: "#9B8B73" }}>{playheadTime != null ? fmt(playheadTime) : "0:00"} / {fmt(analysis.duration)}</span>
            </div>
            <div style={{ fontSize: 9, fontFamily: "Fredoka, sans-serif", color: "#555", margin: "8px 0 6px", letterSpacing: 1 }}>YOUR PICKS ({clips.length}/5)</div>
            {clips.length === 0 && <div style={{ textAlign: "center", padding: 20, border: "1px dashed rgba(245,230,200,0.06)", borderRadius: 8, marginBottom: 12 }}><div style={{ fontSize: 10, color: "#9B8B73" }}>Tap the waveform to set position, then tap "+ New Clip"</div></div>}
            <div style={{ display: "grid", gap: 6, marginBottom: 16 }}>{clips.map((c, idx) => <div key={c.id} onClick={() => setSel(idx)} style={{ ...cs(idx === sel) }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#F5A623", minWidth: 20 }}>✎</div>
                <div style={{ flex: "1 1 120px", fontSize: 11, minWidth: 0 }}>{fmt(c.startTime)} → {fmt(c.endTime)} <span style={{ color: "#9B8B73" }}>({c.dur}s)</span></div>
                <div style={{ display: "flex", gap: 2 }}>{[15, 30, 60].map(d => <button key={d} onClick={e => { e.stopPropagation(); setClipDur(idx, d); }} style={{ ...bs(c.dur === d), padding: "2px 5px", fontSize: 8 }}>{d}s</button>)}</div>
                <button onClick={e => { e.stopPropagation(); playClip(idx); }} style={{ width: 26, height: 26, borderRadius: "50%", background: playing && sel === idx ? "linear-gradient(135deg,#C73E3E,#ff6644)" : "linear-gradient(135deg,#F5A623,#0088aa)", border: "none", color: "#fff", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{playing && sel === idx ? "■" : "▶"}</button>
                {submitted ? <button onClick={e => { e.stopPropagation(); retractClip(idx); }} style={{ background: "rgba(212,148,28,0.08)", border: "1px solid rgba(212,148,28,0.2)", color: "#D4941C", fontSize: 8, padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontFamily: "Fredoka, sans-serif" }}>Retract</button> : <button onClick={e => { e.stopPropagation(); delClip(idx); }} style={{ background: "rgba(199,62,62,0.05)", border: "1px solid rgba(199,62,62,0.1)", color: "#C73E3E", fontSize: 8, padding: "3px 6px", borderRadius: 4, cursor: "pointer" }}>✕</button>}
              </div>
              {idx === sel && <input type="text" placeholder="Add a note..." value={c.notes || ""} onChange={e => { e.stopPropagation(); updateNote(idx, e.target.value); }} onClick={e => e.stopPropagation()} style={{ width: "100%", marginTop: 6, background: "rgba(245,230,200,0.03)", border: "1px solid rgba(245,230,200,0.07)", borderRadius: 4, padding: "5px 8px", color: "#ccc", fontSize: 10, outline: "none", boxSizing: "border-box" }} />}
            </div>)}</div>
            {submitted && <div style={{ background: "rgba(68,204,102,0.08)", border: "1px solid rgba(68,204,102,0.2)", borderRadius: 8, padding: "10px 14px", textAlign: "center", color: "#44cc66", fontSize: 13, fontWeight: 600, marginBottom: 8 }}>✓ Submitted! Retract individual clips above or add more below.</div>}
            {clips.length < 2 && !submitted && <div style={{ fontSize: 10, color: "#D4941C", fontFamily: "Fredoka, sans-serif", textAlign: "center", marginBottom: 6 }}>Add at least 2 clips to submit</div>}
            <button onClick={submitMyPicks} disabled={clips.length < 2} style={{ ...bs(clips.length >= 2), padding: "10px 24px", fontSize: 13, fontWeight: 600, opacity: clips.length < 2 ? 0.3 : 1, width: "100%", cursor: clips.length < 2 ? "not-allowed" : "pointer" }}>{submitted ? "Update Submission" : `Submit ${clips.length} Pick${clips.length !== 1 ? "s" : ""}`}</button>
          </div>}
        </div>}
      </div>

      {playing && <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: 3, zIndex: 100, background: "rgba(245,166,35,0.1)" }}><div style={{ height: "100%", width: `${progress * 100}%`, background: "linear-gradient(90deg,#F5A623,#C73E3E)", transition: "width 0.1s linear" }} /></div>}
      {page !== "home" && <img src="/mascot.png?v=2" alt="" style={{ position: "fixed", bottom: 12, right: 12, width: 90, height: "auto", opacity: 0.2, pointerEvents: "none", zIndex: 10, filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.4))" }} />}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}*{box-sizing:border-box}button:hover{filter:brightness(1.15)}input:focus{border-color:rgba(245,166,35,0.3)!important}html{overflow-x:hidden;width:100%;height:100%}body{margin:0;padding:0;overflow-x:hidden;width:100%;max-width:100%;-webkit-text-size-adjust:100%}canvas{display:block;max-width:100%}input,button{max-width:100%}#__next{overflow-x:hidden;width:100%}::selection{background:rgba(245,166,35,0.3);color:#F5E6C8}`}</style>
      </div>
    </div>
  );
}

function SetupForm({ onSetup }) {
  const [name, setName] = useState(""), [role, setRole] = useState(null), [code, setCode] = useState(""), [codeErr, setCodeErr] = useState(false);
  const handleSubmit = () => {
    if (!name.trim() || !role) return;
    if (role === "leader" && code !== "1234") { setCodeErr(true); return; }
    onSetup(name, role);
  };
  return <div>
    <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name (e.g. Dylan)" autoFocus style={{ width: "100%", background: "rgba(245,230,200,0.05)", border: "1px solid rgba(245,230,200,0.12)", borderRadius: 8, padding: "12px 14px", color: "#F5E6C8", fontSize: 14, outline: "none", marginBottom: 16, fontFamily: "DM Sans, sans-serif" }} />
    <div style={{ fontSize: 12, color: "#9B8B73", marginBottom: 8, fontFamily: "Fredoka, sans-serif", letterSpacing: 1, textTransform: "uppercase" }}>I am a:</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
      {[["leader", "👑", "Team Lead", "#C73E3E", "Upload, analyze, review picks"], ["member", "🎧", "Team Member", "#F5A623", "Listen & submit clip picks"]].map(([r, icon, title, color, desc]) =>
        <div key={r} onClick={() => { setRole(r); setCodeErr(false); }} style={{ background: role === r ? `${color}15` : "rgba(245,230,200,0.02)", border: `2px solid ${role === r ? `${color}66` : "rgba(245,230,200,0.06)"}`, borderRadius: 12, padding: 16, cursor: "pointer", textAlign: "center", transition: "all 0.2s" }}>
          <div style={{ fontSize: 24, marginBottom: 6 }}>{icon}</div>
          <div style={{ fontWeight: 700, fontSize: 14, color: role === r ? color : "#D4C4A8", fontFamily: "Fredoka, sans-serif", letterSpacing: 1 }}>{title}</div>
          <div style={{ fontSize: 10, color: "#9B8B73", marginTop: 4, fontFamily: "DM Sans, sans-serif" }}>{desc}</div>
        </div>
      )}
    </div>
    {role === "leader" && <div style={{ marginBottom: 16 }}>
      <input type="password" value={code} onChange={e => { setCode(e.target.value); setCodeErr(false); }} placeholder="Enter leader code" style={{ width: "100%", background: "rgba(245,230,200,0.05)", border: `1px solid ${codeErr ? "rgba(199,62,62,0.5)" : "rgba(245,230,200,0.12)"}`, borderRadius: 8, padding: "12px 14px", color: "#F5E6C8", fontSize: 14, outline: "none", fontFamily: "DM Sans, sans-serif" }} />
      {codeErr && <div style={{ fontSize: 10, color: "#C73E3E", marginTop: 4, fontFamily: "Fredoka, sans-serif" }}>Incorrect code</div>}
    </div>}
    <button onClick={handleSubmit} disabled={!name.trim() || !role} style={{ width: "100%", padding: "12px", borderRadius: 8, border: "2px solid rgba(245,166,35,0.3)", fontSize: 15, fontWeight: 600, cursor: "pointer", background: name.trim() && role ? "linear-gradient(135deg,#F5A623,#D4941C)" : "rgba(245,230,200,0.05)", color: name.trim() && role ? "#000000" : "#555", fontFamily: "Fredoka, sans-serif", letterSpacing: 1, textTransform: "uppercase" }}>Get Started</button>
  </div>;
}
