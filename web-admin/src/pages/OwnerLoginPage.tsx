import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { authApi } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { BrandIcon } from '../components/BrandLogo';

// مدخل سرّي لمالك المنصّة فقط — رابط /owner (لا يظهر للعملاء)
export default function OwnerLoginPage() {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [form, setForm] = useState({ username: '', password: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password) { toast.error('يرجى ملء جميع الحقول'); return; }
    setLoading(true);
    try {
      const res = await authApi.login({ ...form, role: 'super_admin' });
      const { token, user } = res.data.data;
      login(token, user);
      toast.success(`مرحباً ${user.name}`);
      navigate('/platform');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'خطأ في تسجيل الدخول';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center mb-4">
            <BrandIcon size={68} />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight">
            <span className="text-white">Field</span><span className="text-sky-400">Sales</span>
          </h1>
          <p className="text-slate-400 mt-1 text-sm">لوحة مالك المنصّة — دخول خاص</p>
        </div>

        <div className="bg-slate-800/60 backdrop-blur border border-white/10 rounded-2xl shadow-2xl p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm text-slate-300 mb-1.5 block">البريد الإلكتروني</label>
              <input
                type="text"
                className="w-full bg-slate-900/70 border border-white/10 rounded-xl px-3 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-slate-400"
                placeholder="owner@..."
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                autoComplete="username"
                dir="ltr"
              />
            </div>

            <div>
              <label className="text-sm text-slate-300 mb-1.5 block">كلمة المرور</label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  className="w-full bg-slate-900/70 border border-white/10 rounded-xl px-3 py-2.5 pl-10 text-white placeholder-slate-500 focus:outline-none focus:border-slate-400"
                  placeholder="••••••••"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  autoComplete="current-password"
                  dir="ltr"
                />
                <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                  onClick={() => setShowPass(s => !s)}>
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading}
              className="w-full bg-white text-slate-900 hover:bg-slate-100 disabled:opacity-60 font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
              {loading ? <span className="inline-block w-5 h-5 border-2 border-slate-400 border-t-slate-900 rounded-full animate-spin" /> : null}
              دخول
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
