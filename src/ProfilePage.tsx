import { useState } from "react";
import { updateProfile } from "firebase/auth";
import { User, Mail, Pencil, Check, X, Loader2 } from "lucide-react";
import { auth } from "./firebase";
import type { User as FirebaseUser } from "firebase/auth";

export default function ProfilePage({ user }: { user: FirebaseUser }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.displayName || "");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await updateProfile(auth.currentUser!, { displayName: name.trim() });
      setSuccess(true);
      setEditing(false);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e: any) {
      setError("نەتوانرا ناوەکە بگۆڕدرێت.");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setName(user.displayName || "");
    setEditing(false);
    setError(null);
  };

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <h2 className="text-lg font-bold text-white">پرۆفایل</h2>

      <div className="bg-[#141416] border border-[#ffffff10] rounded-2xl overflow-hidden">
        {/* Avatar */}
        <div className="flex items-center gap-4 p-5 border-b border-[#ffffff08]">
          {user.photoURL
            ? <img src={user.photoURL} className="w-14 h-14 rounded-full ring-2 ring-[#ff4e00]/30" alt="" />
            : (
              <div className="w-14 h-14 rounded-full bg-[#1e1e20] border border-[#ffffff10] flex items-center justify-center">
                <User size={24} className="text-[#555]" />
              </div>
            )
          }
          <div>
            <p className="text-white font-semibold">{user.displayName || "کاربەر"}</p>
            <p className="text-xs text-[#555]">{user.email}</p>
          </div>
        </div>

        {/* Name field */}
        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-[#555] font-medium">ناو</label>
            {editing ? (
              <div className="flex gap-2">
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel(); }}
                  autoFocus
                  className="flex-1 bg-[#0a0a0b] border border-[#ff4e00]/50 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#ff4e00]"
                  placeholder="ناوت بنووسە..."
                />
                <button onClick={handleSave} disabled={loading}
                  className="bg-[#ff4e00] text-white rounded-lg px-3 py-2 hover:bg-[#e04400] transition-colors disabled:opacity-50"
                >
                  {loading ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                </button>
                <button onClick={handleCancel}
                  className="bg-[#1e1e20] text-[#888] rounded-lg px-3 py-2 hover:text-white transition-colors"
                >
                  <X size={15} />
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between bg-[#0a0a0b] border border-[#ffffff08] rounded-lg px-3 py-2">
                <span className="text-sm text-white">{user.displayName || "—"}</span>
                <button onClick={() => setEditing(true)}
                  className="text-[#555] hover:text-[#ff4e00] transition-colors"
                >
                  <Pencil size={13} />
                </button>
              </div>
            )}
            {error && <p className="text-xs text-red-400">{error}</p>}
            {success && <p className="text-xs text-green-400">ناوەکە گۆڕدرا ✓</p>}
          </div>

          {/* Email field (read-only) */}
          <div className="space-y-1.5">
            <label className="text-xs text-[#555] font-medium">ئیمەیڵ</label>
            <div className="flex items-center gap-2 bg-[#0a0a0b] border border-[#ffffff08] rounded-lg px-3 py-2">
              <Mail size={13} className="text-[#555] shrink-0" />
              <span className="text-sm text-[#888]">{user.email}</span>
            </div>
            <p className="text-[10px] text-[#444]">ئیمەیڵ ناگۆڕدرێت</p>
          </div>

          {/* Provider */}
          <div className="space-y-1.5">
            <label className="text-xs text-[#555] font-medium">شێوازی داخلبوون</label>
            <div className="bg-[#0a0a0b] border border-[#ffffff08] rounded-lg px-3 py-2">
              <span className="text-sm text-[#888]">
                {user.providerData[0]?.providerId === 'google.com' ? '🔵 Google' : '📧 ئیمەیڵ'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
