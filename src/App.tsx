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
};

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<string>("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetLanguage, setTargetLanguage] = useState<'ku' | 'ar'>('ku');
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const saved = localStorage.getItem('vox_history');
    return saved ? JSON.parse(saved) : [];
  });
  
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
      console.error("Error accessing microphone:", err);
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
      if (file.size > 10 * 1024 * 1024) {
        setError("قەبارەی فایلەکە زۆر گەورەیە. تکایە فایلێکی کەمتر لە ١٠ مێگابایت هەڵبژێرە.");
        return;
      }
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioBlob(file);
      setAudioUrl(URL.createObjectURL(file));
      setError(null);
    }
  };

  const transcribeAudio = async () => {
    if (!audioBlob) return;

    setIsTranscribing(true);
    setError(null);
    setTranscription("");

    const formData = new FormData();
    formData.append("audio", audioBlob);
    formData.append("language", targetLanguage);

    try {
      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

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
          language: targetLanguage,
          timestamp: Date.now()
        };
        setHistory(prev => {
          const updated = [newItem, ...prev];
          localStorage.setItem('vox_history', JSON.stringify(updated));
          return updated;
        });
      }
    } catch (err) {
      console.error("Transcription error:", err);
      setError("پەیوەندی لەگەڵ سێرڤەر نییە.");
    } finally {
      setIsTranscribing(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(transcription);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
      <header className="max-w-3xl w-full text-center mb-8 border-b border-[#ffffff10] pb-8 pt-4">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex flex-col items-center"
        >
          <div className="w-12 h-12 bg-white rounded-lg flex items-center justify-center mb-6 shadow-[0_0_20px_rgba(255,255,255,0.1)]">
            <div className="w-7 h-1.5 bg-[#0a0a0b] rounded-full rotate-45 absolute"></div>
            <div className="w-7 h-1.5 bg-[#0a0a0b] rounded-full -rotate-45"></div>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tighter text-white mb-2" dir="ltr">VOX<span className="text-[#ff4e00]">SCRIPT</span></h1>
          <p className="text-[#888] text-xs uppercase tracking-widest mt-2">دەنگەکانت بە ئاسانی بگۆڕە بۆ نوسینی کوردی یان عەرەبی</p>
        </motion.div>
      </header>

      <main className="max-w-3xl w-full space-y-8">
        {/* Input Section */}
        <section className="bg-[#141416] border border-[#ffffff10] rounded-2xl p-6 md:p-8 shadow-2xl">
          <div className="flex flex-col items-center space-y-8">
            <div className="flex justify-center bg-[#0a0a0b] p-1 rounded-lg border border-[#ffffff10] w-full max-w-sm mb-2 relative">
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
                      <span className="text-[11px] font-mono tracking-wider text-[#e0e0e0] uppercase" dir="ltr">AUDIO_INPUT.WAV</span>
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
                    onClick={transcribeAudio}
                    disabled={isTranscribing}
                    className="w-full py-4 rounded-xl bg-[#ff4e00] text-white font-bold text-xs tracking-[0.2em] uppercase shadow-[0_0_20px_rgba(255,78,0,0.3)] hover:shadow-[0_0_30px_rgba(255,78,0,0.5)] hover:bg-[#e64600] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
                    dir="ltr"
                  >
                    {isTranscribing ? (
                      <>
                        <Loader2 className="animate-spin" size={18} />
                        PROCESSING...
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

        {/* History Section */}
        {history.length > 0 && (
          <section className="bg-[#141416] rounded-2xl p-6 md:p-8 border border-[#ffffff10] shadow-2xl">
            <div className="flex items-center justify-between mb-6 border-b border-[#ffffff05] pb-4">
              <div className="flex items-center gap-2">
                <History size={18} className="text-[#888]" />
                <h3 className="text-[10px] uppercase tracking-widest text-[#888] font-bold" dir="ltr">Transcription History</h3>
              </div>
              <button
                onClick={() => {
                  setHistory([]);
                  localStorage.removeItem('vox_history');
                }}
                className="text-[#888] hover:text-[#ff4e00] transition-colors flex items-center gap-1 text-[10px] uppercase tracking-wider"
              >
                <Trash2 size={14} />
                سڕینەوە
              </button>
            </div>
            
            <div className="space-y-4">
              {history.map((item) => (
                <div key={item.id} className="bg-[#0a0a0b] p-4 rounded-xl border border-[#ffffff05] flex flex-col gap-3">
                  <div className="flex justify-between items-center text-[#888] text-[10px] font-mono tracking-widest uppercase" dir="ltr">
                    <span className="flex items-center gap-1">
                      <Clock size={12} />
                      {new Date(item.timestamp).toLocaleDateString()} {new Date(item.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="bg-[#1a1a1c] px-2 py-1 rounded text-[#ff4e00]">
                      {item.language === 'ku' ? 'KURDISH' : 'ARABIC'}
                    </span>
                  </div>
                  <div className="text-[#e0e0e0] text-sm md:text-base leading-relaxed font-sans line-clamp-3">
                    {item.text}
                  </div>
                  <div className="flex justify-end pt-2 border-t border-[#ffffff05]">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(item.text);
                      }}
                      className="text-[#888] hover:text-[#e0e0e0] transition-colors text-[10px] uppercase tracking-wider flex items-center gap-1"
                    >
                      <Copy size={12} />
                      کۆپی
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="mt-auto pt-12 pb-6 text-[#444] font-mono text-[10px] tracking-[0.2em] uppercase flex flex-col items-center gap-2" dir="ltr">
        <div className="flex items-center gap-2">
          <span>STATUS:</span>
          <span className="text-green-500">● ONLINE</span>
        </div>
        <div>POWERED BY GEMINI AI</div>
      </footer>
    </div>
  );
}
