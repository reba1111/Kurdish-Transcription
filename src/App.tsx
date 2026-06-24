/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, Square, Upload, Copy, Check, FileAudio, Loader2, Trash2, History, Clock, ChevronDown } from "lucide-react";

type HistoryItem = {
  id: string;
  text: string;
  language: 'ku' | 'ar';
  timestamp: number;
  model?: string;
};

export default function App() {
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
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const saved = localStorage.getItem('vox_history');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.filter((item: any) => {
          if (!item || !item.text) return false;
          const lowerText = item.text.toLowerCase();
          return !lowerText.includes('<!doctype html>') && !lowerText.includes('cookie check');
        });
      } catch { return []; }
    }
    return [];
  });
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | 'all' | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const confirmDelete = () => {
    if (deleteConfirmId === 'all') {
      setHistory([]);
      localStorage.removeItem('vox_history');
    } else if (deleteConfirmId) {
      setHistory(prev => {
        const next = prev.filter(h => h.id !== deleteConfirmId);
        localStorage.setItem('vox_history', JSON.stringify(next));
        return next;
      });
    }
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
  };

  const transcribeAudio = async (overrideLanguage?: 'ku' | 'ar') => {
    if (!audioBlob) return;
    let langToUse = targetLanguage;
    if (overrideLanguage === 'ku' || overrideLanguage === 'ar') {
      langToUse = overrideLanguage;
      setTargetLanguage(overrideLanguage);
    }
    setIsTranscribing(true);
    setError(null);
    setTranscription("");
    const formData = new FormData();
    formData.append("audio", audioBlob);
    formData.append("language", langToUse);
    formData.append("model", selectedModel);
    formData.append("compress", shouldCompress ? "true" : "false");
    try {
      const response = await fetch("/api/transcribe", { method: "POST", body: formData });
      if (response.status === 404) {
        setError("هەڵەی 404: API نەدۆزرایەوە.");
        return;
      }
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("text/html") && !response.ok) {
        setCookieError(true);
        return;
      }
      if (!response.ok) {
        const txt = await response.text();
        try { setError(JSON.parse(txt).error || "هەڵەیەک ڕوویدا."); }
        catch { setError("هەڵەیەک ڕوویدا لە کاتی گۆڕینی دەنگەکە."); }
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No reader");
      const decoder = new TextDecoder();
      let fullText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          fullText += chunk;
          setTranscription(p => p + chunk);
        }
      }
      if (fullText.trim()) {
        const newItem: HistoryItem = { id: Date.now().toString(), text: fullText, language: langToUse, timestamp: Date.now(), model: selectedModel };
        setHistory(prev => {
          const updated = [newItem, ...prev].slice(0, 100);
          localStorage.setItem('vox_history', JSON.stringify(updated));
          return updated;
        });
      }
    } catch {
      setError("پەیوەندی لەگەڵ سێرڤەر نییە.");
    } finally {
      setIsTranscribing(false);
    }
  };

  const copyText = (text: string, id: string | null = null) => {
    const write = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      Object.assign(ta.style, { position: "fixed", top: "0", left: "0" });
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(write);
    } else { write(); }
    if (id) { setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); }
    else { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  const reset = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null); setAudioUrl(null); setTranscription(""); setError(null);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] font-sans text-[#e0e0e0] selection:bg-[#ff4e00]/30" dir="rtl">

      {/* ── HEADER ── */}
      <header className="sticky top-0 z-30 bg-[#0a0a0b]/90 backdrop-blur border-b border-[#ffffff10]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0" dir="ltr">
            <div className="w-8 h-8 sm:w-9 sm:h-9 bg-white rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(255,255,255,0.1)] relative">
              <div className="w-5 h-0.5 bg-[#0a0a0b] rounded-full rotate-45 absolute"></div>
              <div className="w-5 h-0.5 bg-[#0a0a0b] rounded-full -rotate-45"></div>
            </div>
            <span className="text-lg sm:text-xl font-bold tracking-tighter text-white">VOX<span className="text-[#ff4e00]">SCRIPT</span></span>
          </div>

          {/* Nav tabs */}
          <nav className="flex gap-1 bg-[#141416] border border-[#ffffff10] rounded-lg p-1" dir="ltr">
            {(['transcribe', 'library'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 sm:px-4 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all ${
                  activeTab === tab
                    ? 'bg-[#ff4e00] text-white shadow-sm'
                    : 'text-[#888] hover:text-white'
                }`}
              >
                {tab === 'transcribe' ? 'Transcribe' : 'Library'}
                {tab === 'library' && history.length > 0 && (
                  <span className={`mr-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${activeTab === 'library' ? 'bg-white/20' : 'bg-[#ffffff15]'}`}>
                    {history.length}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Status */}
          <div className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono text-[#555] uppercase tracking-widest">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
            Online
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">

        {activeTab === 'transcribe' ? (
          <>
            {/* ── CONTROLS ── */}
            <section className="bg-[#141416] border border-[#ffffff10] rounded-2xl overflow-hidden shadow-2xl">

              {/* Settings row */}
              <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#ffffff08] border-b border-[#ffffff08]">
                {/* Language */}
                <div className="p-4 flex flex-col gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-[#555] font-bold">زمان</span>
                  <div className="flex bg-[#0a0a0b] p-1 rounded-lg border border-[#ffffff08] relative">
                    <div
                      className="absolute top-1 bottom-1 w-[calc(50%-4px)] bg-[#ff4e00]/15 border border-[#ff4e00]/30 rounded-md transition-all duration-300"
                      style={{ right: targetLanguage === 'ku' ? '4px' : 'calc(50%)' }}
                    />
                    {(['ku', 'ar'] as const).map(lang => (
                      <button
                        key={lang}
                        onClick={() => setTargetLanguage(lang)}
                        className={`flex-1 py-2 text-sm font-medium transition-colors relative z-10 ${targetLanguage === lang ? 'text-white' : 'text-[#666] hover:text-[#aaa]'}`}
                      >
                        {lang === 'ku' ? 'کوردی' : 'عەرەبی'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Model */}
                <div className="p-4 flex flex-col gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-[#555] font-bold">مۆدێل</span>
                  <div className="relative">
                    <select
                      value={selectedModel}
                      onChange={e => setSelectedModel(e.target.value as any)}
                      className="w-full bg-[#0a0a0b] border border-[#ffffff08] text-sm font-medium text-white py-2.5 pl-3 pr-8 rounded-lg outline-none cursor-pointer appearance-none"
                      dir="ltr"
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
                    <div
                      onClick={() => setShouldCompress(p => !p)}
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
                    <motion.button
                      whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                      onClick={startRecording}
                      disabled={isTranscribing}
                      className="flex flex-col items-center gap-3 p-5 sm:p-7 rounded-2xl bg-[#1a1a1c] border border-[#ffffff08] hover:border-[#ff4e00]/30 hover:bg-[#1e1e20] transition-all disabled:opacity-40 group"
                    >
                      <div className="p-3.5 sm:p-4 bg-[#ff4e00] text-white rounded-full ring-4 ring-[#ff4e00]/15 group-hover:ring-[#ff4e00]/30 group-hover:scale-105 transition-all">
                        <Mic size={22} />
                      </div>
                      <span className="text-[10px] sm:text-xs uppercase tracking-widest text-[#666] font-bold">تۆمارکردن</span>
                    </motion.button>
                  ) : (
                    <motion.button
                      animate={{ scale: [1, 1.03, 1], transition: { repeat: Infinity, duration: 1.5 } }}
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

                {/* Audio preview + transcribe button */}
                <AnimatePresence>
                  {audioBlob && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="mt-4 space-y-3"
                    >
                      <div className="flex items-center justify-between bg-[#0a0a0b] px-4 py-3 rounded-xl border border-[#ffffff08]">
                        <div className="flex items-center gap-3 min-w-0">
                          <FileAudio size={16} className="text-[#ff4e00] shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-mono text-white truncate" dir="ltr">AUDIO_INPUT</p>
                            <p className="text-[10px] font-mono text-[#555]" dir="ltr">{(audioBlob.size / (1024 * 1024)).toFixed(2)} MB</p>
                          </div>
                        </div>
                        <button onClick={reset} className="text-[#555] hover:text-[#ff4e00] transition-colors p-1.5 shrink-0">
                          <Trash2 size={15} />
                        </button>
                      </div>

                      {audioUrl && (
                        <div className="bg-[#0a0a0b] rounded-xl border border-[#ffffff08] p-2.5">
                          <audio controls src={audioUrl} className="w-full h-9 outline-none" style={{ colorScheme: 'dark' }} />
                        </div>
                      )}

                      <motion.button
                        whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}
                        onClick={() => transcribeAudio()}
                        disabled={isTranscribing}
                        className="w-full py-3.5 rounded-xl bg-[#ff4e00] text-white font-bold text-xs tracking-[0.15em] uppercase shadow-[0_0_20px_rgba(255,78,0,0.25)] hover:shadow-[0_0_30px_rgba(255,78,0,0.4)] hover:bg-[#e64600] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2.5"
                        dir="ltr"
                      >
                        {isTranscribing ? (
                          <><Loader2 className="animate-spin" size={16} />{shouldCompress ? "COMPRESSING & PROCESSING..." : "PROCESSING..."}</>
                        ) : "TRANSCRIBE AUDIO"}
                      </motion.button>
                    </motion.div>
                  )}
                </AnimatePresence>

                {error && (
                  <motion.div
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="mt-4 text-[#ff4e00] text-xs font-mono bg-[#ff4e00]/08 border border-[#ff4e00]/20 px-4 py-3 rounded-xl text-center"
                  >
                    {error}
                  </motion.div>
                )}
              </div>
            </section>

            {/* ── RESULT ── */}
            <AnimatePresence>
              {transcription && (
                <motion.section
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-[#141416] rounded-2xl border border-[#ffffff10] shadow-2xl overflow-hidden"
                >
                  {/* Result header */}
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-7 py-4 border-b border-[#ffffff08]" dir="ltr">
                    <span className="text-[10px] uppercase tracking-widest text-[#555] font-bold">Transcription Output</span>
                    <div className="flex items-center gap-2 flex-wrap">
                      {targetLanguage === 'ku' && audioBlob && !isTranscribing && (
                        <button
                          onClick={() => transcribeAudio('ar')}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#ff4e00]/10 border border-[#ff4e00]/25 rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#ff4e00]/20 text-[#ff4e00] transition-colors font-bold"
                        >
                          وەرگێڕان بۆ عەرەبی
                        </button>
                      )}
                      <button
                        onClick={() => copyText(transcription)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a1c] border border-[#ffffff10] rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#222] text-[#bbb] transition-colors"
                      >
                        {copied ? <><Check size={12} className="text-green-400" />COPIED</> : <><Copy size={12} />COPY</>}
                      </button>
                    </div>
                  </div>

                  {/* Result text */}
                  <div className="px-5 sm:px-7 py-6 text-[#e8e8e8] text-xl sm:text-2xl md:text-3xl leading-relaxed whitespace-pre-wrap min-h-[120px]">
                    {transcription}
                  </div>

                  <div className="px-5 sm:px-7 pb-5 flex items-center gap-3" dir="ltr">
                    <div className="flex-1 h-px bg-[#ff4e00]/40 rounded-full" />
                    <span className="text-[10px] font-mono text-[#444] tracking-widest">COMPLETE</span>
                  </div>
                </motion.section>
              )}
            </AnimatePresence>
          </>
        ) : (
          /* ── LIBRARY ── */
          <motion.section
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-[#141416] rounded-2xl border border-[#ffffff10] shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 sm:px-7 py-4 border-b border-[#ffffff08]">
              <div className="flex items-center gap-2">
                <History size={15} className="text-[#555]" />
                <span className="text-[10px] uppercase tracking-widest text-[#555] font-bold" dir="ltr">Transcription Library</span>
                {history.length > 0 && (
                  <span className="text-[10px] px-2 py-0.5 bg-[#ffffff08] rounded-full text-[#666]">{history.length}</span>
                )}
              </div>
              {history.length > 0 && (
                <button
                  onClick={() => setDeleteConfirmId('all')}
                  className="flex items-center gap-1.5 text-[#555] hover:text-[#ff4e00] transition-colors text-[10px] uppercase tracking-wider"
                >
                  <Trash2 size={13} />
                  سڕینەوەی هەمووی
                </button>
              )}
            </div>

            {history.length > 0 ? (
              <div className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {history.map(item => (
                  <div
                    key={item.id}
                    className="bg-[#0f0f11] p-4 sm:p-5 rounded-xl border border-[#ffffff06] flex flex-col gap-3 hover:border-[#ffffff12] transition-colors"
                  >
                    <div className="flex justify-between items-start gap-2" dir="ltr">
                      <span className="flex items-center gap-1 text-[#444] text-[10px] font-mono">
                        <Clock size={10} />
                        {new Date(item.timestamp).toLocaleDateString()} {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <div className="flex gap-1.5 shrink-0">
                        {item.model && (
                          <span className="bg-[#1a1a1c] px-1.5 py-0.5 rounded text-[9px] text-[#666] border border-[#ffffff12] uppercase">
                            {item.model}
                          </span>
                        )}
                        <span className="bg-[#ff4e00]/10 px-1.5 py-0.5 rounded text-[9px] text-[#ff4e00] border border-[#ff4e00]/20 uppercase">
                          {item.language === 'ku' ? 'KU' : 'AR'}
                        </span>
                      </div>
                    </div>

                    <p className="text-[#ccc] text-base leading-relaxed line-clamp-4 flex-1">{item.text}</p>

                    <div className="flex justify-between items-center pt-3 border-t border-[#ffffff06]">
                      <span className="text-[10px] text-[#333] font-mono">#{item.id.slice(-6)}</span>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => setDeleteConfirmId(item.id)}
                          className="p-1.5 text-[#444] hover:text-[#ff4e00] bg-[#1a1a1c] border border-[#ffffff08] rounded-lg transition-colors"
                        >
                          <Trash2 size={12} />
                        </button>
                        <button
                          onClick={() => copyText(item.text, item.id)}
                          className="p-1.5 text-[#444] hover:text-white bg-[#1a1a1c] border border-[#ffffff08] rounded-lg transition-colors"
                        >
                          {copiedId === item.id ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
                <History size={40} className="text-[#ffffff08] mb-4" />
                <p className="text-[#444] text-sm">هیچ مێژوویەک بوونی نییە</p>
              </div>
            )}
          </motion.section>
        )}
      </main>

      {/* ── FOOTER ── */}
      <footer className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex items-center justify-between text-[#333] font-mono text-[10px] uppercase tracking-widest" dir="ltr">
        <span>VoxScript</span>
        <span>Powered by Gemini AI</span>
      </footer>

      {/* ── COOKIE ERROR MODAL ── */}
      <AnimatePresence>
        {cookieError && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
          >
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="bg-[#141416] border border-[#ffffff10] rounded-2xl p-6 sm:p-8 shadow-2xl max-w-sm w-full text-center"
            >
              <h3 className="text-xl font-bold text-white mb-3">پێویست بە ڕێگەپێدانی کووکی دەکات</h3>
              <p className="text-[#888] text-sm mb-6 leading-relaxed">
                تکایە ئەپەکە لە تابێکی نوێ بکەرەوە بۆ ئەوەی بە بێ کێشە کار بکات.
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => { window.open(window.location.href, '_blank'); setCookieError(false); }}
                  className="w-full py-3 text-sm font-bold bg-[#ff4e00] text-white rounded-xl hover:bg-[#e64600] transition-colors"
                >
                  کردنەوەی تابێکی نوێ
                </button>
                <button onClick={() => setCookieError(false)} className="w-full py-2.5 text-sm text-[#555] hover:text-white transition-colors">
                  داخستن
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── DELETE CONFIRM MODAL ── */}
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
                {deleteConfirmId === 'all'
                  ? 'دڵنیای کە دەتەوێت هەموو مێژووەکە بسڕیتەوە؟'
                  : 'دڵنیای کە دەتەوێت ئەم مێژووە بسڕیتەوە؟'}
              </p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setDeleteConfirmId(null)}
                  className="px-4 py-2 text-sm text-[#666] hover:text-white transition-colors rounded-lg"
                >پاشگەزبوونەوە</button>
                <button onClick={confirmDelete}
                  className="px-4 py-2 text-sm font-medium bg-[#ff4e00] text-white rounded-lg hover:bg-[#e64600] transition-colors"
                >بەڵێ، بسڕەوە</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
