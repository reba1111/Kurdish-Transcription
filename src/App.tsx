/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, Square, Upload, Copy, Check, FileAudio, Loader2, Trash2, History, Clock, ChevronDown, LogOut, User, Download, Pencil, X, Search, Share2, Sparkles, Sun, Moon, Monitor, SpellCheck } from "lucide-react";
import { onAuthStateChanged, signOut, type User as FirebaseUser } from "firebase/auth";
import { collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, limit, writeBatch, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase";
import AuthPage from "./AuthPage";
import ProfilePage from "./ProfilePage";
import { useTheme } from "./useTheme";
import { compressAudioToMp3 } from "./audioCompress";

// Vercel serverless functions reject any request body over 4.5MB (hard platform
// limit, not configurable). Audio above this raw size must be compressed client-side
// before upload regardless of the user's compression preference, or the upload will
// always fail with a 413 — this is a correctness floor, not a quality choice.
const VERCEL_BODY_SIZE_LIMIT = 4.5 * 1024 * 1024;

type HistoryItem = {
  id: string;
  text: string;
  language: 'ku' | 'ar';
  timestamp: number;
  model?: string;
};

// Matches the out-of-band chunk-progress markers the server interleaves into the
// streamed transcript for long audio files (see lib/audioChunker.ts on the server).
const CHUNK_PROGRESS_NUL = String.fromCharCode(0);
const CHUNK_PROGRESS_MARKER_RE = new RegExp(CHUNK_PROGRESS_NUL + "CHUNK_PROGRESS:(\\d+)/(\\d+)" + CHUNK_PROGRESS_NUL, "g");
// Marks the moment the server starts verifying a detected Quran ayah or Hadith
// (AlQuran Cloud lookup / Google Search Grounding), which adds noticeable latency.
const VERIFYING_SOURCES_MARKER_RE = new RegExp(CHUNK_PROGRESS_NUL + "VERIFYING_SOURCES" + CHUNK_PROGRESS_NUL, "g");
// Carries a JSON-encoded TimedWord[] chunk, embedded so the karaoke/subtitle word
// list arrives for free as part of the main transcription instead of needing a
// second audio call (see lib/audioChunker.ts's formatWordsMarker on the server).
const WORDS_MARKER_RE = new RegExp(CHUNK_PROGRESS_NUL + "WORDS:([\\s\\S]*?)" + CHUNK_PROGRESS_NUL, "g");

// Matches <quran surah="..." ayah="..." verified="true|false">text</quran> and
// <hadith narrator="..." verified="true|false">text</hadith> tags the server may embed
// in a Kurdish transcript when it recognizes recited Quran/Hadith (see lib/islamicTextVerifier.ts).
const QURAN_TAG_RE = /<quran surah="([^"]*)" ayah="([^"]*)"(?: verified="(true|false)")?>([\s\S]*?)<\/quran>/g;
const HADITH_TAG_RE = /<hadith narrator="([^"]*)"(?: verified="(true|false)")?>([\s\S]*?)<\/hadith>/g;

interface CitationSegment {
  kind: 'quran' | 'hadith';
  text: string;
  surah?: string;
  ayah?: string;
  verified?: boolean;
  narrator?: string;
}

/** Formats a citation segment as ﴿ayah text﴾ [سورة Name - آية N] / [رواه Narrator], matching the
 * Quranic-bracket convention used in printed Islamic texts. */
function formatCitationBracket(seg: CitationSegment): string {
  const quote = `﴿${seg.text}﴾`;
  const source = seg.kind === 'quran' ? `[سورة ${seg.surah} - آية ${seg.ayah}]` : `[رواه ${seg.narrator}]`;
  return `${quote} ${source}`;
}

/** Strips citation tags down to ﴿text﴾ [source] bracket notation, for copy/export/history. */
function stripCitationTags(text: string): string {
  return text
    .replace(QURAN_TAG_RE, (_m, surah, ayah, verified, inner) => formatCitationBracket({ kind: 'quran', surah, ayah, verified: verified === 'true', text: inner }))
    .replace(HADITH_TAG_RE, (_m, narrator, verified, inner) => formatCitationBracket({ kind: 'hadith', narrator, verified: verified === 'true', text: inner }));
}

/** Splits transcription text into plain-text and citation segments for rendering. */
function parseCitationSegments(text: string): (string | CitationSegment)[] {
  const combined = new RegExp(`${QURAN_TAG_RE.source}|${HADITH_TAG_RE.source}`, 'g');
  const segments: (string | CitationSegment)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = combined.exec(text))) {
    if (match.index > lastIndex) segments.push(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      segments.push({ kind: 'quran', surah: match[1], ayah: match[2], verified: match[3] === 'true', text: match[4] });
    } else {
      segments.push({ kind: 'hadith', narrator: match[5], verified: match[6] === 'true', text: match[7] });
    }
    lastIndex = combined.lastIndex;
  }
  if (lastIndex < text.length) segments.push(text.slice(lastIndex));
  return segments;
}

type TimedWord = { word: string; start: number; end: number };
interface SubtitleCue { start: number; end: number; lines: string[]; }

function formatSubtitleTimestamp(seconds: number, format: 'srt' | 'vtt'): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const sep = format === 'srt' ? ',' : '.';
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

/** Wraps a cue's text into at most maxLines lines of at most maxCharsPerLine chars each. */
function wrapSubtitleText(text: string, maxCharsPerLine = 42, maxLines = 2): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxCharsPerLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/** Groups word-level timestamps (already fetched for the karaoke highlight view) into
 * subtitle cues, breaking on long pauses or once a cue grows too long to read
 * comfortably — built locally from data we already have instead of paying for a
 * second Gemini audio pass just to re-derive cue timing. */
function buildSubtitleCues(words: TimedWord[]): SubtitleCue[] {
  const MAX_CUE_CHARS = 84; // 2 lines x 42 chars
  const MAX_CUE_DURATION = 7; // seconds
  const PAUSE_BREAK = 0.8; // seconds

  const raw: { start: number; end: number; text: string }[] = [];
  let cur: { start: number; end: number; text: string } | null = null;

  for (const w of words) {
    const word = w.word.trim();
    if (!word) continue;
    if (cur) {
      const gap = w.start - cur.end;
      const candidate = `${cur.text} ${word}`;
      const duration = w.end - cur.start;
      if (gap > PAUSE_BREAK || candidate.length > MAX_CUE_CHARS || duration > MAX_CUE_DURATION) {
        raw.push(cur);
        cur = { start: w.start, end: w.end, text: word };
      } else {
        cur.text = candidate;
        cur.end = w.end;
      }
    } else {
      cur = { start: w.start, end: w.end, text: word };
    }
  }
  if (cur) raw.push(cur);

  return raw.map(c => ({ start: c.start, end: c.end, lines: wrapSubtitleText(c.text) }));
}

function buildSRT(cues: SubtitleCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${formatSubtitleTimestamp(c.start, 'srt')} --> ${formatSubtitleTimestamp(c.end, 'srt')}\n${c.lines.join('\n')}`)
    .join('\n\n');
}

function buildVTT(cues: SubtitleCue[]): string {
  return 'WEBVTT\n\n' + cues
    .map(c => `${formatSubtitleTimestamp(c.start, 'vtt')} --> ${formatSubtitleTimestamp(c.end, 'vtt')}\n${c.lines.join('\n')}`)
    .join('\n\n');
}

/** Splits correctedText into plain/highlighted segments by locating each error's
 * `corrected` substring in order. Falls back to treating an unlocatable substring as
 * plain text rather than throwing — Gemini's error entries are free-form and won't
 * always be an exact substring match. */
function buildGrammarDiffSegments(correctedText: string, errors: { corrected: string }[]): { text: string; changed: boolean }[] {
  const segments: { text: string; changed: boolean }[] = [];
  let cursor = 0;
  for (const err of errors) {
    if (!err.corrected) continue;
    const idx = correctedText.indexOf(err.corrected, cursor);
    if (idx === -1) continue;
    if (idx > cursor) segments.push({ text: correctedText.slice(cursor, idx), changed: false });
    segments.push({ text: err.corrected, changed: true });
    cursor = idx + err.corrected.length;
  }
  if (cursor < correctedText.length) segments.push({ text: correctedText.slice(cursor), changed: false });
  return segments;
}

/** Renders a transcription string, showing Quran/Hadith citations in ﴿ ﴾ [source] bracket notation
 * with a verified badge, distinct from the surrounding plain Kurdish text. */
function TranscriptionWithCitations({ text }: { text: string }) {
  const segments = parseCitationSegments(text);
  return (
    <>
      {segments.map((seg, i) => {
        if (typeof seg === 'string') return <span key={i}>{seg}</span>;
        const isQuran = seg.kind === 'quran';
        return (
          <span key={i} className="inline align-baseline mx-1 px-1.5 py-0.5 rounded" dir="rtl"
            style={{ background: isQuran ? 'rgba(34,197,94,0.08)' : 'rgba(168,85,247,0.08)' }}
          >
            <span className="font-semibold text-[1.15em] leading-loose" style={{ fontFamily: "'Amiri Quran', 'Traditional Arabic', 'Scheherazade New', serif" }}>{formatCitationBracket(seg)}</span>
            {seg.verified && <span className="text-green-500 text-sm align-super"> ✓</span>}
            {!seg.verified && <span className="text-amber-500 text-xs"> (دڵنیا نییت)</span>}
          </span>
        );
      })}
    </>
  );
}

export default function App() {
  const { theme, setTheme } = useTheme();
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
  const [activeTab, setActiveTab] = useState<'transcribe' | 'library' | 'hadith-search' | 'arabic-grammar' | 'profile'>('transcribe');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | 'all' | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [openLibraryExport, setOpenLibraryExport] = useState<string | null>(null);
  const [isEditingTranscription, setIsEditingTranscription] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [summary, setSummary] = useState<string>('');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [isExportingSubtitles, setIsExportingSubtitles] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [timedWords, setTimedWords] = useState<TimedWord[]>([]);
  const [isTimedTranscribing, setIsTimedTranscribing] = useState(false);
  const [showTimedView, setShowTimedView] = useState(false);
  const [processStage, setProcessStage] = useState<'idle'|'compressing'|'uploading'|'transcribing'>('idle');
  const [chunkProgress, setChunkProgress] = useState<{ current: number; total: number } | null>(null);
  const [isVerifyingSources, setIsVerifyingSources] = useState(false);
  const [hadithQuery, setHadithQuery] = useState('');
  const [hadithResults, setHadithResults] = useState<{ arabicText: string; narrator: string; book: string; chapter?: string; grading?: string; verified: boolean }[]>([]);
  const [isSearchingHadith, setIsSearchingHadith] = useState(false);
  const [hadithSearchError, setHadithSearchError] = useState<string | null>(null);
  const [grammarInput, setGrammarInput] = useState('');
  const [grammarResult, setGrammarResult] = useState<{ correctedText: string; errors: { original: string; corrected: string; type: string; explanation: string }[] } | null>(null);
  const [isCorrectingGrammar, setIsCorrectingGrammar] = useState(false);
  const [grammarError, setGrammarError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const timedAbortControllerRef = useRef<AbortController | null>(null);
  const editableRef = useRef<HTMLTextAreaElement>(null);
  const audioElRef = useRef<HTMLAudioElement>(null);

  // Dual-range slider state
  const [sliderMin, setSliderMin] = useState(0);   // 0–100
  const [sliderMax, setSliderMax] = useState(100); // 0–100
  const [currentPct, setCurrentPct] = useState(0); // playback position 0–100
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'min'|'max'|'scrubber'|null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const userMenuMobileRef = useRef<HTMLDivElement>(null);
  const userMenuDesktopRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      const inMobile = userMenuMobileRef.current?.contains(t);
      const inDesktop = userMenuDesktopRef.current?.contains(t);
      if (!inMobile && !inDesktop) setShowUserMenu(false);
    };
    if (showUserMenu) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showUserMenu]);

  // Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => {
      setUser(u);
      if (u) {
        setDoc(doc(db, "users", u.uid), {
          displayName: u.displayName || "",
          email: u.email || "",
          photoURL: u.photoURL || "",
          lastLogin: Date.now(),
        }, { merge: true }).catch(() => {});
      }
    });
    return unsub;
  }, []);

  // Sync audio currentTime → currentPct; enforce loop between sliderMin–sliderMax.
  // Uses requestAnimationFrame instead of the 'timeupdate' event: timeupdate fires at
  // a roughly fixed WALL-CLOCK interval (~4x/sec) regardless of playbackRate, so at
  // higher speeds the media-time gap between updates grows and can skip over short
  // words entirely — breaking the karaoke highlight above 1x. rAF samples currentTime
  // every screen refresh, so no word-sized window gets missed at any speed.
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    let rafId: number;
    const tick = () => {
      if (audioDuration > 0) {
        const pct = (el.currentTime / audioDuration) * 100;
        setCurrentPct(pct);
        const maxTime = (sliderMax / 100) * audioDuration;
        if (el.currentTime >= maxTime) {
          el.currentTime = (sliderMin / 100) * audioDuration;
          if (!el.paused) el.play();
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
    };
  }, [audioDuration, sliderMin, sliderMax]);

  // Apply the selected playback speed to the audio element whenever it changes
  // (and whenever a new file is loaded), so karaoke-highlight review can be sped
  // through or slowed down to catch transcription errors more easily.
  useEffect(() => {
    const el = audioElRef.current;
    if (el) el.playbackRate = playbackRate;
  }, [playbackRate, audioUrl]);

  // Mouse/touch drag logic for dual-range and scrubber
  useEffect(() => {
    const onMove = (clientX: number) => {
      if (!dragging.current || !trackRef.current || !audioDuration) return;
      const rect = trackRef.current.getBoundingClientRect();
      let pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      if (dragging.current === 'min') {
        const clamped = Math.min(pct, sliderMax - 2);
        setSliderMin(clamped);
      } else if (dragging.current === 'max') {
        const clamped = Math.max(pct, sliderMin + 2);
        setSliderMax(clamped);
      } else if (dragging.current === 'scrubber') {
        const clamped = Math.max(sliderMin, Math.min(sliderMax, pct));
        const el = audioElRef.current;
        if (el) el.currentTime = (clamped / 100) * audioDuration;
        setCurrentPct(clamped);
      }
    };
    const onMouseMove = (e: MouseEvent) => onMove(e.clientX);
    const onTouchMove = (e: TouchEvent) => onMove(e.touches[0].clientX);
    const onUp = () => { dragging.current = null; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [audioDuration, sliderMin, sliderMax]);

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
        setError("تۆمارەکان نەخوێندرانەوە: تکایە Firestore Security Rules لە Firebase Console دابنێ.");
      }
    }).finally(() => setHistoryLoading(false));
  }, [user]);

  const saveToHistory = async (item: Omit<HistoryItem, 'id'>) => {
    if (!user) return;
    const cleanItem = { ...item, text: stripCitationTags(item.text) };
    try {
      const ref = await addDoc(collection(db, "users", user.uid, "history"), cleanItem);
      setHistory(prev => [{ id: ref.id, ...cleanItem }, ...prev].slice(0, 100));
    } catch (err: any) {
      console.error("saveToHistory ERROR:", err.code, err.message);
      if (err?.code === 'permission-denied') {
        setError("تۆمار خەزن نەکرا: تکایە Firestore Rules لە Firebase Console دابنێ.");
      } else {
        setError(`تۆمار خەزن نەکرا: ${err.message}`);
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

  const cancelTranscription = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsTranscribing(false);
    setProcessStage('idle');
    setChunkProgress(null);
    setIsVerifyingSources(false);
  };

  const runTranscription = async (blob: Blob, langToUse: 'ku' | 'ar', compress: boolean) => {
    const ac = new AbortController();
    abortControllerRef.current = ac;
    setIsTranscribing(true);
    setError(null);
    setTranscription("");
    setIsEditingTranscription(false);
    setTimedWords([]);
    setShowTimedView(false);
    setChunkProgress(null);
    setIsVerifyingSources(false);

    try {
      const needsCompression = compress || blob.size > VERCEL_BODY_SIZE_LIMIT;
      let uploadBlob = blob;
      if (needsCompression) {
        setProcessStage('compressing');
        try {
          uploadBlob = await compressAudioToMp3(blob);
        } catch {
          // Decoding/encoding failed — fall back to the original blob. If it's over
          // the limit the upload will fail with a clear 413 below rather than silently.
          uploadBlob = blob;
        }
      }
      if (uploadBlob.size > VERCEL_BODY_SIZE_LIMIT) {
        setError("دەنگەکە تەنانەت دوای بچووککردنەوەش زۆر گەورەیە. تکایە کورتکراوەیەکی کەمتری دەنگەکە باربکە.");
        return;
      }

      setProcessStage('uploading');
      const formData = new FormData();
      formData.append("audio", uploadBlob);
      formData.append("language", langToUse);
      formData.append("model", selectedModel);
      formData.append("compress", compress ? "true" : "false");

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
      let pending = "";
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          pending += decoder.decode(value, { stream: !done });

          // Pull out any complete progress markers (in order) and update state,
          // but hold back a trailing partial marker until more data arrives.
          const combinedMarkerRe = new RegExp(`${CHUNK_PROGRESS_MARKER_RE.source}|${VERIFYING_SOURCES_MARKER_RE.source}|${WORDS_MARKER_RE.source}`, "g");
          let match: RegExpExecArray | null;
          let lastIndex = 0;
          let visible = "";
          while ((match = combinedMarkerRe.exec(pending))) {
            visible += pending.slice(lastIndex, match.index);
            if (match[1] !== undefined) {
              setChunkProgress({ current: Number(match[1]), total: Number(match[2]) });
            } else if (match[3] !== undefined) {
              // Word-timestamp chunk arriving inline with the transcript — accumulate
              // rather than replace, since long audio emits one of these per chunk.
              try {
                const newWords = JSON.parse(match[3]);
                if (Array.isArray(newWords) && newWords.length > 0) {
                  setTimedWords(prev => [...prev, ...newWords]);
                }
              } catch { /* malformed marker, ignore */ }
            } else {
              setIsVerifyingSources(true);
            }
            lastIndex = combinedMarkerRe.lastIndex;
          }
          const rest = pending.slice(lastIndex);
          const partialMarkerStart = rest.indexOf(CHUNK_PROGRESS_NUL);
          if (partialMarkerStart === -1 || done) {
            visible += rest;
            pending = "";
          } else {
            visible += rest.slice(0, partialMarkerStart);
            pending = rest.slice(partialMarkerStart);
          }

          if (visible) { fullText += visible; setTranscription(p => p + visible); }
        }
        if (done) break;
      }
      setIsTranscribing(false);
      setProcessStage('idle');
      setChunkProgress(null);
      setIsVerifyingSources(false);

      if (fullText.trim()) {
        await saveToHistory({ text: fullText, language: langToUse, timestamp: Date.now(), model: selectedModel });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // user cancelled
      setError(err.message || "پەیوەندی لەگەڵ سێرڤەر نییە.");
      setIsTranscribing(false);
      setProcessStage('idle');
      setChunkProgress(null);
      setIsVerifyingSources(false);
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

  // Fetches per-word timestamps for the karaoke highlight view and subtitle export —
  // only called on demand (toggle click / export), not automatically after every
  // transcription. It's a second full audio-to-text request, and most transcriptions
  // are never viewed in highlight mode or exported as subtitles, so eagerly firing it
  // every time doubled audio-token cost for no benefit in the common case.
  const ensureTimedWords = async (): Promise<TimedWord[]> => {
    if (timedWords.length > 0) return timedWords;
    if (!audioBlob) return [];
    const ac = new AbortController();
    timedAbortControllerRef.current = ac;
    setIsTimedTranscribing(true);
    try {
      let uploadBlob: Blob = audioBlob;
      if (shouldCompress || audioBlob.size > VERCEL_BODY_SIZE_LIMIT) {
        try { uploadBlob = await compressAudioToMp3(audioBlob); } catch { uploadBlob = audioBlob; }
      }
      if (uploadBlob.size > VERCEL_BODY_SIZE_LIMIT) return [];

      const timedFormData = new FormData();
      timedFormData.append("audio", uploadBlob);
      timedFormData.append("language", targetLanguage);
      timedFormData.append("model", selectedModel);
      const r = await fetch("/api/transcribe-timed", { method: "POST", body: timedFormData, signal: ac.signal });
      if (!r.ok) return [];
      const words = await r.json();
      if (Array.isArray(words) && words.length > 0) {
        setTimedWords(words);
        return words;
      }
      return [];
    } catch {
      return [];
    } finally {
      setIsTimedTranscribing(false);
      timedAbortControllerRef.current = null;
    }
  };

  const cancelTimedTranscription = () => {
    timedAbortControllerRef.current?.abort();
    timedAbortControllerRef.current = null;
    setIsTimedTranscribing(false);
  };

  // Translates the already-transcribed Kurdish text to Arabic via a cheap text-only
  // request instead of re-uploading and re-transcribing the audio — audio tokens cost
  // far more than text tokens, and the Kurdish text is already known to be correct.
  const translateExistingText = async () => {
    if (!transcription.trim()) return;
    setTargetLanguage('ar');
    setIsTranscribing(true);
    setError(null);
    // Any previously-fetched karaoke timestamps belong to the Kurdish audio's words —
    // leaving showTimedView on would keep rendering that stale Kurdish word list over
    // the new Arabic text instead of showing the translation.
    setTimedWords([]);
    setShowTimedView(false);
    setIsEditingTranscription(false);
    const kurdishText = transcription;
    setTranscription("");
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: stripCitationTags(kurdishText) }),
      });
      if (!response.ok) {
        const txt = await response.text();
        try { setError(JSON.parse(txt).error || "هەڵەیەک ڕوویدا."); }
        catch { setError("هەڵەیەک ڕوویدا لە کاتی وەرگێڕانەکە."); }
        setTranscription(kurdishText);
        return;
      }
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
      if (fullText.trim()) {
        await saveToHistory({ text: fullText, language: 'ar', timestamp: Date.now(), model: selectedModel });
      }
    } catch {
      setError("پەیوەندی لەگەڵ سێرڤەر نییە.");
      setTranscription(kurdishText);
    } finally {
      setIsTranscribing(false);
    }
  };

  const copyText = (text: string, id: string | null = null) => {
    // Normalize whitespace: collapse multiple spaces/newlines into single space per word,
    // then wrap at ~80 chars per line for clean paste output
    const normalized = stripCitationTags(text)
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

  const searchHadith = async () => {
    if (!hadithQuery.trim()) return;
    setIsSearchingHadith(true);
    setHadithSearchError(null);
    setHadithResults([]);
    try {
      const res = await fetch('/api/hadith-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: hadithQuery }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setHadithSearchError(data.error || 'هەڵەیەک ڕوویدا.');
        return;
      }
      setHadithResults(Array.isArray(data.results) ? data.results : []);
    } catch {
      setHadithSearchError('پەیوەندی لەگەڵ سێرڤەر نییە.');
    } finally {
      setIsSearchingHadith(false);
    }
  };

  const correctGrammar = async () => {
    if (!grammarInput.trim()) return;
    setIsCorrectingGrammar(true);
    setGrammarError(null);
    setGrammarResult(null);
    try {
      const res = await fetch('/api/grammar-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: grammarInput }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGrammarError(data.error || 'هەڵەیەک ڕوویدا.');
        return;
      }
      setGrammarResult(data);
    } catch {
      setGrammarError('پەیوەندی لەگەڵ سێرڤەر نییە.');
    } finally {
      setIsCorrectingGrammar(false);
    }
  };

  const exportText = (format: 'txt' | 'docx' | 'pdf', rawText: string) => {
    const filename = `voxscript-${Date.now()}`;
    const text = stripCitationTags(rawText);
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    const htmlDoc = `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>Kurdish Transcription</title><style>body{font-family:"Arial","Tahoma",sans-serif;font-size:16pt;line-height:2;direction:rtl;text-align:right;padding:2cm;color:#000;}</style></head><body>${escaped}</body></html>`;

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
      // Build cues from word timestamps we already have (or lazily fetch once) —
      // avoids a dedicated Gemini Pro audio call to re-derive timing we can compute
      // locally for free.
      const words = await ensureTimedWords();
      let text: string;
      if (words.length > 0) {
        const cues = buildSubtitleCues(words);
        text = format === 'srt' ? buildSRT(cues) : buildVTT(cues);
      } else {
        // Fallback only: word timestamps unavailable (e.g. the lazy fetch failed) —
        // ask Gemini directly for a subtitle file from the audio.
        let uploadBlob: Blob = audioBlob;
        if (shouldCompress || audioBlob.size > VERCEL_BODY_SIZE_LIMIT) {
          try { uploadBlob = await compressAudioToMp3(audioBlob); } catch { uploadBlob = audioBlob; }
        }
        if (uploadBlob.size > VERCEL_BODY_SIZE_LIMIT) {
          setError("دەنگەکە تەنانەت دوای بچووککردنەوەش زۆر گەورەیە. تکایە کورتکراوەیەکی کەمتری دەنگەکە باربکە.");
          return;
        }

        const formData = new FormData();
        formData.append("audio", uploadBlob);
        formData.append("language", targetLanguage);
        formData.append("format", format);
        formData.append("compress", shouldCompress ? "true" : "false");
        const res = await fetch("/api/subtitles", { method: "POST", body: formData });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "هەڵەیەک ڕوویدا" }));
          setError(err.error || "هەڵەیەک ڕوویدا لە دروستکردنی ژێرنووس.");
          return;
        }
        text = await res.text();
      }
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
    const trimmed = stripCitationTags(text).slice(0, 3900);
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
    setAudioDuration(0);
    setSliderMin(0); setSliderMax(100); setCurrentPct(0); setIsPlaying(false);
    setTimedWords([]); setShowTimedView(false);
  };

  const fmtMMSS = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };

  const transcribeSliderRange = async () => {
    if (!audioBlob || !audioDuration) return;
    const start = (sliderMin / 100) * audioDuration;
    const end = (sliderMax / 100) * audioDuration;
    if (start >= end) return;
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
        for (let i = 0; i < frameCount; i++) dst[i] = srcData[i];
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


  // Loading state
  if (user === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <Loader2 className="animate-spin text-[#ff4e00]" size={32} />
      </div>
    );
  }

  // Not logged in
  if (!user) return <AuthPage />;

  return (
    <div className="min-h-screen font-sans selection:bg-[#ff4e00]/30" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }} dir="rtl">

      {/* ── HEADER ── */}
      <header className="sticky top-0 z-30 border-b" style={{ background: 'var(--bg-base)', borderColor: 'var(--border)' }}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-3 relative">

          {/* Logo — click to go home */}
          <button onClick={() => setActiveTab('transcribe')} className="flex items-center gap-2.5 shrink-0" dir="ltr">
            <div className="w-8 h-8 bg-[#ff4e00] rounded-xl flex items-center justify-center shadow-[0_4px_12px_rgba(255,78,0,0.3)]">
              <span className="text-white font-black text-sm">K</span>
            </div>
            <span className="text-base sm:text-lg font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
              Kurdish<span className="text-[#ff4e00]">Trans</span>
            </span>
          </button>

          {/* Desktop Nav */}
          <nav className="hidden sm:flex gap-1" dir="ltr">
            {(['transcribe', 'library', 'hadith-search', 'arabic-grammar', 'profile'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`relative px-4 py-2 text-sm font-medium transition-all rounded-lg ${activeTab === tab ? 'text-[#ff4e00]' : 'hover:bg-[#ff4e00]/05'}`}
                style={activeTab !== tab ? { color: 'var(--text-muted)' } : undefined}
              >
                {tab === 'transcribe' ? 'نووسینەوە' : tab === 'library' ? 'کتێبخانە' : tab === 'hadith-search' ? 'گەڕانی فەرموودە' : tab === 'arabic-grammar' ? 'ڕاستکردنەوەی عەرەبی' : 'پرۆفایل'}
                {tab === 'library' && history.length > 0 && (
                  <span className="mr-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-[#ff4e00] text-white">{history.length}</span>
                )}
                {activeTab === tab && <div className="absolute bottom-0 left-3 right-3 h-0.5 bg-[#ff4e00] rounded-full" />}
              </button>
            ))}
          </nav>

          {/* Right: mobile hamburger + desktop user menu */}
          <div className="flex items-center gap-2" dir="ltr">

            {/* Mobile: hamburger only — dropdown anchored below this button */}
            <div className="relative sm:hidden" ref={userMenuMobileRef}>
              <button onClick={() => setShowUserMenu(p => !p)}
                className="flex flex-col gap-1.5 justify-center items-center w-9 h-9 rounded-lg transition-colors"
                style={{ border: '1px solid var(--border)' }}
              >
                <span className="w-4 h-0.5 rounded-full" style={{ background: 'var(--text-muted)' }} />
                <span className="w-4 h-0.5 rounded-full" style={{ background: 'var(--text-muted)' }} />
                <span className="w-4 h-0.5 rounded-full" style={{ background: 'var(--text-muted)' }} />
              </button>
              <AnimatePresence>
                {showUserMenu && (
                  <motion.div initial={{ opacity: 0, y: 6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.97 }}
                    className="absolute left-0 top-full mt-2 w-64 rounded-xl shadow-2xl overflow-hidden z-50"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                  >
                    {/* User info */}
                    <button onClick={() => { setActiveTab('profile'); setShowUserMenu(false); }}
                      className="w-full flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[#ff4e00]/05"
                      style={{ borderBottom: '1px solid var(--border-soft)' }}
                    >
                      {user.photoURL
                        ? <img src={user.photoURL} className="w-10 h-10 rounded-full ring-2 ring-[#ff4e00]/20 shrink-0" alt="" />
                        : <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#ff4e00] to-[#ff7a40] flex items-center justify-center text-white text-sm font-bold shrink-0">
                            {(user.displayName || user.email || 'U')[0].toUpperCase()}
                          </div>
                      }
                      <div className="text-right min-w-0">
                        <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{user.displayName || "کاربەر"}</p>
                        <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-dim)' }}>{user.email}</p>
                      </div>
                    </button>
                    {/* Mobile tabs */}
                    <div className="px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                      <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: 'var(--text-dim)' }}>بەشەکان</p>
                      <div className="flex gap-1">
                        {([['transcribe', Mic, 'نووسینەوە'], ['library', History, 'کتێبخانە'], ['hadith-search', Search, 'گەڕانی فەرموودە'], ['arabic-grammar', SpellCheck, 'ڕاستکردنەوەی عەرەبی'], ['profile', User, 'پرۆفایل']] as const).map(([tab, Icon, label]) => (
                          <button key={tab} onClick={() => { setActiveTab(tab as any); setShowUserMenu(false); }}
                            className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] transition-all ${activeTab === tab ? 'bg-[#ff4e00] text-white' : 'hover:bg-[#ff4e00]/10'}`}
                            style={activeTab !== tab ? { color: 'var(--text-muted)', border: '1px solid var(--border)' } : {}}
                          >
                            <Icon size={13} />
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Theme */}
                    <div className="px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                      <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: 'var(--text-dim)' }}>تیم</p>
                      <div className="flex gap-1">
                        {([['dark', Moon, 'تاریک'], ['light', Sun, 'ڕووناک'], ['system', Monitor, 'ئۆتۆ']] as const).map(([t, Icon, label]) => (
                          <button key={t} onClick={() => setTheme(t)}
                            className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] transition-all ${theme === t ? 'bg-[#ff4e00] text-white' : 'hover:bg-[#ff4e00]/10'}`}
                            style={theme !== t ? { color: 'var(--text-muted)', border: '1px solid var(--border)' } : {}}
                          >
                            <Icon size={13} />
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button onClick={() => { setActiveTab('profile'); setShowUserMenu(false); }}
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs transition-colors hover:text-[#ff4e00]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <User size={13} /> دەستکاری پرۆفایل
                    </button>
                    <button onClick={() => { signOut(auth); setShowUserMenu(false); }}
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs transition-colors hover:text-[#ff4e00] hover:bg-[#ff4e00]/05"
                      style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-soft)' }}
                    >
                      <LogOut size={13} /> دەرچوون
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Desktop: full user button + dropdown */}
            <div className="relative hidden sm:block shrink-0" ref={userMenuDesktopRef}>
              <button onClick={() => setShowUserMenu(p => !p)}
                className="flex items-center gap-2 rounded-xl px-3 py-1.5 transition-all hover:bg-[#ff4e00]/08"
                style={{ border: '1px solid var(--border)' }}
              >
                {user.photoURL
                  ? <img src={user.photoURL} className="w-7 h-7 rounded-full ring-2 ring-[#ff4e00]/20" alt="" />
                  : <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#ff4e00] to-[#ff7a40] flex items-center justify-center text-white text-xs font-bold">
                      {(user.displayName || user.email || 'U')[0].toUpperCase()}
                    </div>
                }
                <span className="text-xs font-medium max-w-[90px] truncate" style={{ color: 'var(--text-primary)' }}>
                  {user.displayName || user.email?.split('@')[0]}
                </span>
                <ChevronDown size={12} style={{ color: 'var(--text-dim)' }} />
              </button>

            {/* Dropdown desktop */}
            <AnimatePresence>
              {showUserMenu && (
                <motion.div initial={{ opacity: 0, y: 6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.97 }}
                  className="absolute right-0 top-full mt-2 w-56 rounded-xl shadow-2xl overflow-hidden z-50"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                >
                  {/* User info */}
                  <button onClick={() => { setActiveTab('profile'); setShowUserMenu(false); }}
                    className="w-full flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[#ff4e00]/05"
                    style={{ borderBottom: '1px solid var(--border-soft)' }}
                  >
                    {user.photoURL
                      ? <img src={user.photoURL} className="w-10 h-10 rounded-full ring-2 ring-[#ff4e00]/20 shrink-0" alt="" />
                      : <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#ff4e00] to-[#ff7a40] flex items-center justify-center text-white text-sm font-bold shrink-0">
                          {(user.displayName || user.email || 'U')[0].toUpperCase()}
                        </div>
                    }
                    <div className="text-right min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{user.displayName || "کاربەر"}</p>
                      <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-dim)' }}>{user.email}</p>
                    </div>
                  </button>

                  {/* Theme selector */}
                  <div className="px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                    <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: 'var(--text-dim)' }}>تیم</p>
                    <div className="flex gap-1">
                      {([['dark', Moon, 'تاریک'], ['light', Sun, 'ڕووناک'], ['system', Monitor, 'ئۆتۆ']] as const).map(([t, Icon, label]) => (
                        <button key={t} onClick={() => setTheme(t)}
                          className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] transition-all ${theme === t ? 'bg-[#ff4e00] text-white' : 'hover:bg-[#ff4e00]/10'}`}
                          style={theme !== t ? { color: 'var(--text-muted)', border: '1px solid var(--border)' } : {}}
                        >
                          <Icon size={13} />
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Profile */}
                  <button onClick={() => { setActiveTab('profile'); setShowUserMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs transition-colors hover:text-[#ff4e00]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <User size={13} /> دەستکاری پرۆفایل
                  </button>

                  {/* Logout */}
                  <button onClick={() => { signOut(auth); setShowUserMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs transition-colors hover:text-[#ff4e00] hover:bg-[#ff4e00]/05"
                    style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-soft)' }}
                  >
                    <LogOut size={13} /> دەرچوون
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
            </div>
          </div>
        </div>
      </header>

      {/* ── MOBILE BOTTOM NAV ── */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-30 border-t flex safe-area-bottom" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {([
          ['transcribe', Mic, 'نووسینەوە'],
          ['library', History, 'کتێبخانە'],
          ['hadith-search', Search, 'گەڕان'],
          ['arabic-grammar', SpellCheck, 'ڕاستکردنەوە'],
          ['profile', User, 'پرۆفایل'],
        ] as const).map(([tab, Icon, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab as any)}
            className={`flex-1 flex flex-col items-center gap-1 py-3 transition-all relative ${activeTab === tab ? 'text-[#ff4e00]' : ''}`}
            style={activeTab !== tab ? { color: 'var(--text-dim)' } : undefined}
          >
            {tab === 'library' && history.length > 0 && (
              <span className="absolute top-2 right-[calc(50%-8px)] w-4 h-4 bg-[#ff4e00] text-white text-[9px] font-bold rounded-full flex items-center justify-center">{history.length}</span>
            )}
            <Icon size={20} />
            <span className="text-[10px] font-medium">{label}</span>
            {activeTab === tab && <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-[#ff4e00] rounded-full" />}
          </button>
        ))}
      </nav>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-24 sm:pb-8 space-y-6">
        {activeTab === 'transcribe' ? (
          <>
            {/* ── CONTROLS ── */}
            <section className="rounded-2xl overflow-hidden shadow-2xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="grid grid-cols-1 sm:grid-cols-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
                {/* Language */}
                <div className="p-4 flex flex-col gap-2">
                  <span className="text-[10px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-dim)' }}>زمان</span>
                  <div className="flex p-1 rounded-lg relative" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-soft)' }}>
                    <div className="absolute top-1 bottom-1 w-[calc(50%-4px)] bg-[#ff4e00]/15 border border-[#ff4e00]/30 rounded-md transition-all duration-300"
                      style={{ right: targetLanguage === 'ku' ? '4px' : 'calc(50%)' }} />
                    {(['ku', 'ar'] as const).map(lang => (
                      <button key={lang} onClick={() => setTargetLanguage(lang)}
                        className={`flex-1 py-2 text-sm font-medium transition-colors relative z-10 ${targetLanguage === lang ? 'text-white' : 'hover:text-[#ff4e00]'}`}
                style={targetLanguage !== lang ? { color: 'var(--text-muted)' } : {}}
                      >{lang === 'ku' ? 'کوردی' : 'عەرەبی'}</button>
                    ))}
                  </div>
                </div>

                {/* Model */}
                <div className="p-4 flex flex-col gap-2">
                  <span className="text-[10px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-dim)' }}>مۆدێل</span>
                  <div className="relative">
                    <select value={selectedModel} onChange={e => setSelectedModel(e.target.value as any)}
                      className="w-full text-sm font-medium py-2.5 pl-3 pr-8 rounded-lg outline-none cursor-pointer appearance-none"
                      style={{ background: 'var(--bg-input)', border: '1px solid var(--border-soft)', color: 'var(--text-primary)' }} dir="ltr"
                    >
                      <option value="gemini-pro" className="bg-card">Gemini 2.5 Pro ★ (Smart)</option>
                      <option value="gemini" className="bg-card">Gemini 2.5 Flash</option>
                      <option value="gemini-flash2" className="bg-card">Gemini 2.5 Flash (Fast)</option>
                      <option value="scribe" className="bg-card">ElevenLabs Scribe</option>
                    </select>
                    <ChevronDown size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-dim)' }} />
                  </div>
                </div>

                {/* Compress */}
                <div className="p-4 flex flex-col gap-2">
                  <span className="text-[10px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-dim)' }}>بچووککردنەوەی قەبارە</span>
                  <label className="flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors h-[42px]" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-soft)' }}>
                    <div onClick={() => setShouldCompress(p => !p)}
                      className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer shrink-0 ${shouldCompress ? 'bg-[#ff4e00]' : 'bg-[#333]'}`}
                    >
                      <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${shouldCompress ? 'left-4' : 'left-0.5'}`} />
                    </div>
                    <span className="text-sm select-none" style={{ color: 'var(--text-muted)' }}>{shouldCompress ? 'چالاکە' : 'ناچالاکە'}</span>
                  </label>
                </div>
              </div>

              {/* Record / Upload */}
              <div className="p-4 sm:p-6">
                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                  {!isRecording ? (
                    <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                      onClick={startRecording} disabled={isTranscribing}
                      className="flex flex-col items-center gap-3 p-5 sm:p-7 rounded-2xl transition-all disabled:opacity-40 group border"
                      style={{ background: 'var(--bg-hover)', borderColor: 'var(--border)' }}
                    >
                      <div className="p-3.5 sm:p-4 bg-[#ff4e00] text-white rounded-full ring-4 ring-[#ff4e00]/15 group-hover:ring-[#ff4e00]/30 group-hover:scale-105 transition-all">
                        <Mic size={22} />
                      </div>
                      <span className="text-[10px] sm:text-xs uppercase tracking-widest font-bold" style={{ color: 'var(--text-muted)' }}>تۆمارکردن</span>
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

                  <label className="flex flex-col items-center gap-3 p-5 sm:p-7 rounded-2xl border border-dashed transition-all cursor-pointer" style={{ background: 'var(--bg-hover)', borderColor: 'var(--border)' }}>
                    <div className="p-3.5 sm:p-4 rounded-full border" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                      <Upload size={22} />
                    </div>
                    <span className="text-[10px] sm:text-xs uppercase tracking-widest font-bold" style={{ color: 'var(--text-muted)' }}>بارکردنی فایل</span>
                    <input type="file" accept="audio/*" onChange={handleFileUpload} className="hidden" disabled={isTranscribing} />
                  </label>
                </div>

                <AnimatePresence>
                  {audioBlob && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="mt-4 space-y-3">
                      <div className="flex items-center justify-between px-4 py-3 rounded-xl" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-soft)' }}>
                        <div className="flex items-center gap-3 min-w-0">
                          <FileAudio size={16} className="text-[#ff4e00] shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>فایلی دەنگ</p>
                            <p className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }} dir="ltr">{(audioBlob.size / (1024 * 1024)).toFixed(2)} MB</p>
                          </div>
                        </div>
                        <button onClick={reset} className="text-[#555] hover:text-[#ff4e00] transition-colors p-1.5 shrink-0"><Trash2 size={15} /></button>
                      </div>
                      {audioUrl && (
                        <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-soft)' }} dir="ltr">
                          <audio ref={audioElRef} src={audioUrl}
                            onLoadedMetadata={e => {
                              const d = (e.target as HTMLAudioElement).duration;
                              if (isFinite(d)) { setAudioDuration(d); }
                            }}
                          />

                          {/* ── Dual-range track ── */}
                          <div
                            ref={trackRef}
                            className="relative h-10 flex items-center select-none"
                          >
                            {/* Full track */}
                            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 bg-[#ffffff12] rounded-full" />

                            {/* Active range fill */}
                            <div
                              className="absolute top-1/2 -translate-y-1/2 h-1.5 bg-[#3b82f6] rounded-full"
                              style={{ left: `${sliderMin}%`, width: `${sliderMax - sliderMin}%` }}
                            />

                            {/* Playback progress dot on active range */}
                            {audioDuration > 0 && currentPct >= sliderMin && currentPct <= sliderMax && (
                              <div
                                className="absolute top-1/2 -translate-y-1/2 h-1.5 bg-[#93c5fd] rounded-full pointer-events-none"
                                style={{ left: `${sliderMin}%`, width: `${currentPct - sliderMin}%` }}
                              />
                            )}

                            {/* Scrubber — current position */}
                            {audioDuration > 0 && (
                              <div
                                className="absolute top-1/2 w-4 h-4 bg-white rounded-full shadow-md cursor-grab active:cursor-grabbing z-20"
                                style={{ left: `${currentPct}%`, transform: 'translate(-50%, -50%)' }}
                                onMouseDown={() => { dragging.current = 'scrubber'; }}
                                onTouchStart={() => { dragging.current = 'scrubber'; }}
                              />
                            )}

                            {/* Min thumb */}
                            <div
                              className="absolute top-1/2 z-10 w-5 h-5 rounded-full border-2 border-[#3b82f6] cursor-grab active:cursor-grabbing shadow"
                              style={{ left: `${sliderMin}%`, transform: 'translate(-50%, -50%)', background: 'var(--bg-input)' }}
                              onMouseDown={() => { dragging.current = 'min'; }}
                              onTouchStart={() => { dragging.current = 'min'; }}
                            />

                            {/* Max thumb */}
                            <div
                              className="absolute top-1/2 z-10 w-5 h-5 rounded-full border-2 border-[#3b82f6] cursor-grab active:cursor-grabbing shadow"
                              style={{ left: `${sliderMax}%`, transform: 'translate(-50%, -50%)', background: 'var(--bg-input)' }}
                              onMouseDown={() => { dragging.current = 'max'; }}
                              onTouchStart={() => { dragging.current = 'max'; }}
                            />
                          </div>

                          {/* ── Time labels + Play row ── */}
                          <div className="flex items-center gap-3">
                            {/* Jump to start + time */}
                            <button
                              onClick={() => { const el = audioElRef.current; if (el && audioDuration) el.currentTime = (sliderMin / 100) * audioDuration; }}
                              className="text-[#555] hover:text-white transition-colors shrink-0"
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
                            </button>
                            <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                              {audioDuration > 0 ? fmtMMSS((sliderMin / 100) * audioDuration) : '00:00'}
                            </span>

                            {/* Play/Pause — centre */}
                            <button
                              onClick={() => {
                                const el = audioElRef.current;
                                if (!el) return;
                                if (el.paused) {
                                  const minTime = (sliderMin / 100) * audioDuration;
                                  const maxTime = (sliderMax / 100) * audioDuration;
                                  if (el.currentTime < minTime || el.currentTime >= maxTime) el.currentTime = minTime;
                                  el.play();
                                } else { el.pause(); }
                              }}
                              className="mx-auto w-10 h-10 flex items-center justify-center rounded-full bg-[#3b82f6] hover:bg-[#2563eb] text-white transition-colors shadow-[0_0_16px_rgba(59,130,246,0.3)] shrink-0"
                            >
                              {isPlaying
                                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                                : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>}
                            </button>

                            {/* end time + jump */}
                            <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                              {audioDuration > 0 ? fmtMMSS((sliderMax / 100) * audioDuration) : '--:--'}
                            </span>
                            <button
                              onClick={() => { const el = audioElRef.current; if (el && audioDuration) el.currentTime = (sliderMax / 100) * audioDuration; }}
                              className="text-[#555] hover:text-white transition-colors shrink-0"
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.9V8.1L8.5 12zM16 6h2v12h-2z"/></svg>
                            </button>
                          </div>

                          {/* ── Playback speed ── */}
                          <div className="flex items-center justify-center gap-1">
                            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                              <button key={rate} onClick={() => setPlaybackRate(rate)}
                                className={`px-2 py-1 rounded-md text-[10px] font-mono font-bold transition-colors ${playbackRate === rate ? 'bg-[#3b82f6] text-white' : 'text-[#777] hover:text-white hover:bg-[#ffffff10]'}`}
                              >{rate}x</button>
                            ))}
                          </div>

                          {/* ── Transcribe / Translate selected range ── */}
                          {audioDuration > 0 && sliderMax > sliderMin && (
                            <div className="flex gap-2 pt-1" dir="rtl">
                              <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}
                                onClick={transcribeSliderRange}
                                disabled={isTranscribing}
                                className="flex-1 py-2.5 rounded-xl bg-[#ff4e00] text-white font-bold text-[11px] tracking-[0.12em] uppercase shadow-[0_0_16px_rgba(255,78,0,0.2)] hover:bg-[#e64600] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                              >
                                {isTranscribing
                                  ? <><Loader2 className="animate-spin" size={13} />چاوەڕوانبە...</>
                                  : <>نووسینەوەی ئەم بەشە · {audioDuration > 0 ? fmtMMSS((sliderMin/100)*audioDuration) : ''} → {audioDuration > 0 ? fmtMMSS((sliderMax/100)*audioDuration) : ''}</>}
                              </motion.button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Progress bar */}
                      <AnimatePresence>
                        {isTranscribing && (
                          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                            className="rounded-xl px-4 py-3 space-y-2"
                            style={{ background: 'var(--bg-input)', border: '1px solid var(--border-soft)' }}
                          >
                            <div className="flex items-center justify-between" dir="ltr">
                              <div className="flex items-center gap-2">
                                {isVerifyingSources
                                  ? <Search size={13} className="animate-pulse text-green-500" />
                                  : <Loader2 size={13} className="animate-spin text-[#ff4e00]" />}
                                <span className="text-[10px] font-mono text-[#aaa] uppercase tracking-wider">
                                  {processStage === 'compressing' && 'فشردن و ئامادەکردن...'}
                                  {processStage === 'uploading' && 'ناردن بۆ سێرڤەر...'}
                                  {processStage === 'transcribing' && (
                                    isVerifyingSources
                                      ? 'دەرهێنانی سەرچاوەکانی ئایەت و فەرموودە...'
                                      : chunkProgress
                                      ? `خەریکی وەرگێڕانی پارچەی ${chunkProgress.current} لە ${chunkProgress.total}...`
                                      : 'گۆڕینی دەنگ بە نووسین...'
                                  )}
                                </span>
                              </div>
                              <button onClick={cancelTranscription}
                                className="flex items-center gap-1 text-[10px] text-[#555] hover:text-[#ff4e00] transition-colors uppercase tracking-wider font-bold px-2 py-1 rounded border border-[#ffffff08] hover:border-[#ff4e00]/30"
                              >
                                <X size={10} />ڕاگرتن
                              </button>
                            </div>
                            <div className="h-0.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                              <motion.div className={`h-full rounded-full ${isVerifyingSources ? 'bg-green-500' : 'bg-[#ff4e00]'}`}
                                animate={isVerifyingSources
                                  ? { width: ['10%', '60%', '10%'], transition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' } }
                                  : chunkProgress
                                  ? { width: `${Math.min(100, (chunkProgress.current / chunkProgress.total) * 100)}%`, transition: { duration: 0.4 } }
                                  : processStage === 'transcribing'
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
                          className="flex-1 py-3.5 rounded-xl bg-[#ff4e00] text-white font-bold text-xs tracking-[0.08em] shadow-[0_0_20px_rgba(255,78,0,0.25)] hover:shadow-[0_0_30px_rgba(255,78,0,0.4)] hover:bg-[#e64600] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2.5"
                        >
                          گۆڕینی دەنگ بە نووسین
                        </motion.button>
                        <AnimatePresence>
                          {isTranscribing && (
                            <motion.button initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
                              onClick={cancelTranscription}
                              className="px-4 py-3.5 rounded-xl bg-card border border-[#ff4e00]/30 text-[#ff4e00] text-xs font-bold uppercase tracking-wider hover:bg-[#ff4e00]/10 transition-all flex items-center gap-1.5"
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
                  className="rounded-2xl shadow-2xl"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-7 py-4" style={{ borderBottom: '1px solid var(--border-soft)' }} dir="ltr">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-dim)' }}>ئەنجامی نووسینەوە</span>
                      {isEditingTranscription && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#ff4e00]/15 border border-[#ff4e00]/30 text-[#ff4e00] tracking-wider font-bold">دەستکاریکردن</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {targetLanguage === 'ku' && audioBlob && !isTranscribing && (
                        <button onClick={() => transcription.trim() ? translateExistingText() : transcribeAudio('ar')}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#ff4e00]/10 border border-[#ff4e00]/25 rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#ff4e00]/20 text-[#ff4e00] transition-colors font-bold"
                        >وەرگێڕان بۆ عەرەبی</button>
                      )}
                      <button onClick={() => {
                        setIsEditingTranscription(p => {
                          if (!p) setTimeout(() => editableRef.current?.focus(), 50);
                          return !p;
                        });
                      }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-wider transition-all ${isEditingTranscription ? 'bg-[#ff4e00]/20 border border-[#ff4e00]/50 text-[#ff4e00]' : 'bg-card border border-[#ffffff10] text-[#bbb] hover:bg-[#222]'}`}
                      >
                        {isEditingTranscription ? <><X size={12} />داخستن</> : <><Pencil size={12} />دەستکاریکردن</>}
                      </button>
                      <button onClick={summarizeText} disabled={isSummarizing}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-wider transition-all disabled:opacity-50 ${showSummary ? 'bg-[#a855f7]/20 border border-[#a855f7]/50 text-[#a855f7]' : 'bg-card border border-[#ffffff10] text-[#bbb] hover:bg-[#a855f7]/10 hover:border-[#a855f7]/30 hover:text-[#a855f7]'}`}
                      >
                        {isSummarizing ? <><Loader2 size={12} className="animate-spin" />پوختەکردن...</> : <><Sparkles size={12} />پوختەکردن</>}
                      </button>
                      <button onClick={() => copyText(transcription)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-[#ffffff10] rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#222] text-[#bbb] transition-colors"
                      >
                        {copied ? <><Check size={12} className="text-green-400" />کۆپیکرا</> : <><Copy size={12} />کۆپی</>}
                      </button>
                      <div className="relative">
                        <button onClick={() => setShowExportMenu(p => !p)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-[#ffffff10] rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#ff4e00]/15 hover:border-[#ff4e00]/40 hover:text-[#ff4e00] text-[#bbb] transition-all"
                        >
                          <Download size={12} />داگرتن<ChevronDown size={10} className={`transition-transform ${showExportMenu ? 'rotate-180' : ''}`} />
                        </button>
                        <AnimatePresence>
                          {showExportMenu && (
                            <motion.div initial={{ opacity: 0, y: 6, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.95 }}
                              className="absolute left-0 top-full mt-2 w-44 rounded-xl shadow-2xl overflow-hidden z-50"
                              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                            >
                              {([
                                { fmt: 'txt', label: 'دابگرە بە .TXT', sub: 'تێکستی سادە' },
                                { fmt: 'docx', label: 'دابگرە بە .DOC', sub: 'بۆ Microsoft Word' },
                                { fmt: 'pdf', label: 'چاپکردن / PDF', sub: 'چاپ و خەزنکردن بە PDF' },
                              ] as const).map(({ fmt, label, sub }) => (
                                <button key={fmt} onClick={() => exportText(fmt, transcription)}
                                  className="w-full flex flex-col items-start px-4 py-3 text-right hover:bg-[#ff4e00]/10 transition-colors border-b border-[#ffffff06] last:border-0"
                                >
                                  <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
                                  <span className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{sub}</span>
                                </button>
                              ))}
                              {audioBlob && (
                                <div style={{ borderTop: '1px solid var(--border-soft)' }}>
                                  <p className="px-4 pt-2.5 pb-1 text-[9px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-faint)' }}>ژێرنووس</p>
                                  {(['srt', 'vtt'] as const).map(fmt => (
                                    <button key={fmt} onClick={() => exportSubtitles(fmt)} disabled={isExportingSubtitles}
                                      className="w-full flex flex-col items-start px-4 py-2.5 text-right hover:bg-[#22d3ee]/08 transition-colors border-b border-[#ffffff06] last:border-0 disabled:opacity-50"
                                    >
                                      <span className="text-xs text-[#22d3ee] font-medium flex items-center gap-1.5">
                                        {isExportingSubtitles ? <Loader2 size={10} className="animate-spin" /> : null}
                                        دابگرە بە .{fmt.toUpperCase()}
                                      </span>
                                      <span className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{fmt === 'srt' ? 'بۆ زۆربەی پلەیەرەکان' : 'بۆ وێب و یوتیوب'}</span>
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
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-[#ffffff10] rounded-lg text-[10px] uppercase tracking-wider hover:bg-[#22c55e]/10 hover:border-[#22c55e]/30 hover:text-[#22c55e] text-[#bbb] transition-all"
                        >
                          <Share2 size={12} />بەشکردن<ChevronDown size={10} className={`transition-transform ${showShareMenu ? 'rotate-180' : ''}`} />
                        </button>
                        <AnimatePresence>
                          {showShareMenu && (
                            <motion.div initial={{ opacity: 0, y: 6, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.95 }}
                              className="absolute left-0 top-full mt-2 w-52 rounded-xl shadow-2xl overflow-hidden z-50"
                              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                            >
                              {([
                                { plt: 'telegram', label: 'بناردە تێلیگرام', sub: 'Telegram', icon: '✈️' },
                                { plt: 'whatsapp', label: 'بناردە واتساپ', sub: 'WhatsApp', icon: '💬' },
                                { plt: 'native', label: 'بەشکردن...', sub: navigator.share ? 'بەشکردن' : 'کۆپی دەکات', icon: '↗️' },
                              ] as const).map(({ plt, label, sub, icon }) => (
                                <button key={plt} onClick={() => shareText(plt, transcription)}
                                  className="w-full flex items-center gap-3 px-4 py-3 text-right hover:bg-[#22c55e]/08 transition-colors border-b border-[#ffffff06] last:border-0"
                                >
                                  <span className="text-base shrink-0">{icon}</span>
                                  <div className="flex flex-col items-start">
                                    <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
                                    <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{sub}</span>
                                  </div>
                                </button>
                              ))}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                  {/* Karaoke toggle — fetches word timestamps on demand, not automatically */}
                  <div className="px-5 sm:px-7 pt-4 flex items-center gap-2" dir="ltr">
                    {!isTranscribing && transcription.trim() && (
                      <>
                        <button
                          onClick={() => setShowTimedView(false)}
                          className={`px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-wider font-bold transition-all ${!showTimedView ? 'bg-[#ff4e00] text-white' : 'border border-[#ffffff10] hover:border-[#ff4e00]/40 hover:text-[#ff4e00]'}`}
                          style={showTimedView ? { color: 'var(--text-muted)' } : undefined}
                        >تێکستی ئاسایی</button>
                        {isTimedTranscribing ? (
                          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-wider font-bold border border-[#ffffff10]" style={{ color: 'var(--text-muted)' }}>
                            <Loader2 size={11} className="animate-spin" />هایلایت ئامادەدەبێت...
                            <button onClick={cancelTimedTranscription}
                              className="text-[#555] hover:text-[#ff4e00] transition-colors mr-1"
                            ><X size={12} /></button>
                          </span>
                        ) : (
                          <button
                            onClick={async () => {
                              const words = await ensureTimedWords();
                              if (words.length > 0) setShowTimedView(true);
                            }}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-wider font-bold transition-all ${showTimedView ? 'bg-[#ff4e00] text-white' : 'border border-[#ffffff10] hover:border-[#ff4e00]/40 hover:text-[#ff4e00]'}`}
                            style={showTimedView ? undefined : { color: 'var(--text-muted)' }}
                          >🎵 هایلایتی دەنگ</button>
                        )}
                      </>
                    )}
                  </div>

                  <div className="px-5 sm:px-7 py-6 min-h-[120px]">
                    {showTimedView && timedWords.length > 0 ? (
                      <div className="text-xl sm:text-2xl md:text-3xl leading-[2.6] text-right" dir="rtl">
                        {timedWords.map((w, i) => {
                          const t = audioDuration > 0 ? (currentPct / 100) * audioDuration : -1;
                          const active = t >= w.start && t < w.end;
                          const past = t >= w.end;
                          return (
                            <span
                              key={i}
                              onClick={() => {
                                const el = audioElRef.current;
                                if (el) el.currentTime = w.start;
                              }}
                              className="cursor-pointer inline-block transition-all duration-150 rounded mx-[1px]"
                              style={
                                active
                                  ? { background: '#ff4e00', color: '#fff', padding: '0 5px', borderRadius: '5px', transform: 'scale(1.06)' }
                                  : past
                                  ? { color: 'var(--text-muted)', padding: '0 2px' }
                                  : { color: 'var(--text-primary)', padding: '0 2px' }
                              }
                            >{w.word}</span>
                          );
                        })}
                      </div>
                    ) : isEditingTranscription ? (
                      <textarea
                        ref={editableRef}
                        value={transcription}
                        onChange={e => setTranscription(e.target.value)}
                        className="w-full rounded-xl px-4 py-4 text-xl sm:text-2xl md:text-3xl leading-relaxed resize-none outline-none transition-colors min-h-[160px]"
                        style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,78,0,0.3)', color: 'var(--text-primary)', direction: targetLanguage === 'ar' || targetLanguage === 'ku' ? 'rtl' : 'ltr', fontFamily: 'inherit' }}
                        spellCheck={false}
                        rows={Math.max(4, transcription.split('\n').length + 1)}
                      />
                    ) : (
                      <p className="text-xl sm:text-2xl md:text-3xl leading-relaxed whitespace-pre-wrap cursor-text" style={{ color: 'var(--text-primary)' }}
                        onClick={() => { setIsEditingTranscription(true); setTimeout(() => editableRef.current?.focus(), 50); }}
                        title="کلیک بکە بۆ دەستکاریکردن"
                      ><TranscriptionWithCitations text={transcription} /></p>
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
                                <button onClick={() => copyText(summary)} className="text-[10px] text-[#555] hover:text-[#a855f7] transition-colors tracking-wider">کۆپیکردن</button>
                              )}
                              <button onClick={() => setShowSummary(false)} className="text-[#555] hover:text-white transition-colors"><X size={13} /></button>
                            </div>
                          </div>
                          {isSummarizing && !summary ? (
                            <div className="flex items-center gap-2 text-[#666] text-sm py-2">
                              <Loader2 size={14} className="animate-spin text-[#a855f7]" />
                              <span>پوختەکردن...</span>
                            </div>
                          ) : (
                            <p className="text-base leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{summary}</p>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="px-5 sm:px-7 pb-5 flex items-center gap-3" dir="ltr">
                    <div className="flex-1 h-px bg-[#ff4e00]/40 rounded-full" />
                    <span className="text-[10px] tracking-widest" style={{ color: 'var(--text-faintest)' }}>{isEditingTranscription ? 'دەستکاریکردن' : 'تەواوبوو'}</span>
                  </div>
                </motion.section>
              )}
            </AnimatePresence>
          </>
        ) : activeTab === 'library' ? (
          /* ── LIBRARY ── */
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="rounded-2xl shadow-2xl overflow-hidden"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center justify-between px-5 sm:px-7 py-4" style={{ borderBottom: '1px solid var(--border-soft)' }}>
              <div className="flex items-center gap-2">
                <History size={15} style={{ color: 'var(--text-dim)' }} />
                <span className="text-[10px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-dim)' }}>کتێبخانەی نووسینەوەکان</span>
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
                  <Trash2 size={13} />سڕینەوەی هەموو تۆمارەکان
                </button>
              )}
            </div>

            {/* Search bar */}
            {history.length > 0 && (
              <div className="px-5 sm:px-7 py-3" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                <div className="relative">
                  <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-faint)' }} />
                  <input
                    type="text"
                    value={librarySearch}
                    onChange={e => setLibrarySearch(e.target.value)}
                    placeholder="گەڕان لە مێژوودا..."
                    dir="rtl"
                    className="w-full rounded-lg pr-9 pl-9 py-2.5 text-sm outline-none transition-colors"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-soft)', color: 'var(--text-primary)' }}
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
                  <div key={item.id} className="p-4 sm:p-5 rounded-xl flex flex-col gap-3 transition-colors" style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-soft)' }}>
                    <div className="flex justify-between items-start gap-2" dir="ltr">
                      <span className="flex items-center gap-1 text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>
                        <Clock size={10} />
                        {new Date(item.timestamp).toLocaleDateString()} {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <div className="flex gap-1.5 shrink-0">
                        {item.model && <span className="bg-card px-1.5 py-0.5 rounded text-[9px] text-[#666] border border-[#ffffff12] uppercase">{item.model}</span>}
                        <span className="bg-[#ff4e00]/10 px-1.5 py-0.5 rounded text-[9px] text-[#ff4e00] border border-[#ff4e00]/20">{item.language === 'ku' ? 'کوردی' : 'عەرەبی'}</span>
                      </div>
                    </div>
                    <p className="text-base leading-relaxed line-clamp-4 flex-1" style={{ color: 'var(--text-primary)' }}>{item.text}</p>
                    <div className="flex justify-between items-center pt-3" style={{ borderTop: '1px solid var(--border-soft)' }}>
                      <span className="text-[10px] font-mono" style={{ color: 'var(--text-faintest)' }}>#{item.id.slice(-6)}</span>
                      <div className="flex gap-1.5">
                        <button onClick={() => setDeleteConfirmId(item.id)}
                          className="p-1.5 text-[#444] hover:text-[#ff4e00] bg-card border border-[#ffffff08] rounded-lg transition-colors"
                        ><Trash2 size={12} /></button>
                        <button onClick={() => copyText(item.text, item.id)}
                          className="p-1.5 text-[#444] hover:text-white bg-card border border-[#ffffff08] rounded-lg transition-colors"
                        >{copiedId === item.id ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}</button>
                        {/* Export dropdown */}
                        <div className="relative">
                          <button
                            onClick={() => setOpenLibraryExport(openLibraryExport === item.id ? null : item.id)}
                            className="flex items-center gap-1 px-2 py-1.5 text-[#444] hover:text-[#ff4e00] bg-card border border-[#ffffff08] rounded-lg transition-colors"
                          >
                            <Download size={12} />
                            <ChevronDown size={10} className={`transition-transform ${openLibraryExport === item.id ? 'rotate-180' : ''}`} />
                          </button>
                          <AnimatePresence>
                            {openLibraryExport === item.id && (
                              <motion.div
                                initial={{ opacity: 0, y: 4, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 4, scale: 0.95 }}
                                className="absolute left-0 bottom-full mb-1.5 w-44 rounded-xl shadow-2xl overflow-hidden z-50"
                                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                              >
                                {([
                                  { fmt: 'txt', label: 'داگرتن بە .TXT', sub: 'تێکستی سادە' },
                                  { fmt: 'docx', label: 'داگرتن بە .DOC', sub: 'Microsoft Word' },
                                  { fmt: 'pdf', label: 'چاپکردن / PDF', sub: 'چاپ و خەزنکردن' },
                                ] as const).map(({ fmt, label, sub }) => (
                                  <button key={fmt}
                                    onClick={() => { exportText(fmt, item.text); setOpenLibraryExport(null); }}
                                    className="w-full flex flex-col items-start px-3 py-2.5 text-right hover:bg-[#ff4e00]/10 transition-colors border-b border-[#ffffff06] last:border-0"
                                  >
                                    <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
                                    <span className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{sub}</span>
                                  </button>
                                ))}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
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
                <p className="text-[#444] text-sm">هیچ تۆمارێک بوونی نییە</p>
              </div>
            )}
          </motion.section>
        ) : activeTab === 'hadith-search' ? (
          /* ── HADITH SEARCH ── */
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="rounded-2xl shadow-2xl overflow-hidden"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2 px-5 sm:px-7 py-4" style={{ borderBottom: '1px solid var(--border-soft)' }}>
              <Search size={15} style={{ color: 'var(--text-dim)' }} />
              <span className="text-[10px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-dim)' }}>گەڕانی واتایی بۆ فەرموودەکان</span>
            </div>

            <div className="px-5 sm:px-7 py-5 space-y-3">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                واتا یان وەسفی فەرموودەکە بە کوردی بنووسە، سیستەمەکە دەقی عەرەبی ڕەسەنی فەرموودەکە لەگەڵ ناوی ڕاوی و سەرچاوەکەی بۆ دەدۆزێتەوە.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <textarea
                  value={hadithQuery}
                  onChange={e => setHadithQuery(e.target.value)}
                  placeholder="بۆ نموونە: ئەو فەرموودەیە کە باسی نیەت دەکات..."
                  dir="rtl"
                  rows={2}
                  className="flex-1 rounded-xl px-4 py-3 text-sm outline-none transition-colors resize-none"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border-soft)', color: 'var(--text-primary)' }}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); searchHadith(); } }}
                />
                <button onClick={searchHadith} disabled={isSearchingHadith || !hadithQuery.trim()}
                  className="px-5 py-3 rounded-xl bg-[#ff4e00] text-white font-bold text-xs tracking-[0.08em] shadow-[0_0_20px_rgba(255,78,0,0.25)] hover:shadow-[0_0_30px_rgba(255,78,0,0.4)] hover:bg-[#e64600] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shrink-0"
                >
                  {isSearchingHadith ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                  گەڕان
                </button>
              </div>

              {hadithSearchError && (
                <p className="text-xs text-red-500">{hadithSearchError}</p>
              )}

              {hadithResults.length > 0 && (
                <div className="space-y-3 pt-2">
                  {hadithResults.map((result, i) => {
                    const copyId = `hadith-${i}`;
                    const fullCitation = `﴿${result.arabicText}﴾ [رواه ${result.narrator}، ${result.book}${result.chapter ? `، ${result.chapter}` : ''}]`;
                    return (
                      <div key={i} className="rounded-xl overflow-hidden" dir="rtl"
                        style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.2)' }}
                      >
                        {/* Status bar */}
                        <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: '1px solid rgba(168,85,247,0.15)' }}>
                          {result.verified
                            ? <span className="text-[10px] uppercase tracking-wider font-bold text-green-500">✓ پشتڕاستکراوە</span>
                            : <span className="text-[10px] uppercase tracking-wider font-bold text-amber-500">دڵنیا نییت — پشتڕاستی نەکراوەتەوە</span>}
                          <button onClick={() => copyText(fullCitation, copyId)}
                            title="کۆپیکردنی فەرموودەکە"
                            className="shrink-0 p-1.5 rounded-lg bg-card border border-[#ffffff10] hover:bg-[#222] transition-colors"
                          >
                            {copiedId === copyId ? <Check size={13} className="text-green-400" /> : <Copy size={13} style={{ color: 'var(--text-muted)' }} />}
                          </button>
                        </div>

                        {/* 1. Arabic text */}
                        <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(168,85,247,0.15)' }}>
                          <p className="text-[9px] uppercase tracking-widest font-bold mb-1.5" style={{ color: 'var(--text-faint)' }}>دەقی فەرموودەکە</p>
                          <p className="font-semibold text-lg leading-loose" style={{ fontFamily: "'Amiri Quran', 'Traditional Arabic', 'Scheherazade New', serif" }}>
                            ﴿{result.arabicText}﴾
                          </p>
                        </div>

                        {/* 2. Narrator */}
                        <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(168,85,247,0.15)' }}>
                          <p className="text-[9px] uppercase tracking-widest font-bold mb-1.5" style={{ color: 'var(--text-faint)' }}>ڕاوی (گێڕەڕەوە)</p>
                          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{result.narrator}</p>
                        </div>

                        {/* 3. Source */}
                        <div className="px-4 py-3">
                          <p className="text-[9px] uppercase tracking-widest font-bold mb-1.5" style={{ color: 'var(--text-faint)' }}>سەرچاوە</p>
                          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                            {result.book}
                            {result.chapter && ` — ${result.chapter}`}
                            {result.grading && ` (${result.grading})`}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {!isSearchingHadith && !hadithSearchError && hadithResults.length === 0 && hadithQuery.trim() === '' && (
                <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                  <Search size={32} className="text-[#ffffff08] mb-3" />
                  <p className="text-[#444] text-sm">وەسفی فەرموودەکە بنووسە بۆ دەستپێکردنی گەڕان</p>
                </div>
              )}
            </div>
          </motion.section>
        ) : activeTab === 'arabic-grammar' ? (
          /* ── ARABIC GRAMMAR CORRECTOR ── */
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="rounded-2xl shadow-2xl overflow-hidden"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2 px-5 sm:px-7 py-4" style={{ borderBottom: '1px solid var(--border-soft)' }}>
              <SpellCheck size={15} style={{ color: 'var(--text-dim)' }} />
              <span className="text-[10px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-dim)' }}>ڕاستکردنەوەی ڕێزمانی عەرەبی</span>
            </div>

            <div className="px-5 sm:px-7 py-5 space-y-3">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                دەقی عەرەبی بنووسە، سیستەمەکە هەڵەکانی ڕێنووس، نحو، و صرف ڕاستدەکاتەوە بەبێ ئەوەی هیچ وشەیەک زیاد یان کەم بکات یان مانا بگۆڕێت.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <p className="text-[9px] uppercase tracking-widest font-bold mb-1.5" style={{ color: 'var(--text-faint)' }}>دەقی سەرەتایی</p>
                  <textarea
                    value={grammarInput}
                    onChange={e => setGrammarInput(e.target.value)}
                    placeholder="دەقی عەرەبی لێرە بنووسە..."
                    dir="rtl"
                    rows={8}
                    className="w-full rounded-xl px-4 py-3 text-base leading-relaxed outline-none transition-colors resize-none"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-soft)', color: 'var(--text-primary)', fontFamily: "'Amiri Quran', 'Traditional Arabic', serif" }}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[9px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-faint)' }}>دەقی ڕاستکراوە</p>
                    {grammarResult && (
                      <button onClick={() => copyText(grammarResult.correctedText, 'grammar-corrected')}
                        title="کۆپیکردنی دەقی ڕاستکراوە"
                        className="shrink-0 p-1 rounded-md bg-card border border-[#ffffff10] hover:bg-[#222] transition-colors"
                      >
                        {copiedId === 'grammar-corrected' ? <Check size={12} className="text-green-400" /> : <Copy size={12} style={{ color: 'var(--text-muted)' }} />}
                      </button>
                    )}
                  </div>
                  <div dir="rtl"
                    className="w-full rounded-xl px-4 py-3 text-base leading-relaxed overflow-auto select-text"
                    style={{ minHeight: 'calc(8 * 1.625em + 1.5rem)', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', color: 'var(--text-primary)', fontFamily: "'Amiri Quran', 'Traditional Arabic', serif" }}
                  >
                    {grammarResult ? (
                      buildGrammarDiffSegments(grammarResult.correctedText, grammarResult.errors).map((seg, i) =>
                        seg.changed
                          ? <span key={i} className="text-green-500 font-semibold bg-green-500/10 rounded px-0.5">{seg.text}</span>
                          : <span key={i}>{seg.text}</span>
                      )
                    ) : (
                      <span style={{ color: 'var(--text-faint)' }}>دەقی ڕاستکراوە لێرە دەردەکەوێت...</span>
                    )}
                  </div>
                </div>
              </div>

              <button onClick={correctGrammar} disabled={isCorrectingGrammar || !grammarInput.trim()}
                className="w-full py-3 rounded-xl bg-[#ff4e00] text-white font-bold text-xs tracking-[0.08em] shadow-[0_0_20px_rgba(255,78,0,0.25)] hover:shadow-[0_0_30px_rgba(255,78,0,0.4)] hover:bg-[#e64600] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isCorrectingGrammar ? <Loader2 size={14} className="animate-spin" /> : <SpellCheck size={14} />}
                ڕاستکردنەوە
              </button>

              {grammarError && (
                <p className="text-xs text-red-500">{grammarError}</p>
              )}

              {grammarResult && (
                <div className="space-y-3 pt-2">
                  {/* Error report */}
                  {grammarResult.errors.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-[9px] uppercase tracking-widest font-bold px-1" style={{ color: 'var(--text-faint)' }}>
                        ڕاپۆرتی هەڵەکان ({grammarResult.errors.length})
                      </p>
                      {grammarResult.errors.map((err, i) => (
                        <div key={i} className="rounded-xl px-4 py-3" dir="rtl" style={{ background: 'rgba(255,78,0,0.05)', border: '1px solid rgba(255,78,0,0.18)' }}>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-[9px] px-2 py-0.5 rounded-full bg-[#ff4e00]/15 text-[#ff4e00] font-bold uppercase tracking-wider">{err.type}</span>
                          </div>
                          <div className="flex items-center gap-2 text-base mb-1.5" style={{ fontFamily: "'Amiri Quran', 'Traditional Arabic', serif" }}>
                            <span className="text-red-400 line-through">{err.original}</span>
                            <span style={{ color: 'var(--text-faint)' }}>←</span>
                            <span className="text-green-500 font-semibold">{err.corrected}</span>
                          </div>
                          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{err.explanation}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 px-4 py-3 rounded-xl" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)' }} dir="rtl">
                      <Check size={16} className="text-green-500 shrink-0" />
                      <p className="text-sm" style={{ color: 'var(--text-primary)' }}>هیچ هەڵەیەک نەدۆزرایەوە — دەقەکە ڕێزمانی بێخەوشە.</p>
                    </div>
                  )}
                </div>
              )}

            </div>
          </motion.section>
        ) : activeTab === 'profile' ? (
          <ProfilePage user={user} />
        ) : null}
      </main>

      <footer className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex items-center justify-between text-[10px] tracking-widest" style={{ color: 'var(--text-faintest)' }} dir="rtl">
        <span>کوردیشتراسکریپشن</span>
      </footer>

      {/* Cookie Error Modal */}
      <AnimatePresence>
        {cookieError && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
          >
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="rounded-2xl p-6 sm:p-8 shadow-2xl max-w-sm w-full text-center"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              <h3 className="text-xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>پێویست بە ڕێگەپێدانی کووکی دەکات</h3>
              <p className="text-sm mb-6 leading-relaxed" style={{ color: 'var(--text-muted)' }}>تکایە ئەپەکە لە تابێکی نوێ بکەرەوە.</p>
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
              className="rounded-2xl p-6 shadow-2xl max-w-xs w-full"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
                {deleteConfirmId === 'all' ? 'سڕینەوەی هەموو تۆمارەکان' : 'سڕینەوەی تۆمار'}
              </h3>
              <p className="text-sm mb-5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {deleteConfirmId === 'all' ? 'دڵنیای کە دەتەوێت هەموو تۆمارەکان بسڕیتەوە؟' : 'دڵنیای کە دەتەوێت ئەم تۆمارە بسڕیتەوە؟'}
              </p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setDeleteConfirmId(null)} className="px-4 py-2 text-sm hover:text-white transition-colors rounded-lg" style={{ color: 'var(--text-muted)' }}>پاشگەزبوونەوە</button>
                <button onClick={confirmDelete} className="px-4 py-2 text-sm font-medium bg-[#ff4e00] text-white rounded-lg hover:bg-[#e64600] transition-colors">بەڵێ، بسڕەوە</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* user menu closed via useEffect mousedown */}
      {/* Close export menu on outside click */}
      {showExportMenu && <div className="fixed inset-0 z-20" onClick={() => setShowExportMenu(false)} />}
      {/* Close share menu on outside click */}
      {showShareMenu && <div className="fixed inset-0 z-20" onClick={() => setShowShareMenu(false)} />}
      {/* Close library export dropdown on outside click */}
      {openLibraryExport && <div className="fixed inset-0 z-40" onClick={() => setOpenLibraryExport(null)} />}
    </div>
  );
}
