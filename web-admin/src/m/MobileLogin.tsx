import { useState } from 'react';
import { Eye, EyeOff, User as UserIcon, ArrowRight } from 'lucide-react';
import { authApi } from '../api/client';
import { BrandIcon } from '../components/BrandLogo';
import ForgotPasswordDialog from '../components/ForgotPasswordDialog';
import LanguageToggle from '../components/LanguageToggle';
import { useT } from '../i18n/strings';
import { User } from '../types';

/**
 * شاشة دخول تطبيق الإدارة — **داخل القوقعة لا على `/login`**.
 *
 * السبب: معترض 401 في `api/client.ts` يقذف إلى `/login` المكتبية. لو تُرك
 * الدخول لها لخرج المستخدم من التطبيق المثبَّت إلى صفحة سطح مكتب. فالمسار
 * الطبيعي (لا توكن ⇒ هذه الشاشة) لا يمرّ بها أصلاً.
 *
 * وهي تكتب في مفتاحَي `token`/`user` نفسيهما — جلسة لوحة الشركة — فمن دخل
 * اللوحة يجد التطبيق مفتوحاً، ولا حاجة لدخولٍ ثانٍ لنفس الإنسان.
 */
export default function MobileLogin({ onLogin, onBack }: { onLogin: (token: string, user: User) => void; onBack?: () => void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showForgot, setShowForgot] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await authApi.login({ username: email.trim(), password, role: 'admin' });
      const { token, user } = res.data.data as { token: string; user: User };
      onLogin(token, user);
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(msg || t('rep.badCreds'));
    } finally { setLoading(false); }
  };

  return (
    <div className="h-full relative overflow-hidden bg-[#1F1A13] flex flex-col items-center justify-center px-6">
      <div className="absolute top-3 z-20" style={{ insetInlineEnd: '12px' }}><LanguageToggle variant="dark" /></div>
      {onBack && (
        <button onClick={onBack} className="absolute top-3 z-20 text-[#9A8F7E] hover:text-white p-1" style={{ insetInlineStart: '12px' }} aria-label={t('intro.back')}>
          <ArrowRight size={20} />
        </button>
      )}
      <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 0%, rgba(225,90,48,.26), transparent 55%)' }} />
      <span className="absolute rounded-full" style={{ width: 170, height: 170, top: -40, right: -30, background: 'rgba(225,90,48,.14)' }} />
      <span className="absolute rounded-full" style={{ width: 120, height: 120, bottom: 40, left: -30, background: 'rgba(224,160,44,.10)' }} />

      <div className="relative z-10 w-full flex flex-col items-center">
        <div style={{ filter: 'drop-shadow(0 12px 30px rgba(225,90,48,.45))' }}>
          <BrandIcon size={76} radius={0.26} />
        </div>
        <h1 className="text-2xl tracking-tight mt-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}>
          <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
        </h1>
        <p className="text-[#9A8F7E] text-xs mb-8">{t('m.tagline')}</p>

        <form onSubmit={submit} className="w-full bg-white rounded-3xl p-6 shadow-2xl">
          <h2 className="font-bold text-[#1F1A13] mb-5">{t('m.loginTitle')}</h2>
          <div className="space-y-3">
            <div className="relative">
              <UserIcon size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
              <input className="input pr-9" type="email" placeholder={t('login.email')} dir="ltr"
                autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div className="relative">
              <input className="input pr-3 pl-9" type={showPass ? 'text' : 'password'} placeholder={t('login.password')} dir="ltr"
                autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
              <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]"
                onClick={() => setShowPass(s => !s)}>
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {error && <p className="text-[#C0392B] text-xs mt-2">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-[#E15A30] hover:bg-[#C94E28] text-white font-bold py-3 rounded-xl mt-5 flex items-center justify-center gap-2 disabled:bg-[#E89B7E] min-h-[48px]">
            {loading && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {t('login.submit')}
          </button>
          <button type="button" onClick={() => setShowForgot(true)}
            className="w-full text-center text-xs text-[#6E6557] hover:text-[#E15A30] mt-3 transition-colors">
            {t('login.forgot')}
          </button>
        </form>
      </div>

      {showForgot && <ForgotPasswordDialog role="admin" onClose={() => setShowForgot(false)} />}
    </div>
  );
}
