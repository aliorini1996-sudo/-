import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock, Building2, User, Phone, CheckCircle2, Sparkles, Globe2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { authApi } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import { useT } from '../i18n/strings';
import { useDir, useLang } from '../i18n/lang';
import { supportedCountries } from '../i18n/countries';
import { ARAB_DIAL, WORLD_DIAL, flagOf, dialOf } from '../i18n/dialCodes';

// التسجيل الذاتي للتجربة المجانية — ينشئ شركة بتجربة 14 يوماً ويدخل مباشرة
export default function SignupPage() {
  const { login } = useAuthStore();
  const t = useT();
  const dir = useDir();
  const lang = useLang((s) => s.lang);
  const countries = supportedCountries();
  const [form, setForm] = useState({ companyName: '', country: '', adminName: '', email: '', phone: '', password: '', confirm: '' });
  const [agree, setAgree] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  // بادئة الجوال: دولة مستقلّة قابلة للتغيير لأي دولة في العالم — تتبع دولة الشركة افتراضياً ثم يمكن تغييرها
  const [phoneCountry, setPhoneCountry] = useState('SA');
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  // مزامنة بادئة الجوال مع دولة الشركة عند اختيارها (تبقى قابلة للتعديل يدوياً بعدها)
  useEffect(() => { if (form.country) setPhoneCountry(form.country); }, [form.country]);
  const dial = dialOf(phoneCountry) || '+966'; // بادئة الجوال حسب دولة الهاتف المختارة

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.companyName.trim()) { toast.error(t('signup.errCompany')); return; }
    if (!form.country) { toast.error(t('signup.errCountry')); return; }
    if (!form.adminName.trim()) { toast.error(t('signup.errName')); return; }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(form.email)) { toast.error(t('signup.errEmail')); return; }
    if (form.password.length < 6) { toast.error(t('signup.errPass')); return; }
    if (form.password !== form.confirm) { toast.error(t('signup.errMatch')); return; }
    if (!agree) { toast.error(t('signup.errAgree')); return; }
    setLoading(true);
    try {
      const res = await authApi.signup({
        companyName: form.companyName.trim(), adminName: form.adminName.trim(),
        countryCode: form.country,
        email: form.email.trim(), password: form.password,
        phone: form.phone ? `${dial}${form.phone.replace(/^0+/, '')}` : undefined,
      });
      const { token, user } = res.data.data;
      login(token, user);
      toast.success(t('signup.success'));
      window.location.replace('/app');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || t('signup.failed');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-[#FAF7F0]" dir={dir}>
      {/* لوحة تعريفية (شاشات كبيرة) */}
      <div className="hidden lg:flex lg:w-[46%] relative overflow-hidden bg-[#1F1A13] items-center justify-center">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(130% 130% at 82% 8%, rgba(225,90,48,.28), transparent 55%)' }} />
        <span className="absolute rounded-full" style={{ width: 240, height: 240, top: '10%', left: '8%', background: 'rgba(225,90,48,.16)' }} />
        <span className="absolute rounded-full" style={{ width: 140, height: 140, bottom: '16%', left: '22%', background: 'rgba(30,122,82,.18)' }} />
        <div className="relative z-10 px-14 text-center max-w-md">
          <div className="inline-flex mb-7" style={{ filter: 'drop-shadow(0 16px 40px rgba(225,90,48,.45))' }}>
            <BrandIcon size={92} radius={0.26} />
          </div>
          <div style={{ fontFamily: "'IBM Plex Sans', sans-serif" }} className="text-4xl font-bold tracking-tight">
            <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
          </div>
          <p className="text-[#C9BEAC] mt-4 text-[15px] leading-relaxed">{t('signup.heroLead')}</p>
          <div className="mt-9 space-y-3" style={{ textAlign: dir === 'rtl' ? 'right' : 'left' }}>
            {[t('signup.perk1'), t('signup.perk2'), t('signup.perk3'), t('signup.perk4')].map((tx, i) => (
              <div key={i} className="flex items-center gap-2.5 text-[#E8DFD2] text-sm">
                <CheckCircle2 size={18} className="text-[#5FBE92]" /> {tx}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* النموذج */}
      <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto relative">
        <div className="absolute top-4" style={{ insetInlineEnd: '16px' }}><LanguageToggle /></div>
        <div className="w-full max-w-md py-6">
          <div className="flex justify-center lg:hidden mb-5"><BrandIcon size={56} /></div>
          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-[#FBEBE2] text-[#C94E28] mb-4">
            <Sparkles size={13} /> {t('signup.badge')}
          </span>
          <h1 className="text-2xl font-bold text-[#1F1A13]">{t('signup.title')}</h1>
          <p className="text-[#6E6557] mt-1.5 text-sm">{t('signup.subtitle')}</p>

          <form onSubmit={submit} className="space-y-3.5 mt-6">
            <div>
              <label className="label">{t('signup.company')} *</label>
              <div className="relative">
                <Building2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                <input className="input pr-9" value={form.companyName} onChange={e => set('companyName', e.target.value)} placeholder="..." />
              </div>
            </div>
            <div>
              <label className="label">{t('signup.country')} *</label>
              <div className="relative">
                <Globe2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E] pointer-events-none" />
                <select
                  className={`input pr-9 ${form.country ? '' : 'text-[#9A8F7E]'}`}
                  value={form.country}
                  onChange={e => set('country', e.target.value)}
                  style={{ appearance: 'none' }}
                >
                  <option value="" disabled>{t('signup.countryPh')}</option>
                  {countries.map(c => (
                    <option key={c.code} value={c.code} className="text-[#1F1A13]">
                      {lang === 'ar' ? c.nameAr : c.nameEn} ({c.symbolEn} · {c.defaultVatPct}%)
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-[11px] text-[#9A8F7E] mt-1 leading-relaxed">{t('signup.countryHint')}</p>
            </div>
            <div>
              <label className="label">{t('signup.yourName')} *</label>
              <div className="relative">
                <User size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                <input className="input pr-9" value={form.adminName} onChange={e => set('adminName', e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label">{t('signup.email')} *</label>
              <div className="relative">
                <Mail size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                <input type="email" dir="ltr" className="input pr-9 text-right" value={form.email} onChange={e => set('email', e.target.value)} placeholder="you@company.com" autoComplete="username" />
              </div>
            </div>
            <div>
              <label className="label">{t('signup.phone')}</label>
              <div className="flex gap-2" dir="ltr">
                <select
                  aria-label={t('signup.country')}
                  className="input font-semibold text-sm"
                  style={{ width: 132, flex: '0 0 auto', paddingInline: '10px' }}
                  value={phoneCountry}
                  onChange={e => setPhoneCountry(e.target.value)}
                >
                  <optgroup label={lang === 'ar' ? 'الدول العربية' : lang === 'fr' ? 'Pays arabes' : 'Arab countries'}>
                    {ARAB_DIAL.map(c => (
                      <option key={c.code} value={c.code}>{flagOf(c.code)} {c.dial} {lang === 'ar' ? c.ar : c.en}</option>
                    ))}
                  </optgroup>
                  <optgroup label={lang === 'ar' ? 'دول أخرى' : lang === 'fr' ? 'Autres pays' : 'Other countries'}>
                    {WORLD_DIAL.map(c => (
                      <option key={c.code} value={c.code}>{flagOf(c.code)} {c.dial} {lang === 'ar' ? c.ar : c.en}</option>
                    ))}
                  </optgroup>
                </select>
                <div className="relative flex-1">
                  <Phone size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                  <input dir="ltr" className="input pl-9" value={form.phone} onChange={e => set('phone', e.target.value.replace(/[^0-9]/g, ''))} placeholder="5XXXXXXXX" />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{t('signup.password')} *</label>
                <div className="relative">
                  <Lock size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                  <input type={showPass ? 'text' : 'password'} dir="ltr" className="input pr-9 pl-9 text-right" value={form.password} onChange={e => set('password', e.target.value)} autoComplete="new-password" />
                  <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" onClick={() => setShowPass(s => !s)}>
                    {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div>
                <label className="label">{t('signup.confirm')} *</label>
                <div className="relative">
                  <Lock size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
                  <input type={showPass ? 'text' : 'password'} dir="ltr" className="input pr-9 text-right" value={form.confirm} onChange={e => set('confirm', e.target.value)} autoComplete="new-password" />
                </div>
              </div>
            </div>

            <label className="flex items-start gap-2 text-xs text-[#6E6557] cursor-pointer pt-1">
              <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#E15A30] shrink-0" checked={agree} onChange={e => setAgree(e.target.checked)} />
              <span>{t('signup.agreePre')} <Link to="/terms" className="text-[#E15A30] hover:underline">{t('signup.terms')}</Link> {t('signup.and')}<Link to="/privacy" className="text-[#E15A30] hover:underline">{t('signup.privacy')}</Link>.</span>
            </label>

            <button type="submit" disabled={loading}
              className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2">
              {loading ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : t('signup.submit')}
            </button>
          </form>

          <p className="text-center text-sm text-[#6E6557] mt-5">
            {t('signup.haveAccount')} <Link to="/login" className="text-[#E15A30] font-semibold hover:underline">{t('signup.signin')}</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
