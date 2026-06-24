/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, Square, Upload, Copy, Check, Volume2, FileAudio, Loader2, Trash2, History, Clock } from "lucide-react";

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
  const [selectedModel, setSelectedModel] = useState<'gemini' | 'scribe'>('gemini');
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
      } catch {
        return [];
      }
    }
    return [];
  });
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | 'all' | null>(null);

  const confirmDelete = () => {
    if (deleteConfirmId === 'all') {
      setHistory([]);
      localStorage.removeItem('vox_history');
    } else if (deleteConfirmId) {
      setHistory(prev => {
        const newHistory = prev.filter(h => h.id !== deleteConfirmId);
        localStorage.setItem('vox_history', JSON.stringify(newHistory));
        return newHistory;
      });
    }
    setDeleteConfirmId(null);
  };
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/wav" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error accessing microphone:", err instanceof Error ? err.message : String(err));
      setError("نەتوانرا مایکرۆفۆن بکرێتەوە. تکایە مۆڵەت بدە.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > 100 * 1024 * 1024) {
        setError("قەبارەی فایلەکە زۆر گەورەیە. تکایە فایلێکی کەمتر لە ١٠٠ مێگابایت هەڵبژێرە.");
        return;
      }
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioBlob(file);
      setAudioUrl(URL.createObjectURL(file));
      setError(null);
    }
  };

  const transcribeAudio = async (overrideLanguage?: 'ku' | 'ar' | any) => {
    if (!audioBlob) return;

    let langToUse = targetLanguage;
    if (typeof overrideLanguage === 'string' && (overrideLanguage === 'ku' || overrideLanguage === 'ar')) {
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
      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      if (response.status === 404) {
        setError("هەڵەی 404: ڕاژەکە (API) نەدۆزرایەوە. ئەگەر ئەپەکەت لەسەر Vercel بڵاوکردۆتەوە، دەبێت بزانیت کە باکەندی ئەپەکە (server.ts) لەسەر Vercel بە شێوەیەکی ئۆتۆماتیکی کار ناکات.");
        setIsTranscribing(false);
        return;
      }

      const contentType = response.headers.get("content-type");
      if (response.status !== 404 && contentType && contentType.includes("text/html") && !response.ok) {
        setCookieError(true);
        setIsTranscribing(false);
        return;
      }

      if (!response.ok) {
        const errorText = await response.text();
        try {
          const data = JSON.parse(errorText);
          setError(data.error || "هەڵەیەک ڕوویدا لە کاتی گۆڕینی دەنگەکە.");
        } catch {
          setError("هەڵەیەک ڕوویدا لە کاتی گۆڕینی دەنگەکە.");
        }
        setIsTranscribing(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No reader");

      const decoder = new TextDecoder();
      let done = false;

      let fullText = "";
      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          fullText += chunk;
          setTranscription((prev) => prev + chunk);
        }
      }

      if (fullText.trim()) {
        const newItem: HistoryItem = {
          id: Date.now().toString(),
          text: fullText,
          language: langToUse,
          timestamp: Date.now(),
          model: selectedModel
        };
        setHistory(prev => {
          const updated = [newItem, ...prev];
          localStorage.setItem('vox_history', JSON.stringify(updated));
          return updated;
        });
      }
    } catch (err) {
      console.error("Transcription error:", err instanceof Error ? err.message : String(err));
      setError("پەیوەندی لەگەڵ سێرڤەر نییە.");
    } finally {
      setIsTranscribing(false);
    }
  };

  const fallbackCopyTextToClipboard = (text: string) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.error('Fallback: Oops, unable to copy', err instanceof Error ? err.message : String(err));
    }
    document.body.removeChild(textArea);
  };

  const copyText = (text: string, id: string | null = null) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => {
        fallbackCopyTextToClipboard(text);
      });
    } else {
      fallbackCopyTextToClipboard(text);
    }
    
    if (id) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } else {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const copyToClipboard = () => {
    copyText(transcription);
  };

  const reset = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setTranscription("");
    setError(null);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] font-sans text-[#e0e0e0] selection:bg-[#ff4e00]/30 p-4 md:p-8 flex flex-col items-center" dir="rtl">
      <header className="max-w-4xl w-full flex justify-between items-center mb-8 border-b border-[#ffffff10] pb-6 pt-4" dir="ltr">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center shadow-[0_0_20px_rgba(255,255,255,0.1)]">
            <div className="w-6 h-1 bg-[#0a0a0b] rounded-full rotate-45 absolute"></div>
            <div className="w-6 h-1 bg-[#0a0a0b] rounded-full -rotate-45"></div>
          </div>
          <span className="text-2xl font-bold tracking-tighter text-white">VOX<span className="text-[#ff4e00]">SCRIPT</span></span>
        </div>
        <div className="flex gap-6 text-sm font-medium text-[#888]">
          <button 
            onClick={() => setActiveTab('transcribe')}
            className={`transition-colors ${activeTab === 'transcribe' ? 'text-white border-b-2 border-[#ff4e00] pb-1' : 'hover:text-[#bbb]'}`}
          >
            Transcribe
          </button>
          <button 
            onClick={() => setActiveTab('library')}
            className={`transition-colors ${activeTab === 'library' ? 'text-white border-b-2 border-[#ff4e00] pb-1' : 'hover:text-[#bbb]'}`}
          >
            Library
          </button>
        </div>
        <div className="px-4 py-2 bg-[#1a1a1c] border border-[#ffffff10] rounded-full text-[10px] uppercase tracking-widest font-mono hidden md:block">
          Status: <span className="text-green-500">● Ready</span>
        </div>
      </header>

      <main className="max-w-3xl w-full space-y-8">
        {activeTab === 'transcribe' ? (
          <>
            {/* Input Section */}
            <section className="bg-[#141416] border border-[#ffffff10] rounded-2xl p-6 md:p-8 shadow-2xl">
              <div className="flex flex-col items-center space-y-8">
                
                {/* Model and Language Selectors */}
                <div className="flex flex-col md:flex-row gap-4 w-full max-w-lg mb-2">
                  <div className="flex flex-col gap-2 flex-1">
                    <span className="text-[10px] uppercase tracking-widest text-[#888] font-bold text-center">زمان</span>
                    <div className="flex justify-center bg-[#0a0a0b] p-1 rounded-lg border border-[#ffffff10] w-full relative">
                      <div 
                        className="absolute top-1 bottom-1 w-[calc(50%-4px)] bg-[#1a1a1c] border border-[#ffffff10] rounded-md transition-all duration-300 ease-in-out"
                        style={{ right: targetLanguage === 'ku' ? '4px' : 'calc(50%)' }}
                      />
                      <button 
                        onClick={() => setTargetLanguage('ku')}
                        className={`flex-1 py-2 text-sm font-medium transition-colors relative z-10 ${targetLanguage === 'ku' ? 'text-white' : 'text-[#888] hover:text-[#bbb]'}`}
                      >
                        کوردی
                      </button>
                      <button 
                        onClick={() => setTargetLanguage('ar')}
                        className={`flex-1 py-2 text-sm font-medium transition-colors relative z-10 ${targetLanguage === 'ar' ? 'text-white' : 'text-[#888] hover:text-[#bbb]'}`}
                      >
                        عەرەبی
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 flex-1">
                    <span className="text-[10px] uppercase tracking-widest text-[#888] font-bold text-center">مۆدێل</span>
                    <div className="flex justify-center bg-[#0a0a0b] p-1 rounded-lg border border-[#ffffff10] w-full">
                      <select 
                        value={selectedModel} 
                        onChange={(e) => setSelectedModel(e.target.value as any)}
                        className="w-full bg-transparent text-sm font-medium text-white py-2 px-3 outline-none cursor-pointer appearance-none text-center"
                        dir="ltr"
                      >
                        <option value="gemini" className="bg-[#1a1a1c]">Gemini 2.5 Flash</option>
                        <option value="scribe" className="bg-[#1a1a1c]">ElevenLabs Scribe</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 flex-1">
                    <span className="text-[10px] uppercase tracking-widest text-[#888] font-bold text-center">بچووککردنەوەی قەبارە (Compress)</span>
                    <label className="flex items-center justify-center gap-2 bg-[#0a0a0b] p-3 rounded-lg border border-[#ffffff10] w-full cursor-pointer hover:border-[#ffffff20] transition-colors">
                      <input 
                        type="checkbox" 
                        checked={shouldCompress}
                        onChange={(e) => setShouldCompress(e.target.checked)}
                        className="w-4 h-4 accent-[#ff4e00] rounded bg-[#1a1a1c] border-[#ffffff20] focus:ring-0 focus:ring-offset-0"
                      />
                      <span className="text-sm font-medium text-white select-none">
                        بەڵێ
                      </span>
                    </label>
                  </div>
                </div>

                <div className="flex justify-center gap-6 w-full">
                  {!isRecording ? (
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={startRecording}
                      disabled={isTranscribing}
                      className="flex flex-col items-center gap-3 p-6 rounded-2xl bg-[#1a1a1c] border border-[#ffffff10] text-[#e0e0e0] hover:bg-[#222] transition-all w-1/2 disabled:opacity-50 group"
                    >
                      <div className="p-4 bg-[#ff4e00] text-white rounded-full ring-4 ring-[#ff4e00]/20 group-hover:scale-110 transition-transform">
                        <Mic size={24} />
                      </div>
                      <span className="text-[10px] uppercase tracking-widest text-[#888] font-bold mt-2">تۆمارکردن</span>
                    </motion.button>
                  ) : (
                    <motion.button
                      initial={{ scale: 0.9 }}
                      animate={{ scale: [1, 1.05, 1], transition: { repeat: Infinity, duration: 1.5 } }}
                      onClick={stopRecording}
                      className="flex flex-col items-center gap-3 p-6 rounded-2xl bg-[#ff4e00]/10 border border-[#ff4e00]/30 text-[#ff4e00] hover:bg-[#ff4e00]/20 transition-all w-1/2"
                    >
                      <div className="p-4 bg-[#ff4e00] text-white rounded-full shadow-[0_0_15px_rgba(255,78,0,0.5)]">
                        <Square size={24} fill="currentColor" />
                      </div>
                      <span className="text-[10px] uppercase tracking-widest text-[#ff4e00] font-bold mt-2">ڕاگرتن</span>
                    </motion.button>
                  )}

                  <label className="flex flex-col items-center gap-3 p-6 rounded-2xl bg-[#141416] text-[#888] hover:bg-[#1a1a1c] transition-all w-1/2 cursor-pointer border border-dashed border-[#ffffff20] hover:border-[#ffffff40]">
                    <div className="p-4 bg-[#1a1a1c] border border-[#ffffff10] text-[#e0e0e0] rounded-full">
                      <Upload size={24} />
                    </div>
                    <span className="text-[10px] uppercase tracking-widest font-bold mt-2">بارکردنی فایل</span>
                    <input type="file" accept="audio/*" onChange={handleFileUpload} className="hidden" disabled={isTranscribing} />
                  </label>
                </div>

                <AnimatePresence mode="wait">
                  {audioBlob && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="w-full flex flex-col items-center gap-6 pt-6 border-t border-[#ffffff05]"
                    >
                      <div className="flex items-center justify-between w-full bg-[#1a1a1c] px-4 py-3 rounded-xl border border-[#ffffff10]">
                        <div className="flex items-center gap-3">
                          <FileAudio size={18} className="text-[#ff4e00]" />
                          <div className="flex flex-col">
                            <span className="text-[11px] font-mono tracking-wider text-[#e0e0e0] uppercase" dir="ltr">AUDIO_INPUT.WAV</span>
                            {audioBlob && (
                              <span className="text-[10px] font-mono tracking-wider text-[#888]" dir="ltr">
                                {(audioBlob.size / (1024 * 1024)).toFixed(2)} MB
                              </span>
                            )}
                          </div>
                        </div>
                        <button onClick={reset} className="text-[#888] hover:text-[#ff4e00] transition-colors p-1">
                          <Trash2 size={16} />
                        </button>
                      </div>

                      {audioUrl && (
                        <div className="w-full bg-[#0a0a0b] rounded-xl border border-[#ffffff10] p-3 overflow-hidden shadow-inner">
                          <audio controls src={audioUrl} className="w-full h-10 outline-none" style={{ colorScheme: 'dark' }} />
                        </div>
                      )}

                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => transcribeAudio()}
                        disabled={isTranscribing}
                        className="w-full py-4 rounded-xl bg-[#ff4e00] text-white font-bold text-xs tracking-[0.2em] uppercase shadow-[0_0_20px_rgba(255,78,0,0.3)] hover:shadow-[0_0_30px_rgba(255,78,0,0.5)] hover:bg-[#e64600] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
                        dir="ltr"
                      >
                        {isTranscribing ? (
                          <>
                            <Loader2 className="animate-spin" size={18} />
                            {shouldCompress ? "COMPRESSING & PROCESSING..." : "PROCESSING..."}
                          </>
                        ) : (
                          "TRANSCRIBE AUDIO"
                        )}
                      </motion.button>
                    </motion.div>
                  )}
                </AnimatePresence>

                {error && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-[#ff4e00] text-[11px] font-mono tracking-wider bg-[#ff4e00]/10 border border-[#ff4e00]/20 px-4 py-3 rounded-lg w-full text-center mt-2"
                  >
                    {error}
                  </motion.div>
                )}
              </div>
            </section>

            {/* Results Section */}
            <AnimatePresence>
              {transcription && (
                <motion.section
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-[#141416] rounded-2xl p-8 md:p-10 shadow-2xl border border-[#ffffff10] relative"
                >
                  <div className="flex justify-between items-center mb-8 pb-4 border-b border-[#ffffff05]" dir="ltr">
                    <h3 className="text-[10px] uppercase tracking-widest text-[#888] font-bold">Transcription Output</h3>
                    <div className="flex items-center gap-3">
                      {targetLanguage === 'ku' && audioBlob && !isTranscribing && (
                        <button
                          onClick={() => transcribeAudio('ar')}
                          className="flex items-center gap-2 px-3 py-1.5 bg-[#ff4e00]/10 border border-[#ff4e00]/30 rounded text-[10px] uppercase tracking-wider hover:bg-[#ff4e00]/20 text-[#ff4e00] transition-colors font-bold"
                        >
                          وەرگێڕان بۆ عەرەبی
                        </button>
                      )}
                      <button
                        onClick={copyToClipboard}
                        className="flex items-center gap-2 px-3 py-1.5 bg-[#1a1a1c] border border-[#ffffff10] rounded text-[10px] uppercase tracking-wider hover:bg-[#222] text-[#e0e0e0] transition-colors"
                      >
                        {copied ? (
                          <>
                            <Check size={14} className="text-green-400" />
                            COPIED
                          </>
                        ) : (
                          <>
                            <Copy size={14} />
                            COPY
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="bg-transparent min-h-[150px] leading-relaxed text-[#e0e0e0] text-2xl md:text-3xl whitespace-pre-wrap font-sans">
                    {transcription}
                  </div>
                  <div className="mt-8 flex items-center gap-4 pt-4" dir="ltr">
                    <div className="flex-1 h-1 bg-[#1a1a1c] rounded-full overflow-hidden">
                      <div className="w-full h-full bg-[#ff4e00]"></div>
                    </div>
                    <span className="text-[10px] font-mono text-[#888] tracking-widest">COMPLETE</span>
                  </div>
                </motion.section>
              )}
            </AnimatePresence>
          </>
        ) : (
          <motion.section
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-[#141416] rounded-2xl p-6 md:p-8 border border-[#ffffff10] shadow-2xl"
          >
            <div className="flex items-center justify-between mb-8 border-b border-[#ffffff05] pb-6">
              <div className="flex items-center gap-2">
                <History size={18} className="text-[#888]" />
                <h3 className="text-[10px] uppercase tracking-widest text-[#888] font-bold" dir="ltr">Transcription Library</h3>
              </div>
              <button
                onClick={() => setDeleteConfirmId('all')}
                className="text-[#888] hover:text-[#ff4e00] transition-colors flex items-center gap-2 text-[10px] uppercase tracking-wider"
              >
                <Trash2 size={14} />
                سڕینەوەی هەمووی
              </button>
            </div>
            
            {history.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {history.map((item) => (
                  <div key={item.id} className="bg-[#0a0a0b] p-6 rounded-2xl border border-[#ffffff05] flex flex-col gap-4 shadow-lg hover:border-[#ffffff10] transition-colors">
                    <div className="flex justify-between items-center text-[#888] text-[10px] font-mono tracking-widest uppercase" dir="ltr">
                      <span className="flex items-center gap-1.5">
                        <Clock size={12} />
                        {new Date(item.timestamp).toLocaleDateString()} {new Date(item.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                      </span>
                      <div className="flex gap-2">
                        {item.model && (
                          <span className="bg-[#1a1a1c] px-2 py-1 rounded text-[#bbb] border border-[#ffffff20]">
                            {item.model.toUpperCase()}
                          </span>
                        )}
                        <span className="bg-[#1a1a1c] px-2 py-1 rounded text-[#ff4e00] border border-[#ff4e00]/20">
                          {item.language === 'ku' ? 'KURDISH' : 'ARABIC'}
                        </span>
                      </div>
                    </div>
                    <div className="text-[#e0e0e0] text-lg leading-relaxed font-sans line-clamp-4 flex-1">
                      {item.text}
                    </div>
                    <div className="flex justify-between items-center pt-4 border-t border-[#ffffff05] mt-2">
                      <span className="text-[10px] text-[#555] font-mono">ID: {item.id.slice(-6)}</span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setDeleteConfirmId(item.id)}
                          className="text-[#888] hover:text-[#ff4e00] transition-colors text-[10px] uppercase tracking-wider flex items-center gap-1.5 bg-[#1a1a1c] px-3 py-1.5 rounded border border-[#ffffff10]"
                        >
                          <Trash2 size={12} />
                          سڕینەوە
                        </button>
                        <button
                          onClick={() => copyText(item.text, item.id)}
                          className="text-[#888] hover:text-[#e0e0e0] transition-colors text-[10px] uppercase tracking-wider flex items-center gap-1.5 bg-[#1a1a1c] px-3 py-1.5 rounded border border-[#ffffff10]"
                        >
                          {copiedId === item.id ? (
                            <>
                              <Check size={12} className="text-green-400" />
                              COPIED
                            </>
                          ) : (
                            <>
                              <Copy size={12} />
                              کۆپی
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-20">
                <History size={48} className="mx-auto text-[#ffffff10] mb-4" />
                <p className="text-[#888] text-sm tracking-wide">هیچ مێژوویەک بوونی نییە</p>
              </div>
            )}
          </motion.section>
        )}
      </main>

      <footer className="mt-auto pt-12 pb-6 text-[#444] font-mono text-[10px] tracking-[0.2em] uppercase flex flex-col items-center gap-2" dir="ltr">
        <div className="flex items-center gap-2">
          <span>STATUS:</span>
          <span className="text-green-500">● ONLINE</span>
        </div>
        <div>POWERED BY GEMINI AI</div>
      </footer>

      <AnimatePresence>
        {cookieError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#141416] border border-[#ffffff10] rounded-2xl p-8 shadow-2xl max-w-md w-full text-center"
            >
              <h3 className="text-2xl font-bold text-white mb-4">
                پێویست بە ڕێگەپێدانی کووکی دەکات
              </h3>
              <p className="text-[#bbb] text-sm mb-8 leading-relaxed">
                بەهۆی ڕێکارە ئەمنییەکانی وێبگەڕەکەتەوە (وەک Safari یان زانیاری پاراستن) ناتوانرێت دەنگەکە بنێردرێت لەم پەنجەرەیەدا. تکایە ئەپەکە لە تابێکی نوێ بکەرەوە بۆ ئەوەی بە بێ کێشە کار بکات.
              </p>
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => {
                    window.open(window.location.href, '_blank');
                    setCookieError(false);
                  }}
                  className="w-full py-3 text-sm font-bold bg-[#ff4e00] text-white rounded-xl hover:bg-[#e64600] transition-colors shadow-[0_0_20px_rgba(255,78,0,0.4)]"
                >
                  کردنەوەی ئەپەکە لە تابێکی نوێ
                </button>
                <button
                  onClick={() => setCookieError(false)}
                  className="w-full py-3 text-sm font-medium text-[#888] hover:text-white transition-colors"
                >
                  داخستن
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteConfirmId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#141416] border border-[#ffffff10] rounded-2xl p-6 shadow-2xl max-w-sm w-full"
            >
              <h3 className="text-xl font-bold text-white mb-2">
                {deleteConfirmId === 'all' ? 'سڕینەوەی هەموو مێژووەکە' : 'سڕینەوەی مێژوو'}
              </h3>
              <p className="text-[#888] text-sm mb-6 leading-relaxed">
                {deleteConfirmId === 'all'
                  ? 'دڵنیای کە دەتەوێت هەموو مێژووەکە بسڕیتەوە؟ ئەم کردارە گەڕانەوەی بۆ نییە.'
                  : 'دڵنیای کە دەتەوێت ئەم مێژووە بسڕیتەوە؟ ئەم کردارە گەڕانەوەی بۆ نییە.'}
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="px-4 py-2 text-sm font-medium text-[#888] hover:text-white transition-colors"
                >
                  پاشگەزبوونەوە
                </button>
                <button
                  onClick={confirmDelete}
                  className="px-4 py-2 text-sm font-medium bg-[#ff4e00] text-white rounded-lg hover:bg-[#e64600] transition-colors shadow-[0_0_15px_rgba(255,78,0,0.3)]"
                >
                  بەڵێ، بسڕەوە
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
