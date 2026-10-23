import { useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock, LogOut } from 'lucide-react';
import toast from 'react-hot-toast';
import { staffAuthApi } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import { useT, useTr } from '../i18n/strings';
import { useDir } from '../i18n/lang';

const PASSWORD_MIN = 8;

/**
 * «غيّر كلمة المرور المؤقتة» — شاشة كاملة يعرضها StaffRoute بدل لوحة الموظف ما دام mustChangePassword.
 * الخادم لا يمرّر الموظف إلى أي قسم قبلها (STAFF_MUST_CHANGE_PASSWORD)، والتغيير يُسقط جلساته الأخرى ويعيد توكناً جديداً.
 */
export default function StaffChangePasswordPage() {
  const { user, login, logout } = useAuthStore();
  const t = useT();
  const tr = useTr();
  const dir = useDir();
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [cf, setCf] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cur) { toast.error(tr('ادخل كلمة المرور المؤقتة')); return; }
    if (nw.length < PASSWORD_MIN) { toast.error(tr('كلمة المرور الجديدة 8 احرف على الاقل')); return; }
    if (nw !== cf) { toast.error(tr('كلمتا المرور غير متطابقتين')); return; }
    if (nw === cur) { toast.error(tr('اختر كلمة مرور غير المؤقتة')); return; }
    setLoading(true);
    try {
      const res = await staffAuthApi.changePassword({ currentPassword: cur, newPassword: nw });
      const { token, user: staffUser } = res.data.data;
      login(token, staffUser);
      toast.success(tr('تم تغيير كلمة المرور'));
      window.location.replace('/staff');
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر تغيير كلمة المرور'));
    } finally {
      setLoading(false);
    }
  };

  const signOut = () => { logout(); window.location.replace('/staff/login'); };

  const field = (label: string, value: string, setter: (v: string) => void, autoComplete: string) => (
    <div>
      <label className="text-sm text-[#C9BEAC] mb-1.5 block">{label}</label>
      <div className="relative">
        <Lock size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
        <input type={show ? 'text' : 'password'} dir="ltr"
          className="w-full bg-[#15110b] border border-white/10 rounded-xl px-3 py-2.5 pr-9 text-white placeholder-[#6E6557] focus:outline-none focus:border-[#E15A30]"
          value={value} onChange={e => setter(e.target.value)} autoComplete={autoComplete} />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#1F1A13] flex items-center justify-center p-6" dir={dir}>
      <div className="absolute top-4 z-20" style={{ insetInlineEnd: '16px' }}><LanguageToggle variant="dark" /></div>
      <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 120% at 50% 0%, rgba(225,90,48,.22), transparent 55%)' }} />

      <div className="relative z-10 w-full max-w-sm">
        <div className="text-center mb-7">
          <div className="inline-flex mb-4" style={{ filter: 'drop-shadow(0 14px 36px rgba(225,90,48,.4))' }}>
            <BrandIcon size={64} radius={0.26} />
          </div>
          <h1 className="text-xl font-bold text-[#FAF7F0] flex items-center justify-center gap-2">
            <KeyRound size={18} className="text-[#E15A30]" /> {tr('غير كلمة المرور المؤقتة')}
          </h1>
          <p className="text-[#9A8F7E] mt-2 text-sm leading-relaxed">
            {user?.name ? <>{t('login.welcomeName')} {user.name} — </> : null}
            {tr('اختر كلمة مرور خاصة بك قبل الدخول الى لوحتك')}
          </p>
        </div>

        <div className="bg-white/[0.04] backdrop-blur border border-white/10 rounded-2xl p-7">
          <form onSubmit={submit} className="space-y-4">
            {field(tr('كلمة المرور المؤقتة'), cur, setCur, 'current-password')}
            {field(tr('كلمة المرور الجديدة'), nw, setNw, 'new-password')}
            {field(tr('تاكيد كلمة المرور الجديدة'), cf, setCf, 'new-password')}
            <div className="flex items-center justify-between text-[11px] text-[#9A8F7E]">
              <span>{tr('8 احرف على الاقل')}</span>
              <button type="button" onClick={() => setShow(s => !s)} className="inline-flex items-center gap-1 hover:text-white">
                {show ? <EyeOff size={13} /> : <Eye size={13} />} {show ? tr('اخفاء كلمة المرور') : tr('اظهار كلمة المرور')}
              </button>
            </div>
            <button type="submit" disabled={loading}
              className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:opacity-60 text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
              {loading ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <><KeyRound size={16} /> {tr('حفظ ومتابعة')}</>}
            </button>
          </form>
          <button type="button" onClick={signOut}
            className="w-full mt-3 text-sm text-red-300 hover:text-red-200 hover:bg-red-500/10 rounded-xl py-2 flex items-center justify-center gap-2 transition-colors">
            <LogOut size={15} /> {tr('خروج')}
          </button>
        </div>
      </div>
    </div>
  );
}
