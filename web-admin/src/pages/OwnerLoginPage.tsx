import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { authApi } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { BrandIcon } from '../components/BrandLogo';

// مدخل سرّي لمالك المنصّة فقط — رابط /owner
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
    <div className="min-h-screen relative overflow-hidden bg-[#1F1A13] flex items-center justify-center p-6" dir="rtl">
      <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 120% at 50% 0%, rgba(225,90,48,.22), transparent 55%)' }} />
      <span className="absolute rounded-full" style={{ width: 260, height: 260, top: '-60px', right: '-40px', background: 'rgba(225,90,48,.12)' }} />
      <span className="absolute rounded-full" style={{ width: 180, height: 180, bottom: '-30px', left: '-20px', background: 'rgba(224,160,44,.10)' }} />

      <div className="relative z-10 w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex mb-5" style={{ filter: 'drop-shadow(0 14px 36px rgba(225,90,48,.4))' }}>
            <BrandIcon size={78} radius={0.26} />
          </div>
          <div style={{ fontFamily: "'IBM Plex Sans', sans-serif" }} className="text-3xl font-bold tracking-tight">
            <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
          </div>
          <p className="text-[#9A8F7E] mt-2 text-sm flex items-center justify-center gap-1.5">
            <ShieldCheck size={14} /> لوحة مالك المنصّة — دخول خاص
          </p>
        </div>

        <div className="bg-white/[0.04] backdrop-blur border border-white/10 rounded-2xl p-7">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm text-[#C9BEAC] mb-1.5 block">البريد الإلكتروني</label>
              <div className="relative">
                <Mail size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                <input type="text" dir="ltr" placeholder="owner@..."
                  className="w-full bg-[#15110b] border border-white/10 rounded-xl px-3 py-2.5 pr-9 text-white placeholder-[#6E6557] focus:outline-none focus:border-[#E15A30]"
                  value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} autoComplete="username" />
              </div>
            </div>
            <div>
              <label className="text-sm text-[#C9BEAC] mb-1.5 block">كلمة المرور</label>
              <div className="relative">
                <Lock size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                <input type={showPass ? 'text' : 'password'} dir="ltr" placeholder="••••••••"
                  className="w-full bg-[#15110b] border border-white/10 rounded-xl px-3 py-2.5 pr-9 pl-9 text-white placeholder-[#6E6557] focus:outline-none focus:border-[#E15A30]"
                  value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} autoComplete="current-password" />
                <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9A8F7E] hover:text-white" onClick={() => setShowPass(s => !s)}>
                  {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading}
              className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:opacity-60 text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-1">
              {loading ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'دخول'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
