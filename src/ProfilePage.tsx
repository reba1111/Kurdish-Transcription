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
    } catch {
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
      <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>پرۆفایل</h2>

      <div className="rounded-2xl overflow-hidden border" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
        {/* Avatar */}
        <div className="flex items-center gap-4 p-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          {user.photoURL
            ? <img src={user.photoURL} className="w-14 h-14 rounded-full ring-2 ring-[#ff4e00]/30" alt="" />
            : (
              <div className="w-14 h-14 rounded-full border flex items-center justify-center" style={{ background: 'var(--bg-hover)', borderColor: 'var(--border)' }}>
                <User size={24} style={{ color: 'var(--text-dim)' }} />
              </div>
            )
          }
          <div>
            <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{user.displayName || "کاربەر"}</p>
            <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{user.email}</p>
          </div>
        </div>

        {/* Fields */}
        <div className="p-5 space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>ناو</label>
            {editing ? (
              <div className="flex gap-2">
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel(); }}
                  autoFocus
                  className="flex-1 rounded-lg px-3 py-2 text-sm outline-none border border-[#ff4e00]/50 focus:border-[#ff4e00]"
                  style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                  placeholder="ناوت بنووسە..."
                />
                <button onClick={handleSave} disabled={loading}
                  className="bg-[#ff4e00] text-white rounded-lg px-3 py-2 hover:bg-[#e04400] transition-colors disabled:opacity-50"
                >
                  {loading ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                </button>
                <button onClick={handleCancel}
                  className="rounded-lg px-3 py-2 transition-colors border"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)', borderColor: 'var(--border)' }}
                >
                  <X size={15} />
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between rounded-lg px-3 py-2 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-soft)' }}>
                <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{user.displayName || "—"}</span>
                <button onClick={() => setEditing(true)} className="hover:text-[#ff4e00] transition-colors" style={{ color: 'var(--text-dim)' }}>
                  <Pencil size={13} />
                </button>
              </div>
            )}
            {error && <p className="text-xs text-red-400">{error}</p>}
            {success && <p className="text-xs text-green-500">ناوەکە گۆڕدرا ✓</p>}
          </div>

          {/* Email */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>ئیمەیڵ</label>
            <div className="flex items-center gap-2 rounded-lg px-3 py-2 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-soft)' }}>
              <Mail size={13} className="shrink-0" style={{ color: 'var(--text-dim)' }} />
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{user.email}</span>
            </div>
            <p className="text-[10px]" style={{ color: 'var(--text-faint)' }}>ئیمەیڵ ناگۆڕدرێت</p>
          </div>

          {/* Provider */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>شێوازی داخلبوون</label>
            <div className="rounded-lg px-3 py-2 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-soft)' }}>
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {user.providerData[0]?.providerId === 'google.com' ? '🔵 Google' : '📧 ئیمەیڵ'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
