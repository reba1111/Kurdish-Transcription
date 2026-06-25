import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
} from "firebase/auth";
import { auth, googleProvider } from "./firebase";

export default function AuthPage() {
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleGoogle = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e: any) {
      setError("Google login شکستی هێنا. دووبارە هەوڵ بدەرەوە.");
    } finally {
      setLoading(false);
    }
  };

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await signInWithEmailAndPassword(auth, email, password);
      } else if (mode === "register") {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await sendPasswordResetEmail(auth, email);
        setInfo("ئیمەیلی گەڕانەوەی پاسوۆرد نێردرا. تکایە ئیمەیلەکەت بپشکنە.");
      }
    } catch (e: any) {
      const msg: Record<string, string> = {
        "auth/invalid-email": "ئیمەیلەکە دروست نییە.",
        "auth/user-not-found": "ئەم ئیمەیلە تۆمارنەکراوە.",
        "auth/wrong-password": "پاسوۆردەکە هەڵەیە.",
        "auth/email-already-in-use": "ئەم ئیمەیلە پێشتر تۆمارکراوە.",
        "auth/weak-password": "پاسوۆردەکە کەمتر لە ٦ پیت نابێت.",
        "auth/too-many-requests": "زۆر جار هەوڵت دا. چەند خولەک بوەستە.",
      };
      setError(msg[e.code] || "هەڵەیەک ڕوویدا. دووبارە هەوڵ بدەرەوە.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] flex items-center justify-center p-4" dir="rtl">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8" dir="ltr">
          <div className="w-9 h-9 bg-white rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(255,255,255,0.1)] relative">
            <div className="w-5 h-0.5 bg-[#0a0a0b] rounded-full rotate-45 absolute" />
            <div className="w-5 h-0.5 bg-[#0a0a0b] rounded-full -rotate-45" />
          </div>
          <span className="text-xl font-bold tracking-tighter text-white">
            Kurdish<span className="text-[#ff4e00]">Transcription</span>
          </span>
        </div>

        <div className="bg-[#141416] border border-[#ffffff10] rounded-2xl p-6 shadow-2xl">
          {/* Mode tabs */}
          <div className="flex bg-[#0a0a0b] rounded-lg p-1 mb-6 border border-[#ffffff08]">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(null); setInfo(null); }}
                className={`flex-1 py-2 text-xs font-bold uppercase tracking-widest rounded-md transition-all ${
                  mode === m ? "bg-[#ff4e00] text-white" : "text-[#555] hover:text-white"
                }`}
              >
                {m === "login" ? "داخلبوون" : "تۆمارکردن"}
              </button>
            ))}
          </div>

          {/* Google */}
          <button
            onClick={handleGoogle}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 py-3 rounded-xl border border-[#ffffff12] bg-[#1a1a1c] hover:bg-[#222] text-white text-sm font-medium transition-all disabled:opacity-50 mb-4"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            داخلبوون بە Google
          </button>

          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-[#ffffff08]" />
            <span className="text-[10px] text-[#444] uppercase tracking-widest">یان</span>
            <div className="flex-1 h-px bg-[#ffffff08]" />
          </div>

          {/* Email form */}
          <form onSubmit={handleEmail} className="space-y-3">
            <input
              type="email"
              placeholder="ئیمەیل"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="w-full bg-[#0a0a0b] border border-[#ffffff10] rounded-xl px-4 py-3 text-sm text-white placeholder-[#444] outline-none focus:border-[#ff4e00]/50 transition-colors"
              dir="ltr"
            />
            {mode !== "reset" && (
              <input
                type="password"
                placeholder="پاسوۆرد"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={6}
                className="w-full bg-[#0a0a0b] border border-[#ffffff10] rounded-xl px-4 py-3 text-sm text-white placeholder-[#444] outline-none focus:border-[#ff4e00]/50 transition-colors"
                dir="ltr"
              />
            )}

            <AnimatePresence>
              {error && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="text-[#ff4e00] text-xs bg-[#ff4e00]/08 border border-[#ff4e00]/20 px-3 py-2 rounded-lg"
                >
                  {error}
                </motion.p>
              )}
              {info && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="text-green-400 text-xs bg-green-400/08 border border-green-400/20 px-3 py-2 rounded-lg"
                >
                  {info}
                </motion.p>
              )}
            </AnimatePresence>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-[#ff4e00] text-white font-bold text-xs tracking-widest uppercase hover:bg-[#e64600] transition-all disabled:opacity-50 shadow-[0_0_20px_rgba(255,78,0,0.2)]"
            >
              {loading ? "چاوەڕوانبە..." : mode === "login" ? "داخلبوون" : mode === "register" ? "تۆمارکردن" : "نێردنی ئیمەیل"}
            </button>
          </form>

          {mode === "login" && (
            <button
              onClick={() => { setMode("reset"); setError(null); setInfo(null); }}
              className="w-full mt-3 text-[11px] text-[#444] hover:text-[#888] transition-colors"
            >
              پاسوۆردت لەبیرچووە؟
            </button>
          )}
          {mode === "reset" && (
            <button
              onClick={() => { setMode("login"); setError(null); setInfo(null); }}
              className="w-full mt-3 text-[11px] text-[#444] hover:text-[#888] transition-colors"
            >
              ← گەڕانەوە بۆ داخلبوون
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
