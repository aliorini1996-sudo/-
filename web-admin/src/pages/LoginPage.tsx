import { useState } from 'react';
import { Eye, EyeOff, Mail, Lock, ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { authApi } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { BrandIcon, BrandWordmark } from '../components/BrandLogo';
import ForgotPasswordDialog from '../components/ForgotPasswordDialog';
import LanguageToggle from '../components/LanguageToggle';
import { useT } from '../i18n/strings';
import { useDir } from '../i18n/lang';

export default function LoginPage() {
  const { login } = useAuthStore();
  const t = useT();
  const dir = useDir();
  const [form, setForm] = useState({ username: '', password: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password) { toast.error(t('login.fillAll')); return; }
    setLoading(true);
    try {
      const res = await authApi.login({ ...form, role: 'admin' });
      const { token, user } = res.data.data;
      login(token, user);
      toast.success(`${t('login.welcomeName')} ${user.name}`);
      // إعادة تحميل كاملة لمساحة الشركة — تضمن تهيئة الجلسة من token بلا أي تداخل
      window.location.replace('/app');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || t('login.error');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-[#FAF7F0]" dir={dir}>
      {/* ===== اللوحة التعريفية (تظهر على الشاشات الكبيرة) ===== */}
      <div className="hidden lg:flex lg:w-[52%] relative overflow-hidden bg-[#1F1A13] items-center justify-center">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(130% 130% at 82% 8%, rgba(225,90,48,.28), transparent 55%)' }} />
        {/* دوائر عائمة بألوان الهوية */}
        <span className="absolute rounded-full" style={{ width: 230, height: 230, top: '8%', left: '6%', background: 'rgba(225,90,48,.16)' }} />
        <span className="absolute rounded-full" style={{ width: 130, height: 130, bottom: '14%', left: '20%', background: 'rgba(30,122,82,.18)' }} />
        <span className="absolute rounded-full" style={{ width: 90, height: 90, top: '22%', right: '14%', background: 'rgba(224,160,44,.20)' }} />
        <span className="absolute rounded-full" style={{ width: 60, height: 60, bottom: '26%', right: '24%', background: 'rgba(250,247,240,.10)' }} />

        <div className="relative z-10 px-14 text-center max-w-lg">
          <div className="inline-flex mb-7" style={{ filter: 'drop-shadow(0 16px 40px rgba(225,90,48,.45))' }}>
            <BrandIcon size={96} radius={0.26} />
          </div>
          <div style={{ fontFamily: "'IBM Plex Sans', sans-serif" }} className="text-4xl font-bold tracking-tight">
            <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
          </div>
          <p className="text-[#C9BEAC] mt-4 text-[15px] leading-relaxed">{t('login.heroLead')}</p>

          {/* بطاقات معاينة زجاجية */}
          <div className="mt-10 space-y-3" style={{ textAlign: dir === 'rtl' ? 'right' : 'left' }}>
            <div className="rounded-2xl border border-white/10 bg-white/[0.06] backdrop-blur p-4 flex items-center justify-between">
              <div>
                <p className="text-[#9A8F7E] text-xs">{t('login.salesToday')}</p>
                <p className="text-white font-bold text-lg" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>٨٬٤٥٠ <span className="text-xs text-[#C9BEAC]">ر.س</span></p>
              </div>
              <span className="w-10 h-10 rounded-xl bg-[#E15A30]/20 flex items-center justify-center text-[#E89B7E] text-lg">↗</span>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.06] backdrop-blur p-4 flex items-center justify-between">
              <div>
                <p className="text-[#9A8F7E] text-xs">{t('login.collectToday')}</p>
                <p className="text-white font-bold text-lg" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>٦٬٢٠٠ <span className="text-xs text-[#C9BEAC]">ر.س</span></p>
              </div>
              <span className="w-10 h-10 rounded-xl bg-[#1E7A52]/25 flex items-center justify-center text-[#5FBE92] text-lg">✓</span>
            </div>
          </div>
        </div>
      </div>

      {/* ===== لوحة النموذج ===== */}
      <div className="flex-1 flex items-center justify-center p-6 relative">
        <div className="absolute top-4" style={{ insetInlineEnd: '16px' }}><LanguageToggle /></div>
        <div className="w-full max-w-sm">
          <div className="flex justify-center lg:justify-start mb-8">
            <BrandWordmark iconSize={50} />
          </div>

          <h1 className="text-2xl font-bold text-[#1F1A13]">{t('login.welcome')}</h1>
          <p className="text-[#6E6557] mt-1.5 text-sm">{t('login.subtitle')}</p>

          <form onSubmit={handleSubmit} className="space-y-4 mt-7">
            <div>
              <label className="label">{t('login.email')}</label>
              <div className="relative">
                <Mail size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                <input type="text" className="input pr-9" placeholder="admin@company.com"
                  value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  autoComplete="username" dir="ltr" />
              </div>
            </div>

            <div>
              <label className="label">{t('login.password')}</label>
              <div className="relative">
                <Lock size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                <input type={showPass ? 'text' : 'password'} className="input pr-9 pl-9" placeholder="••••••••"
                  value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  autoComplete="current-password" dir="ltr" />
                <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9A8F7E] hover:text-[#1F1A13]"
                  onClick={() => setShowPass(s => !s)}>
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading}
              className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2">
              {loading ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                : <>{t('login.submit')} <ArrowLeft size={17} className={dir === 'rtl' ? '' : 'rotate-180'} /></>}
            </button>
          </form>

          <button type="button" onClick={() => setShowForgot(true)}
            className="text-sm text-[#6E6557] hover:text-[#E15A30] mt-4 mx-auto block transition-colors">
            {t('login.forgot')}
          </button>

        </div>
      </div>

      {showForgot && <ForgotPasswordDialog role="admin" onClose={() => setShowForgot(false)} />}
    </div>
  );
}
