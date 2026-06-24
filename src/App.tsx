/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, Square, Upload, Copy, Check, FileAudio, Loader2, Trash2, History, Clock, ChevronDown, LogOut, User, Download, Pencil, X, Search, Share2, Sparkles } from "lucide-react";
import { onAuthStateChanged, signOut, type User as FirebaseUser } from "firebase/auth";
import { collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, limit, writeBatch } from "firebase/firestore";
import { auth, db } from "./firebase";
import AuthPage from "./AuthPage";

type HistoryItem = {
  id: string;
  text: string;
  language: 'ku' | 'ar';
  timestamp: number;
  model?: string;
};

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null | undefined>(undefined); // undefined = loading
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<string>("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cookieError, setCookieError] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState<'ku' | 'ar'>('ku');
  const [selectedModel, setSelectedModel] = useState<'gemini-pro' | 'gemini' | 'gemini-flash2' | 'scribe'>('gemini-pro');
  const [shouldCompress, setShouldCompress] = useState(true);
  const [activeTab, setActiveTab] = useState<'transcribe' | 'library'>('transcribe');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | 'all' | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [isEditingTranscription, setIsEditingTranscription] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [summary, setSummary] = useState<string>('');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [isExportingSubtitles, setIsExportingSubtitles] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [volStart, setVolStart] = useState(1);
  const [volEnd, setVolEnd] = useState(1);
  const [processStage, setProcessStage] = useState<'idle'|'compressing'|'uploading'|'transcribing'>('idle');
  const abortControllerRef = useRef<AbortController | null>(null);
  const [showRangeEditor, setShowRangeEditor] = useState(false);
  // Waveform & volume points
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [waveformLoading, setWaveformLoading] = useState(false);
  type VolumePoint = { time: number; volume: number };
  const [volumePoints, setVolumePoints] = useState<VolumePoint[]>([]);
  const [activePointIdx, setActivePointIdx] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const editableRef = useRef<HTMLTextAreaElement>(null);
  const audioElRef = useRef<HTMLAudioElement>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => setUser(u));
    return unsub;
  }, []);

  // Load history from Firestore when user logs in
  useEffect(() => {
    if (!user) { setHistory([]); return; }
    setHistoryLoading(true);
    const q = query(collection(db, "users", user.uid, "history"), orderBy("timestamp", "desc"), limit(100));
    getDocs(q).then(snap => {
      setHistory(snap.docs.map(d => ({ id: d.id, ...d.data() } as HistoryItem)));
    }).catch(err => {
      console.error("Firestore error:", err);
      if (err?.code === 'permission-denied') {
        setError("مێژووەکان نەخوێندرانەوە: تکایە Firestore Security Rules لە Firebase Console دابنێ.");
      }
    }).finally(() => setHistoryLoading(false));
  }, [user]);

  const saveToHistory = async (item: Omit<HistoryItem, 'id'>) => {
    if (!user) return;
    try {
      const ref = await addDoc(collection(db, "users", user.uid, "history"), item);
      setHistory(prev => [{ id: ref.id, ...item }, ...prev].slice(0, 100));
    } catch (err: any) {
      console.error("Firestore save error:", err);
      if (err?.code === 'permission-denied') {
        setError("مێژوو خەزن نەکرا: تکایە Firestore Rules لە Firebase Console دابنێ. بڕوانە README.");
      }
    }
  };

  const deleteHistoryItem = async (id: string) => {
    if (!user) return;
    await deleteDoc(doc(db, "users", user.uid, "history", id));
    setHistory(prev => prev.filter(h => h.id !== id));
  };

  const deleteAllHistory = async () => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "history"));
    const snap = await getDocs(q);
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    setHistory([]);
  };

  const confirmDelete = async () => {
    if (deleteConfirmId === 'all') await deleteAllHistory();
    else if (deleteConfirmId) await deleteHistoryItem(deleteConfirmId);
    setDeleteConfirmId(null);
  };

  const startRecording = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/wav" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(t => t.stop());
        setVolumePoints([]); setActivePointIdx(null);
        decodeWaveform(blob);
      };
      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      setError("نەتوانرا مایکرۆفۆن بکرێتەوە. تکایە مۆڵەت بدە.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      setError("قەبارەی فایلەکە زۆر گەورەیە. تکایە فایلێکی کەمتر لە ١٠٠ مێگابایت هەڵبژێرە.");
      return;
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(file);
    setAudioUrl(URL.createObjectURL(file));
    setError(null);
    setVolumePoints([]); setActivePointIdx(null);
    decodeWaveform(file);
  };

  const cancelTranscription = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsTranscribing(false);
    setProcessStage('idle');
  };

  const runTranscription = async (blob: Blob, langToUse: 'ku' | 'ar', compress: boolean) => {
    const ac = new AbortController();
    abortControllerRef.current = ac;
    setIsTranscribing(true);
    setError(null);
    setTranscription("");
    setIsEditingTranscription(false);

    try {
      setProcessStage(compress ? 'compressing' : 'uploading');
      const formData = new FormData();
      formData.append("audio", blob);
      formData.append("language", langToUse);
      formData.append("model", selectedModel);
      formData.append("compress", compress ? "true" : "false");

      setProcessStage('uploading');
      const response = await fetch("/api/transcribe", { method: "POST", body: formData, signal: ac.signal });

      if (response.status === 404) { setError("هەڵەی 404: API نەدۆزرایەوە."); return; }
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("text/html") && !response.ok) { setCookieError(true); return; }
      if (!response.ok) {
        const txt = await response.text();
        try { setError(JSON.parse(txt).error || "هەڵەیەک ڕوویدا."); }
        catch { setError("هەڵەیەک ڕوویدا لە کاتی گۆڕینی دەنگەکە."); }
        return;
      }

      setProcessStage('transcribing');
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No reader");
      const decoder = new TextDecoder();
      let fullText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          const chunk = decoder.decode(value, { stream: !done });
          if (chunk) { fullText += chunk; setTranscription(p => p + chunk); }
        }
        if (done) break;
      }
      setIsTranscribing(false);
      setProcessStage('idle');
      if (fullText.trim()) {
        await saveToHistory({ text: fullText, language: langToUse, timestamp: Date.now(), model: selectedModel });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // user cancelled
      setError(err.message || "پەیوەندی لەگەڵ سێرڤەر نییە.");
      setIsTranscribing(false);
      setProcessStage('idle');
    }
  };

  const transcribeAudio = (overrideLanguage?: 'ku' | 'ar') => {
    if (!audioBlob) return;
    let langToUse = targetLanguage;
    if (overrideLanguage === 'ku' || overrideLanguage === 'ar') {
      langToUse = overrideLanguage;
      setTargetLanguage(overrideLanguage);
    }
    runTranscription(audioBlob, langToUse, shouldCompress);
  };

  const copyText = (text: string, id: string | null = null) => {
    // Normalize whitespace: collapse multiple spaces/newlines into single space per word,
    // then wrap at ~80 chars per line for clean paste output
    const normalized = text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    const write = () => {
      const ta = document.createElement("textarea");
      ta.value = normalized;
      Object.assign(ta.style, { position: "fixed", top: "0", left: "0", opacity: "0" });
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(normalized).catch(write);
    } else { write(); }
    if (id) { setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); }
    else { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  const summarizeText = async () => {
    if (!transcription.trim()) return;
    setIsSummarizing(true);
    setSummary('');
    setShowSummary(true);
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: transcription, language: targetLanguage }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'هەڵەیەک ڕوویدا' }));
        setSummary(`هەڵە: ${errData.error || res.status}`);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          const chunk = decoder.decode(value, { stream: !done });
          if (chunk) setSummary(p => p + chunk);
        }
        if (done) break;
      }
    } catch {
      setSummary('پەیوەندی لەگەڵ سێرڤەر نییە.');
    } finally {
      setIsSummarizing(false);
    }
  };

  const exportText = (format: 'txt' | 'docx' | 'pdf', text: string) => {
    const filename = `voxscript-${Date.now()}`;
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    const htmlDoc = `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>VoxScript</title><style>body{font-family:"Arial","Tahoma",sans-serif;font-size:16pt;line-height:2;direction:rtl;text-align:right;padding:2cm;color:#000;}</style></head><body>${escaped}</body></html>`;

    if (format === 'txt') {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${filename}.txt`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else if (format === 'docx') {
      // Word opens HTML .doc files with full Unicode/RTL support
      const blob = new Blob([htmlDoc], { type: 'application/msword;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${filename}.doc`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else if (format === 'pdf') {
      const win = window.open('', '_blank');
      if (!win) return;
      win.document.write(htmlDoc);
      win.document.close();
      setTimeout(() => { win.focus(); win.print(); }, 600);
    }
    setShowExportMenu(false);
  };

  const exportSubtitles = async (format: 'srt' | 'vtt') => {
    if (!audioBlob) return;
    setIsExportingSubtitles(true);
    setShowExportMenu(false);
    try {
      const formData = new FormData();
      formData.append("audio", audioBlob);
      formData.append("language", targetLanguage);
      formData.append("format", format);
      formData.append("compress", shouldCompress ? "true" : "false");
      const res = await fetch("/api/subtitles", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "هەڵەیەک ڕوویدا" }));
        setError(err.error || "هەڵەیەک ڕوویدا لە دروستکردنی ژێرنووس.");
        return;
      }
      const text = await res.text();
      const mimeType = format === 'srt' ? 'text/srt;charset=utf-8' : 'text/vtt;charset=utf-8';
      const blob = new Blob([text], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `voxscript-subtitles-${Date.now()}.${format}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setError("پەیوەندی لەگەڵ سێرڤەر نییە.");
    } finally {
      setIsExportingSubtitles(false);
    }
  };

  const shareText = (platform: 'telegram' | 'whatsapp' | 'native', text: string) => {
    // Telegram & WhatsApp have message length limits — trim gracefully
    const trimmed = text.slice(0, 3900);
    const encoded = encodeURIComponent(trimmed);
    if (platform === 'telegram') {
      // Use tg:// deep-link: no url param needed, just msg
      window.open(`https://telegram.me/share/url?url=${encodeURIComponent('.')}&text=${encoded}`, '_blank');
    } else if (platform === 'whatsapp') {
      window.open(`https://wa.me/?text=${encoded}`, '_blank');
    } else if (platform === 'native') {
      if (navigator.share) {
        navigator.share({ text: trimmed }).catch(() => {});
      } else {
        copyText(text);
      }
    }
    setShowShareMenu(false);
  };

  const reset = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null); setAudioUrl(null); setTranscription(""); setError(null);
    setSummary(''); setShowSummary(false);
    setAudioDuration(0); setRangeStart(''); setRangeEnd(''); setShowRangeEditor(false);
    setVolStart(1); setVolEnd(1); setWaveformData([]); setVolumePoints([]); setActivePointIdx(null); setPlayhead(0);
  };

  const parseMMSS = (val: string): number => {
    const parts = val.trim().split(':');
    if (parts.length === 2) return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    return parseFloat(val) || 0;
  };

  const fmtMMSS = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };

  const transcribeRange = async () => {
    if (!audioBlob) return;
    const start = parseMMSS(rangeStart);
    const end = parseMMSS(rangeEnd) || audioDuration;
    if (start >= end) { setError("کاتی دەستپێکردن پێویستە کەمتر بێت لە کاتی کۆتایی."); return; }

    setProcessStage('compressing');
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioCtx = new AudioContext();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      const sampleRate = decoded.sampleRate;
      const startSample = Math.floor(start * sampleRate);
      const endSample = Math.min(Math.floor(end * sampleRate), decoded.length);
      const frameCount = endSample - startSample;
      const sliced = audioCtx.createBuffer(decoded.numberOfChannels, frameCount, sampleRate);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const srcData = decoded.getChannelData(ch).subarray(startSample, endSample);
        const dst = sliced.getChannelData(ch);
        for (let i = 0; i < frameCount; i++) {
          const tSec = start + (i / sampleRate);
          const gain = volumePoints.length > 0
            ? getVolAtTime(tSec, volumePoints, audioDuration)
            : 1;
          dst[i] = srcData[i] * gain;
        }
      }
      audioCtx.close();
      const wavBlob = audioBufferToWavBlob(sliced);
      await runTranscription(wavBlob, targetLanguage, false);
    } catch (err: any) {
      setError(err.message || "هەڵەیەک ڕوویدا لە کاتی ئیدیتکردنی دەنگ.");
      setIsTranscribing(false);
      setProcessStage('idle');
    }
  };

  // Encode AudioBuffer to WAV Blob (PCM 16-bit)
  const audioBufferToWavBlob = (buffer: AudioBuffer): Blob => {
    const numCh = buffer.numberOfChannels;
    const numFrames = buffer.length;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = 2;
    const dataSize = numFrames * numCh * bytesPerSample;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numCh * bytesPerSample, true);
    view.setUint16(32, numCh * bytesPerSample, true); view.setUint16(34, 16, true);
    writeStr(36, 'data'); view.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  };

  // Decode audio blob into waveform peaks (128 bars)
  const decodeWaveform = async (blob: Blob) => {
    setWaveformLoading(true);
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new AudioContext();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close();
      const raw = decoded.getChannelData(0);
      const bars = 128;
      const blockSize = Math.floor(raw.length / bars);
      const peaks: number[] = [];
      for (let i = 0; i < bars; i++) {
        let max = 0;
        for (let j = 0; j < blockSize; j++) {
          const v = Math.abs(raw[i * blockSize + j]);
          if (v > max) max = v;
        }
        peaks.push(max);
      }
      // Normalize
      const maxPeak = Math.max(...peaks, 0.01);
      setWaveformData(peaks.map(p => p / maxPeak));
    } catch { setWaveformData([]); }
    finally { setWaveformLoading(false); }
  };

  // Get volume at a time position by interpolating between volume points
  const getVolAtTime = (t: number, points: VolumePoint[], duration: number): number => {
    if (points.length === 0) return 1;
    const sorted = [...points].sort((a, b) => a.time - b.time);
    if (t <= sorted[0].time) return sorted[0].volume;
    if (t >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].volume;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (t >= sorted[i].time && t <= sorted[i + 1].time) {
        const frac = (t - sorted[i].time) / (sorted[i + 1].time - sorted[i].time);
        return sorted[i].volume + (sorted[i + 1].volume - sorted[i].volume) * frac;
      }
    }
    return 1;
  };

  // Loading state
  if (user === undefined) {
    return (
      <div className="min-h-screen bg-[#0a0a0b] flex items-center justify-center">
        <Loader2 className="animate-spin text-[#ff4e00]" size={32} />
      </div>
    );
  }

  // Not logged in
  if (!user) return <AuthPage />;

  return (
    <div className="min-h-screen bg-[#0a0a0b] font-sans text-[#e0e0e0] selection:bg-[#ff4e00]/30" dir="rtl">

      {/* ── HEADER ── */}
      <header className="sticky top-0 z-30 bg-[#0a0a0b]/90 backdrop-blur border-b border-[#ffffff10]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0" dir="ltr">
            <div className="w-8 h-8 sm:w-9 sm:h-9 bg-white rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(255,255,255,0.1)] relative">
              <div className="w-5 h-0.5 bg-[#0a0a0b] rounded-full rotate-45 absolute" />
              <div className="w-5 h-0.5 bg-[#0a0a0b] rounded-full -rotate-45" />
            </div>
            <span className="text-lg sm:text-xl font-bold tracking-tighter text-white">VOX<span className="text-[#ff4e00]">SCRIPT</span></span>
          </div>

          {/* Nav */}
          <nav className="flex gap-1 bg-[#141416] border border-[#ffffff10] rounded-lg p-1" dir="ltr">
            {(['transcribe', 'library'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-3 sm:px-4 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all ${activeTab === tab ? 'bg-[#ff4e00] text-white' : 'text-[#888] hover:text-white'}`}
              >
                {tab === 'transcribe' ? 'Transcribe' : 'Library'}
                {tab === 'library' && history.length > 0 && (
                  <span className={`mr-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${activeTab === 'library' ? 'bg-white/20' : 'bg-[#ffffff15]'}`}>{history.length}</span>
                )}
              </button>
            ))}
          </nav>

          {/* User menu */}
          <div className="relative shrink-0" dir="ltr">
            <button onClick={() => setShowUserMenu(p => !p)}
              className="flex items-center gap-2 bg-[#141416] border border-[#ffffff10] rounded-lg px-2.5 py-1.5 hover:border-[#ffffff20] transition-colors"
            >
              {user.photoURL
                ? <img src={user.photoURL} className="w-6 h-6 rounded-full" alt="" />
                : <User size={15} className="text-[#888]" />
              }
              <span className="hidden sm:block text-xs text-[#888] max-w-[100px] truncate">
                {user.displayName || user.email?.split('@')[0]}
              </span>
            </button>
            <AnimatePresence>
              {showUserMenu && (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
                  className="absolute left-0 top-full mt-2 w-48 bg-[#141416] border border-[#ffffff12] rounded-xl shadow-2xl overflow-hidden z-50"
                >
                  <div className="px-3 py-2.5 border-b border-[#ffffff08]">
                    <p className="text-xs text-white font-medium truncate">{user.displayName || "کاربەر"}</p>
                    <p className="text-[10px] text-[#555] truncate">{user.email}</p>
                  </div>
                  <button onClick={() => { signOut(auth); setShowUserMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-[#888] hover:text-[#ff4e00] hover:bg-[#ff4e00]/05 transition-colors"
                  >
                    <LogOut size={13} />
                    دەرچوون
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {activeTab === 'transcribe' ? (
          <>
            {/* ── CONTROLS ── */}
            <section className="bg-[#141416] border border-[#ffffff10] rounded-2xl overflow-hidden shadow-2xl">
              <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#ffffff08] border-b border-[#ffffff08]">
                {/* Language */}
                <div className="p-4 flex flex-col gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-[#555] font-bold">زمان</span>
                  <div className="flex bg-[#0a0a0b] p-1 rounded-lg border border-[#ffffff08] relative">
                    <div className="absolute top-1 bottom-1 w-[calc(50%-4px)] bg-[#ff4e00]/15 border border-[#ff4e00]/30 rounded-md transition-all duration-300"
                      style={{ right: targetLanguage === 'ku' ? '4px' : 'calc(50%)' }} />
                    {(['ku', 'ar'] as const).map(lang => (
                      <button key={lang} onClick={() => setTargetLanguage(lang)}
                        className={`flex-1 py-2 text-sm font-medium transition-colors relative z-10 ${targetLanguage === lang ? 'text-white' : 'text-[#666] hover:text-[#aaa]'}`}
                      >{lang === 'ku' ? 'کوردی' : 'عەرەبی'}</button>
                    ))}
                  </div>
                </div>

                {/* Model */}
                <div className="p-4 flex flex-col gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-[#555] font-bold">مۆدێل</span>
                  <div className="relative">
                    <select value={selectedModel} onChange={e => setSelectedModel(e.target.value as any)}
                      className="w-full bg-[#0a0a0b] border border-[#ffffff08] text-sm font-medium text-white py-2.5 pl-3 pr-8 rounded-lg outline-none cursor-pointer appearance-none" dir="ltr"
                    >
                      <option value="gemini-pro" className="bg-[#1a1a1c]">Gemini 2.5 Pro ★</option>
                      <option value="gemini" className="bg-[#1a1a1c]">Gemini 2.5 Flash</option>
                      <option value="gemini-flash2" className="bg-[#1a1a1c]">Gemini 2.0 Flash</option>
                      <option value="scribe" className="bg-[#1a1a1c]">ElevenLabs Scribe</option>
                    </select>
                    <ChevronDown size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555] pointer-events-none" />
                  </div>
                </div>

                {/* Compress */}
                <div className="p-4 flex flex-col gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-[#555] font-bold">بچووککردنەوەی قەبارە</span>
                  <label className="flex items-center gap-3 bg-[#0a0a0b] border border-[#ffffff08] rounded-lg px-3 py-2.5 cursor-pointer hover:border-[#ffffff15] transition-colors h-[42px]">
                    <div onClick={() => setShouldCompress(p => !p)}
                      className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer shrink-0 ${shouldCompress ? 'bg-[#ff4e00]' : 'bg-[#333]'}`}
                    >
                      <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${shouldCompress ? 'left-4' : 'left-0.5'}`} />
                    </div>
                    <span className="text-sm text-[#aaa] select-none">{shouldCompress ? 'چالاکە' : 'ناچالاکە'}</span>
                  </label>
                </div>
              </div>

              {/* Record / Upload */}
              <div className="p-4 sm:p-6">
                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                  {!isRecording ? (
                    <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                      onClick={startRecording} disabled={isTranscribing}
                      className="flex flex-col items-center gap-3 p-5 sm:p-7 rounded-2xl bg-[#1a1a1c] border border-[#ffffff08] hover:border-[#ff4e00]/30 hover:bg-[#1e1e20] transition-all disabled:opacity-40 group"
                    >
                      <div className="p-3.5 sm:p-4 bg-[#ff4e00] text-white rounded-full ring-4 ring-[#ff4e00]/15 group-hover:ring-[#ff4e00]/30 group-hover:scale-105 transition-all">
                        <Mic size={22} />
                      </div>
                      <span className="text-[10px] sm:text-xs uppercase tracking-widest text-[#666] font-bold">تۆمارکردن</span>
                    </motion.button>
                  ) : (
                    <motion.button animate={{ scale: [1, 1.03, 1], transition: { repeat: Infinity, duration: 1.5 } }}
                      onClick={stopRecording}
                      className="flex flex-col items-center gap-3 p-5 sm:p-7 rounded-2xl bg-[#ff4e00]/08 border border-[#ff4e00]/25 hover:bg-[#ff4e00]/12 transition-all"
                    >
                      <div className="p-3.5 sm:p-4 bg-[#ff4e00] text-white rounded-full shadow-[0_0_20px_rgba(255,78,0,0.4)]">
                        <Square size={22} fill="currentColor" />
                      </div>
                      <span className="text-[10px] sm:text-xs uppercase tracking-widest text-[#ff4e00] font-bold">ڕاگرتن</span>
                    </motion.button>
                  )}

                  <label className="flex flex-col items-center gap-3 p-5 sm:p-7 rounded-2xl bg-[#0f0f11] border border-dashed border-[#ffffff12] hover:border-[#ffffff25] hover:bg-[#141416] transition-all cursor-pointer">
                    <div className="p-3.5 sm:p-4 bg-[#1a1a1c] border border-[#ffffff10] text-[#aaa] rounded-full">
                      <Upload size={22} />
                    </div>
                    <span className="text-[10px] sm:text-xs uppercase tracking-widest font-bold text-[#666]">بارکردنی فایل</span>
                    <input type="file" accept="audio/*" onChange={handleFileUpload} className="hidden" disabled={isTranscribing} />
                  </label>
                </div>

                <AnimatePresence>
                  {audioBlob && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="mt-4 space-y-3">
                      <div className="flex items-center justify-between bg-[#0a0a0b] px-4 py-3 rounded-xl border border-[#ffffff08]">
                        <div className="flex items-center gap-3 min-w-0">
                          <FileAudio size={16} className="text-[#ff4e00] shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-mono text-white truncate" dir="ltr">AUDIO_INPUT</p>
                            <p className="text-[10px] font-mono text-[#555]" dir="ltr">{(audioBlob.size / (1024 * 1024)).toFixed(2)} MB</p>
                          </div>
                        </div>
                        <button onClick={reset} className="text-[#555] hover:text-[#ff4e00] transition-colors p-1.5 shrink-0"><Trash2 size={15} /></button>
                      </div>
                      {audioUrl && (
                        <div className="bg-[#0a0a0b] rounded-xl border border-[#ffffff08] overflow-hidden">
                          {/* Hidden native audio for playback control */}
                          <audio ref={audioElRef} src={audioUrl} className="hidden"
                            onLoadedMetadata={e => {
                              const d = (e.target as HTMLAudioElement).duration;
                              if (isFinite(d)) { setAudioDuration(d); setRangeEnd(fmtMMSS(d)); }
                            }}
                            onTimeUpdate={e => setPlayhead((e.target as HTMLAudioElement).currentTime)}
                          />

                          {/* Custom waveform player */}
                          <div className="p-3 space-y-2">
                            {/* Waveform canvas */}
                            <div className="relative h-16 cursor-crosshair select-none"
                              onClick={e => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const frac = (e.clientX - rect.left) / rect.width;
                                const t = frac * audioDuration;
                                // Add volume point at clicked position
                                const newPoint: VolumePoint = { time: t, volume: 1 };
                                const newIdx = volumePoints.length;
                                setVolumePoints(prev => [...prev, newPoint]);
                                setActivePointIdx(newIdx);
                                // Also seek audio
                                if (audioElRef.current) audioElRef.current.currentTime = t;
                              }}
                            >
                              {/* Waveform bars */}
                              <div className="absolute inset-0 flex items-center gap-px">
                                {waveformLoading ? (
                                  <div className="w-full flex items-center justify-center">
                                    <Loader2 size={14} className="animate-spin text-[#444]" />
                                  </div>
                                ) : waveformData.length > 0 ? waveformData.map((peak, i) => {
                                  const frac = i / waveformData.length;
                                  const tSec = frac * audioDuration;
                                  const isPlayed = audioDuration > 0 && tSec <= playhead;
                                  const pointGain = volumePoints.length > 0
                                    ? getVolAtTime(tSec, volumePoints, audioDuration)
                                    : 1;
                                  const heightPct = Math.max(4, peak * 100);
                                  // Color: played=cyan tinted by gain, unplayed=grey
                                  const gainColor = pointGain > 1
                                    ? `rgba(34,211,238,${0.4 + Math.min((pointGain-1)/2,0.6)})`
                                    : pointGain < 1
                                    ? `rgba(255,78,0,${0.3 + Math.min((1-pointGain),0.5)})`
                                    : isPlayed ? '#22d3ee' : '#2a2a2e';
                                  return (
                                    <div key={i} className="flex-1 flex items-center justify-center" style={{ height: '100%' }}>
                                      <div className="w-full rounded-sm transition-colors"
                                        style={{ height: `${heightPct}%`, background: gainColor }} />
                                    </div>
                                  );
                                }) : (
                                  <div className="w-full h-0.5 bg-[#1a1a1a] rounded-full" />
                                )}
                              </div>

                              {/* Playhead line */}
                              {audioDuration > 0 && (
                                <div className="absolute top-0 bottom-0 w-px bg-white/60 pointer-events-none"
                                  style={{ left: `${(playhead / audioDuration) * 100}%` }} />
                              )}

                              {/* Volume point markers */}
                              {volumePoints.map((pt, idx) => (
                                <div key={idx}
                                  className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 cursor-pointer transition-all z-10 ${activePointIdx === idx ? 'bg-yellow-400 border-yellow-300 scale-125 shadow-[0_0_8px_rgba(250,204,21,0.8)]' : 'bg-yellow-400/80 border-yellow-500/60 hover:scale-110'}`}
                                  style={{ left: `${audioDuration > 0 ? (pt.time / audioDuration) * 100 : 0}%` }}
                                  onClick={e => { e.stopPropagation(); setActivePointIdx(idx); }}
                                />
                              ))}
                            </div>

                            {/* Playback controls */}
                            <div className="flex items-center gap-3" dir="ltr">
                              <button onClick={() => {
                                const a = audioElRef.current; if (!a) return;
                                a.paused ? a.play() : a.pause();
                              }}
                                className="w-8 h-8 flex items-center justify-center rounded-full bg-[#1a1a1c] border border-[#ffffff10] text-white hover:bg-[#222] transition-colors shrink-0"
                              >
                                {audioElRef.current?.paused !== false
                                  ? <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current ml-0.5"><polygon points="5,3 19,12 5,21"/></svg>
                                  : <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                                }
                              </button>

                              {/* Seek bar */}
                              <div className="relative flex-1 h-1.5 bg-[#1a1a1a] rounded-full cursor-pointer"
                                onClick={e => {
                                  if (!audioElRef.current || !audioDuration) return;
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  audioElRef.current.currentTime = ((e.clientX - rect.left) / rect.width) * audioDuration;
                                }}
                              >
                                <div className="absolute left-0 top-0 h-full rounded-full bg-[#22d3ee]"
                                  style={{ width: audioDuration > 0 ? `${(playhead / audioDuration) * 100}%` : '0%' }} />
                              </div>

                              <span className="text-[10px] font-mono text-[#555] shrink-0 tabular-nums">
                                {fmtMMSS(playhead)} / {fmtMMSS(audioDuration)}
                              </span>
                            </div>

                            {/* Active volume point editor */}
                            {activePointIdx !== null && volumePoints[activePointIdx] && (
                              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                                className="flex items-center gap-3 bg-[#141416] border border-yellow-400/20 rounded-lg px-3 py-2.5" dir="ltr"
                              >
                                <div className="w-3 h-3 rounded-full bg-yellow-400 shrink-0" />
                                <span className="text-[10px] text-yellow-400 font-mono shrink-0">
                                  {fmtMMSS(volumePoints[activePointIdx].time)}
                                </span>
                                <input type="range" min={0.1} max={3} step={0.05}
                                  value={volumePoints[activePointIdx].volume}
                                  onChange={e => {
                                    const v = parseFloat(e.target.value);
                                    setVolumePoints(prev => prev.map((p, i) => i === activePointIdx ? { ...p, volume: v } : p));
                                  }}
                                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-[#1f2937] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-yellow-400 [&::-webkit-slider-thumb]:cursor-grab"
                                />
                                <span className="text-[10px] font-mono text-yellow-400 w-10 text-right shrink-0">
                                  {Math.round(volumePoints[activePointIdx].volume * 100)}%
                                </span>
                                <button onClick={() => {
                                  setVolumePoints(prev => prev.filter((_, i) => i !== activePointIdx));
                                  setActivePointIdx(null);
                                }}
                                  className="text-[#555] hover:text-[#ff4e00] transition-colors shrink-0"
                                ><X size={12} /></button>
                              </motion.div>
                            )}

                            {volumePoints.length > 0 && (
                              <div className="flex items-center justify-between" dir="ltr">
                                <span className="text-[9px] text-[#444] uppercase tracking-wider">{volumePoints.length} volume point{volumePoints.length !== 1 ? 's' : ''}</span>
                                <button onClick={() => { setVolumePoints([]); setActivePointIdx(null); }}
                                  className="text-[9px] text-[#444] hover:text-[#ff4e00] transition-colors uppercase tracking-wider"
                                >سڕینەوەی هەمووی</button>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* ── RANGE EDITOR ── */}
                      <div className="rounded-xl border border-[#ffffff08] bg-[#0a0a0b] overflow-hidden">
                        <button onClick={() => setShowRangeEditor(p => !p)}
                          className="w-full flex items-center justify-between px-4 py-2.5 text-[10px] uppercase tracking-widest text-[#555] hover:text-[#aaa] transition-colors font-bold"
                        >
                          <span className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6]" />
                            ئیدیتی بەشێکی دیاریکراو
                          </span>
                          <ChevronDown size={12} className={`transition-transform ${showRangeEditor ? 'rotate-180' : ''}`} />
                        </button>
                        <AnimatePresence>
                          {showRangeEditor && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                              className="border-t border-[#ffffff08] overflow-hidden"
                            >
                              <div className="p-4 space-y-4">
                                {/* Start / End inputs */}
                                <div className="grid grid-cols-2 gap-3" dir="ltr">
                                  <div className="flex flex-col gap-1.5">
                                    <label className="text-[9px] uppercase tracking-widest text-[#444] font-bold">دەستپێک (MM:SS)</label>
                                    <input type="text" value={rangeStart} onChange={e => setRangeStart(e.target.value)}
                                      placeholder="00:00"
                                      className="bg-[#141416] border border-[#ffffff10] rounded-lg px-3 py-2 text-sm font-mono text-white outline-none focus:border-[#3b82f6]/60 transition-colors placeholder-[#333]"
                                    />
                                  </div>
                                  <div className="flex flex-col gap-1.5">
                                    <label className="text-[9px] uppercase tracking-widest text-[#444] font-bold">
                                      کۆتایی (MM:SS){audioDuration > 0 && <span className="text-[#333] ml-1">/ {fmtMMSS(audioDuration)}</span>}
                                    </label>
                                    <input type="text" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)}
                                      placeholder={audioDuration > 0 ? fmtMMSS(audioDuration) : '00:00'}
                                      className="bg-[#141416] border border-[#ffffff10] rounded-lg px-3 py-2 text-sm font-mono text-white outline-none focus:border-[#3b82f6]/60 transition-colors placeholder-[#333]"
                                    />
                                  </div>
                                </div>

                                {/* Quick-set current time button */}
                                {audioElRef.current && (
                                  <div className="flex gap-2" dir="ltr">
                                    <button onClick={() => setRangeStart(fmtMMSS(audioElRef.current!.currentTime))}
                                      className="flex-1 py-1.5 text-[10px] uppercase tracking-wider bg-[#141416] border border-[#ffffff08] rounded-lg text-[#555] hover:text-[#3b82f6] hover:border-[#3b82f6]/30 transition-colors"
                                    >▶ Set Start</button>
                                    <button onClick={() => setRangeEnd(fmtMMSS(audioElRef.current!.currentTime))}
                                      className="flex-1 py-1.5 text-[10px] uppercase tracking-wider bg-[#141416] border border-[#ffffff08] rounded-lg text-[#555] hover:text-[#3b82f6] hover:border-[#3b82f6]/30 transition-colors"
                                    >■ Set End</button>
                                  </div>
                                )}


                                {/* Transcribe range button */}
                                <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}
                                  onClick={transcribeRange} disabled={isTranscribing || !rangeStart}
                                  className="w-full py-3 rounded-xl bg-[#3b82f6] text-white font-bold text-xs tracking-[0.15em] uppercase shadow-[0_0_20px_rgba(59,130,246,0.2)] hover:bg-[#2563eb] hover:shadow-[0_0_30px_rgba(59,130,246,0.35)] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2.5"
                                >
                                  {isTranscribing
                                    ? <><Loader2 className="animate-spin" size={14} />PROCESSING RANGE...</>
                                    : <>TRANSCRIBE {rangeStart && rangeEnd ? `${rangeStart} → ${rangeEnd}` : 'SELECTED RANGE'}</>}
                                </motion.button>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      {/* Progress bar */}
                      <AnimatePresence>
                        {isTranscribing && (
                          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                            className="rounded-xl border border-[#ffffff08] bg-[#0a0a0b] px-4 py-3 space-y-2"
                          >
                            <div className="flex items-center justify-between" dir="ltr">
                              <div className="flex items-center gap-2">
                                <Loader2 size={13} className="animate-spin text-[#ff4e00]" />
                                <span className="text-[10px] font-mono text-[#aaa] uppercase tracking-wider">
                                  {processStage === 'compressing' && 'فشردن و ئامادەکردن...'}
                                  {processStage === 'uploading' && 'ناردن بۆ سێرڤەر...'}
                                  {processStage === 'transcribing' && 'گۆڕینی دەنگ بە نووسین...'}
                                </span>
                              </div>
                              <button onClick={cancelTranscription}
                                className="flex items-center gap-1 text-[10px] text-[#555] hover:text-[#ff4e00] transition-colors uppercase tracking-wider font-bold px-2 py-1 rounded border border-[#ffffff08] hover:border-[#ff4e00]/30"
                              >
                                <X size={10} />ڕاگرتن
                              </button>
                            </div>
                            <div className="h-0.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                              <motion.div className="h-full rounded-full bg-[#ff4e00]"
                                animate={processStage === 'transcribing'
                                  ? { width: ['15%', '88%'], transition: { duration: 28, ease: 'linear' } }
                                  : processStage === 'uploading'
                                  ? { width: '15%', transition: { duration: 0.4 } }
                                  : { width: '5%', transition: { duration: 0.3 } }
                                }
                              />
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <div className="flex gap-2" dir="ltr">
                        <motion.button whileHover={{ scale: isTranscribing ? 1 : 1.01 }} whileTap={{ scale: 0.98 }}
                          onClick={() => transcribeAudio()} disabled={isTranscribing}
                          className="flex-1 py-3.5 rounded-xl bg-[#ff4e00] text-white font-bold text-xs tracking-[0.15em] uppercase shadow-[0_0_20px_rgba(255,78,0,0.25)] hover:shadow-[0_0_30px_rgba(255,78,0,0.4)] hover:bg-[#e64600] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2.5"
                        >
                          TRANSCRIBE AUDIO
                        </motion.button>
                        <AnimatePresence>
                          {isTranscribing && (
                            <motion.button initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
                              onClick={cancelTranscription}
                              className="px-4 py-3.5 rounded-xl bg-[#1a1a1c] border border-[#ff4e00]/30 text-[#ff4e00] text-xs font-bold uppercase tracking-wider hover:bg-[#ff4e00]/10 transition-all flex items-center gap-1.5"
                            >
                              <X size={14} />ڕاگرتن
                            </motion.button>
                          )}
                        </AnimatePresence>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {error && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="mt-4 text-[#ff4e00] text-xs font-mono bg-[#ff4e00]/08 border border-[#ff4e00]/20 px-4 py-3 rounded-xl text-center"
                  >{error}</motion.div>
                )}
              </div>
            </section>

            {/* ── RESULT ── */}
            <AnimatePresence>
              {transcription && (
                <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
                  className="bg-[#141416] rounded-2xl border border-[#ffffff10] shadow-2xl"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-7 py-4 border-b border-[#ffffff08]" dir="ltr">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-widest text-[#555] font-bold">Transcription Output</span>
                      {isEditingTranscription && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#ff4e00]/15 border border-[#ff4e00]/30 text-[#ff4e00] uppercase tracking-wider font-bold">editing</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {targetLanguage === 'ku' && audioBlob && !isTranscribing && (
                        <button onClick={() => transcribeAudio('ar')}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#ff4e00]/10 border border-[#ff4e00]/25 rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#ff4e00]/20 text-[#ff4e00] transition-colors font-bold"
                        >وەرگێڕان بۆ عەرەبی</button>
                      )}
                      <button onClick={() => {
                        setIsEditingTranscription(p => {
                          if (!p) setTimeout(() => editableRef.current?.focus(), 50);
                          return !p;
                        });
                      }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-wider transition-all ${isEditingTranscription ? 'bg-[#ff4e00]/20 border border-[#ff4e00]/50 text-[#ff4e00]' : 'bg-[#1a1a1c] border border-[#ffffff10] text-[#bbb] hover:bg-[#222]'}`}
                      >
                        {isEditingTranscription ? <><X size={12} />داخستن</> : <><Pencil size={12} />دەستکاری</>}
                      </button>
                      <button onClick={summarizeText} disabled={isSummarizing}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-wider transition-all disabled:opacity-50 ${showSummary ? 'bg-[#a855f7]/20 border border-[#a855f7]/50 text-[#a855f7]' : 'bg-[#1a1a1c] border border-[#ffffff10] text-[#bbb] hover:bg-[#a855f7]/10 hover:border-[#a855f7]/30 hover:text-[#a855f7]'}`}
                      >
                        {isSummarizing ? <><Loader2 size={12} className="animate-spin" />پوختەکردن...</> : <><Sparkles size={12} />پوختەکردن</>}
                      </button>
                      <button onClick={() => copyText(transcription)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a1c] border border-[#ffffff10] rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#222] text-[#bbb] transition-colors"
                      >
                        {copied ? <><Check size={12} className="text-green-400" />COPIED</> : <><Copy size={12} />COPY</>}
                      </button>
                      <div className="relative">
                        <button onClick={() => setShowExportMenu(p => !p)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a1c] border border-[#ffffff10] rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#ff4e00]/15 hover:border-[#ff4e00]/40 hover:text-[#ff4e00] text-[#bbb] transition-all"
                        >
                          <Download size={12} />EXPORT<ChevronDown size={10} className={`transition-transform ${showExportMenu ? 'rotate-180' : ''}`} />
                        </button>
                        <AnimatePresence>
                          {showExportMenu && (
                            <motion.div initial={{ opacity: 0, y: 6, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.95 }}
                              className="absolute left-0 top-full mt-2 w-44 bg-[#141416] border border-[#ffffff12] rounded-xl shadow-2xl overflow-hidden z-50"
                            >
                              {([
                                { fmt: 'txt', label: 'دابگرە بە .TXT', sub: 'تێکستی سادە' },
                                { fmt: 'docx', label: 'دابگرە بە .DOC', sub: 'بۆ Microsoft Word' },
                                { fmt: 'pdf', label: 'چاپکردن / PDF', sub: 'Print & Save as PDF' },
                              ] as const).map(({ fmt, label, sub }) => (
                                <button key={fmt} onClick={() => exportText(fmt, transcription)}
                                  className="w-full flex flex-col items-start px-4 py-3 text-right hover:bg-[#ff4e00]/10 transition-colors border-b border-[#ffffff06] last:border-0"
                                >
                                  <span className="text-xs text-white font-medium">{label}</span>
                                  <span className="text-[10px] text-[#555] mt-0.5">{sub}</span>
                                </button>
                              ))}
                              {audioBlob && (
                                <div className="border-t border-[#ffffff08]">
                                  <p className="px-4 pt-2.5 pb-1 text-[9px] uppercase tracking-widest text-[#444] font-bold">ژێرنووس</p>
                                  {(['srt', 'vtt'] as const).map(fmt => (
                                    <button key={fmt} onClick={() => exportSubtitles(fmt)} disabled={isExportingSubtitles}
                                      className="w-full flex flex-col items-start px-4 py-2.5 text-right hover:bg-[#22d3ee]/08 transition-colors border-b border-[#ffffff06] last:border-0 disabled:opacity-50"
                                    >
                                      <span className="text-xs text-[#22d3ee] font-medium flex items-center gap-1.5">
                                        {isExportingSubtitles ? <Loader2 size={10} className="animate-spin" /> : null}
                                        دابگرە بە .{fmt.toUpperCase()}
                                      </span>
                                      <span className="text-[10px] text-[#555] mt-0.5">{fmt === 'srt' ? 'SubRip — بۆ زۆربەی پلەیەرەکان' : 'WebVTT — بۆ وێب و YouTube'}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                      <div className="relative">
                        <button onClick={() => setShowShareMenu(p => !p)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a1c] border border-[#ffffff10] rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#22c55e]/10 hover:border-[#22c55e]/30 hover:text-[#22c55e] text-[#bbb] transition-all"
                        >
                          <Share2 size={12} />SHARE<ChevronDown size={10} className={`transition-transform ${showShareMenu ? 'rotate-180' : ''}`} />
                        </button>
                        <AnimatePresence>
                          {showShareMenu && (
                            <motion.div initial={{ opacity: 0, y: 6, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.95 }}
                              className="absolute left-0 top-full mt-2 w-52 bg-[#141416] border border-[#ffffff12] rounded-xl shadow-2xl overflow-hidden z-50"
                            >
                              {([
                                { plt: 'telegram', label: 'بناردە تێلیگرام', sub: 'Telegram', icon: '✈️' },
                                { plt: 'whatsapp', label: 'بناردە واتساپ', sub: 'WhatsApp', icon: '💬' },
                                { plt: 'native', label: 'بەشکردن...', sub: navigator.share ? 'Share Sheet' : 'کۆپی دەکات', icon: '↗️' },
                              ] as const).map(({ plt, label, sub, icon }) => (
                                <button key={plt} onClick={() => shareText(plt, transcription)}
                                  className="w-full flex items-center gap-3 px-4 py-3 text-right hover:bg-[#22c55e]/08 transition-colors border-b border-[#ffffff06] last:border-0"
                                >
                                  <span className="text-base shrink-0">{icon}</span>
                                  <div className="flex flex-col items-start">
                                    <span className="text-xs text-white font-medium">{label}</span>
                                    <span className="text-[10px] text-[#555]">{sub}</span>
                                  </div>
                                </button>
                              ))}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                  <div className="px-5 sm:px-7 py-6 min-h-[120px]">
                    {isEditingTranscription ? (
                      <textarea
                        ref={editableRef}
                        value={transcription}
                        onChange={e => setTranscription(e.target.value)}
                        className="w-full bg-[#0a0a0b] border border-[#ff4e00]/30 rounded-xl px-4 py-4 text-[#e8e8e8] text-xl sm:text-2xl md:text-3xl leading-relaxed resize-none outline-none focus:border-[#ff4e00]/60 transition-colors min-h-[160px]"
                        style={{ direction: targetLanguage === 'ar' || targetLanguage === 'ku' ? 'rtl' : 'ltr', fontFamily: 'inherit' }}
                        spellCheck={false}
                        rows={Math.max(4, transcription.split('\n').length + 1)}
                      />
                    ) : (
                      <p className="text-[#e8e8e8] text-xl sm:text-2xl md:text-3xl leading-relaxed whitespace-pre-wrap cursor-text"
                        onClick={() => { setIsEditingTranscription(true); setTimeout(() => editableRef.current?.focus(), 50); }}
                        title="کلیک بکە بۆ دەستکاریکردن"
                      >{transcription}</p>
                    )}
                  </div>
                  {/* Summary panel */}
                  <AnimatePresence>
                    {showSummary && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                        className="border-t border-[#a855f7]/20 overflow-hidden"
                      >
                        <div className="px-5 sm:px-7 py-4">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Sparkles size={13} className="text-[#a855f7]" />
                              <span className="text-[10px] uppercase tracking-widest text-[#a855f7] font-bold">پوختەی زیرەکی دەستکرد</span>
                            </div>
                            <div className="flex gap-2">
                              {summary && !isSummarizing && (
                                <button onClick={() => copyText(summary)} className="text-[10px] text-[#555] hover:text-[#a855f7] transition-colors uppercase tracking-wider">کۆپی</button>
                              )}
                              <button onClick={() => setShowSummary(false)} className="text-[#555] hover:text-white transition-colors"><X size={13} /></button>
                            </div>
                          </div>
                          {isSummarizing && !summary ? (
                            <div className="flex items-center gap-2 text-[#666] text-sm py-2">
                              <Loader2 size={14} className="animate-spin text-[#a855f7]" />
                              <span>Gemini پوختەکان دەردەهێنێت...</span>
                            </div>
                          ) : (
                            <p className="text-[#ccc] text-base leading-relaxed whitespace-pre-wrap">{summary}</p>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="px-5 sm:px-7 pb-5 flex items-center gap-3" dir="ltr">
                    <div className="flex-1 h-px bg-[#ff4e00]/40 rounded-full" />
                    <span className="text-[10px] font-mono text-[#444] tracking-widest">{isEditingTranscription ? 'EDITING' : 'COMPLETE'}</span>
                  </div>
                </motion.section>
              )}
            </AnimatePresence>
          </>
        ) : (
          /* ── LIBRARY ── */
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="bg-[#141416] rounded-2xl border border-[#ffffff10] shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 sm:px-7 py-4 border-b border-[#ffffff08]">
              <div className="flex items-center gap-2">
                <History size={15} className="text-[#555]" />
                <span className="text-[10px] uppercase tracking-widest text-[#555] font-bold" dir="ltr">Transcription Library</span>
                {history.length > 0 && (
                  <span className="text-[10px] px-2 py-0.5 bg-[#ffffff08] rounded-full text-[#666]">
                    {librarySearch ? `${history.filter(h => h.text.toLowerCase().includes(librarySearch.toLowerCase())).length} / ${history.length}` : history.length}
                  </span>
                )}
              </div>
              {history.length > 0 && (
                <button onClick={() => setDeleteConfirmId('all')}
                  className="flex items-center gap-1.5 text-[#555] hover:text-[#ff4e00] transition-colors text-[10px] uppercase tracking-wider"
                >
                  <Trash2 size={13} />سڕینەوەی هەمووی
                </button>
              )}
            </div>

            {/* Search bar */}
            {history.length > 0 && (
              <div className="px-5 sm:px-7 py-3 border-b border-[#ffffff06]">
                <div className="relative">
                  <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#444] pointer-events-none" />
                  <input
                    type="text"
                    value={librarySearch}
                    onChange={e => setLibrarySearch(e.target.value)}
                    placeholder="گەڕان لە مێژوودا..."
                    dir="rtl"
                    className="w-full bg-[#0a0a0b] border border-[#ffffff08] rounded-lg pr-9 pl-9 py-2.5 text-sm text-[#e0e0e0] placeholder-[#444] outline-none focus:border-[#ff4e00]/40 transition-colors"
                  />
                  {librarySearch && (
                    <button onClick={() => setLibrarySearch('')} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#444] hover:text-[#aaa] transition-colors">
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {historyLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="animate-spin text-[#ff4e00]" size={24} />
              </div>
            ) : history.length > 0 ? (() => {
              const filtered = librarySearch
                ? history.filter(h => h.text.toLowerCase().includes(librarySearch.toLowerCase()))
                : history;
              return filtered.length > 0 ? (
              <div className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map(item => (
                  <div key={item.id} className="bg-[#0f0f11] p-4 sm:p-5 rounded-xl border border-[#ffffff06] flex flex-col gap-3 hover:border-[#ffffff12] transition-colors">
                    <div className="flex justify-between items-start gap-2" dir="ltr">
                      <span className="flex items-center gap-1 text-[#444] text-[10px] font-mono">
                        <Clock size={10} />
                        {new Date(item.timestamp).toLocaleDateString()} {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <div className="flex gap-1.5 shrink-0">
                        {item.model && <span className="bg-[#1a1a1c] px-1.5 py-0.5 rounded text-[9px] text-[#666] border border-[#ffffff12] uppercase">{item.model}</span>}
                        <span className="bg-[#ff4e00]/10 px-1.5 py-0.5 rounded text-[9px] text-[#ff4e00] border border-[#ff4e00]/20 uppercase">{item.language === 'ku' ? 'KU' : 'AR'}</span>
                      </div>
                    </div>
                    <p className="text-[#ccc] text-base leading-relaxed line-clamp-4 flex-1">{item.text}</p>
                    <div className="flex justify-between items-center pt-3 border-t border-[#ffffff06]">
                      <span className="text-[10px] text-[#333] font-mono">#{item.id.slice(-6)}</span>
                      <div className="flex gap-1.5">
                        <button onClick={() => setDeleteConfirmId(item.id)}
                          className="p-1.5 text-[#444] hover:text-[#ff4e00] bg-[#1a1a1c] border border-[#ffffff08] rounded-lg transition-colors"
                        ><Trash2 size={12} /></button>
                        <button onClick={() => copyText(item.text, item.id)}
                          className="p-1.5 text-[#444] hover:text-white bg-[#1a1a1c] border border-[#ffffff08] rounded-lg transition-colors"
                        >{copiedId === item.id ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}</button>
                        <button onClick={() => exportText('txt', item.text)}
                          title="دابگرە بە .TXT"
                          className="p-1.5 text-[#444] hover:text-[#ff4e00] bg-[#1a1a1c] border border-[#ffffff08] rounded-lg transition-colors"
                        ><Download size={12} /></button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                  <Search size={36} className="text-[#ffffff08] mb-3" />
                  <p className="text-[#444] text-sm">هیچ ئەنجامێک نەدۆزرایەوە بۆ «{librarySearch}»</p>
                  <button onClick={() => setLibrarySearch('')} className="mt-3 text-[10px] text-[#ff4e00] hover:underline">سڕینەوەی گەڕان</button>
                </div>
              );
            })() : (
              <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
                <History size={40} className="text-[#ffffff08] mb-4" />
                <p className="text-[#444] text-sm">هیچ مێژوویەک بوونی نییە</p>
              </div>
            )}
          </motion.section>
        )}
      </main>

      <footer className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex items-center justify-between text-[#333] font-mono text-[10px] uppercase tracking-widest" dir="ltr">
        <span>VoxScript</span>
        <span>Powered by Gemini AI</span>
      </footer>

      {/* Cookie Error Modal */}
      <AnimatePresence>
        {cookieError && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
          >
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="bg-[#141416] border border-[#ffffff10] rounded-2xl p-6 sm:p-8 shadow-2xl max-w-sm w-full text-center"
            >
              <h3 className="text-xl font-bold text-white mb-3">پێویست بە ڕێگەپێدانی کووکی دەکات</h3>
              <p className="text-[#888] text-sm mb-6 leading-relaxed">تکایە ئەپەکە لە تابێکی نوێ بکەرەوە.</p>
              <div className="flex flex-col gap-2">
                <button onClick={() => { window.open(window.location.href, '_blank'); setCookieError(false); }}
                  className="w-full py-3 text-sm font-bold bg-[#ff4e00] text-white rounded-xl hover:bg-[#e64600] transition-colors"
                >کردنەوەی تابێکی نوێ</button>
                <button onClick={() => setCookieError(false)} className="w-full py-2.5 text-sm text-[#555] hover:text-white transition-colors">داخستن</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirm Modal */}
      <AnimatePresence>
        {deleteConfirmId && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="bg-[#141416] border border-[#ffffff10] rounded-2xl p-6 shadow-2xl max-w-xs w-full"
            >
              <h3 className="text-lg font-bold text-white mb-2">
                {deleteConfirmId === 'all' ? 'سڕینەوەی هەموو مێژووەکە' : 'سڕینەوەی مێژوو'}
              </h3>
              <p className="text-[#666] text-sm mb-5 leading-relaxed">
                {deleteConfirmId === 'all' ? 'دڵنیای کە دەتەوێت هەموو مێژووەکە بسڕیتەوە؟' : 'دڵنیای کە دەتەوێت ئەم مێژووە بسڕیتەوە؟'}
              </p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setDeleteConfirmId(null)} className="px-4 py-2 text-sm text-[#666] hover:text-white transition-colors rounded-lg">پاشگەزبوونەوە</button>
                <button onClick={confirmDelete} className="px-4 py-2 text-sm font-medium bg-[#ff4e00] text-white rounded-lg hover:bg-[#e64600] transition-colors">بەڵێ، بسڕەوە</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Close user menu on outside click */}
      {showUserMenu && <div className="fixed inset-0 z-20" onClick={() => setShowUserMenu(false)} />}
      {/* Close export menu on outside click */}
      {showExportMenu && <div className="fixed inset-0 z-20" onClick={() => setShowExportMenu(false)} />}
      {/* Close share menu on outside click */}
      {showShareMenu && <div className="fixed inset-0 z-20" onClick={() => setShowShareMenu(false)} />}
    </div>
  );
}
