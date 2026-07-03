import { useState } from 'react';
import { Link } from 'react-router-dom';
import { contactApi } from '../api/client';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Building2, Send, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';

// صفحة «تسجيل طلب اشتراك جديد» — تصل بيانات الشركة للإدارة بريدياً (زر «اطلب اشتراكك الآن» بالرئيسية)
export default function SubscriptionRequestPage() {
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  // نصوص الصفحة ثلاثية اللغة (ذاتية الاحتواء كنمط صفحات المدوّنة)
  const tr = (ar: string, en: string, fr: string) => (lang === 'en' ? en : lang === 'fr' ? fr : ar);

  const home = pathForLocale('/', lang);
  const seoUrl = seoUrls('/subscribe-request', lang);
  useSeo({
    title: tr('تسجيل طلب اشتراك جديد | FieldSales', 'New Subscription Request | FieldSales', 'Nouvelle demande d’abonnement | FieldSales'),
    description: tr(
      'سجّل طلب اشتراك شركتك في منصّة FieldSales لإدارة المبيعات الميدانية والتوزيع — يصلنا طلبك فوراً ونتواصل معك.',
      'Register your company’s subscription request for the FieldSales field sales platform — we receive it instantly and get back to you.',
      'Enregistrez la demande d’abonnement de votre entreprise à la plateforme FieldSales — nous la recevons instantanément et vous recontactons.'
    ),
    keywords: tr('طلب اشتراك, تسجيل شركة, نظام مبيعات ميدانية', 'subscription request, register company, field sales system', 'demande d’abonnement, inscription entreprise, ventes terrain'),
    canonical: seoUrl.canonical, alternates: seoUrl.alternates,
    image: 'https://fieldsa.net/og-image.png', locale: lang,
  });

  const [form, setForm] = useState({ companyName: '', contactName: '', email: '', phone: '', country: '', city: '', repsCount: '', notes: '' });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.companyName.trim()) { toast.error(tr('اسم الشركة مطلوب', 'Company name is required', 'Le nom de l’entreprise est requis')); return; }
    if (!form.contactName.trim()) { toast.error(tr('اسم المسؤول مطلوب', 'Contact name is required', 'Le nom du responsable est requis')); return; }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(form.email)) { toast.error(tr('البريد الإلكتروني غير صحيح', 'Invalid email address', 'E-mail invalide')); return; }
    if (form.phone.trim().length < 5) { toast.error(tr('رقم الجوال مطلوب', 'Phone number is required', 'Le numéro de téléphone est requis')); return; }
    if (!form.country.trim()) { toast.error(tr('الدولة مطلوبة', 'Country is required', 'Le pays est requis')); return; }
    setSending(true);
    try {
      await contactApi.subscription({
        companyName: form.companyName.trim(), contactName: form.contactName.trim(),
        email: form.email.trim(), phone: form.phone.trim(), country: form.country.trim(),
        city: form.city.trim() || undefined, repsCount: form.repsCount.trim() || undefined, notes: form.notes.trim() || undefined,
      });
      setSent(true);
      toast.success(tr('استلمنا طلبك بنجاح', 'Request received successfully', 'Demande reçue avec succès'));
    } catch {
      toast.error(tr('تعذّر إرسال الطلب — حاول مجدداً أو راسلنا على info@fieldsa.net', 'Could not send — try again or email info@fieldsa.net', 'Échec de l’envoi — réessayez ou écrivez à info@fieldsa.net'));
    } finally {
      setSending(false);
    }
  };

  const ltrInput = dir === 'rtl' ? 'input text-right' : 'input text-left';

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-5xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to={home} className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }} className="text-xl">
              <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Link to={home} className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
              {tr('العودة للرئيسية', 'Back to home', 'Retour à l’accueil')} <ArrowLeft size={15} className={dir === 'rtl' ? '' : 'rotate-180'} />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-14">
        <div className="text-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4">
            <Building2 size={30} className="text-[#E15A30]" />
          </div>
          <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight">{tr('تسجيل طلب اشتراك جديد', 'New Subscription Request', 'Nouvelle demande d’abonnement')}</h1>
          <p className="text-[#6E6557] mt-3 max-w-xl mx-auto leading-relaxed">
            {tr('عبّئ بيانات شركتك وسيصل طلبك لإدارة FieldSales فوراً — نتواصل معك لتفعيل الاشتراك وتجهيز حسابك.',
              'Fill in your company details and your request reaches the FieldSales team instantly — we’ll contact you to activate the subscription and set up your account.',
              'Renseignez les informations de votre entreprise : votre demande parvient instantanément à l’équipe FieldSales, qui vous contactera pour activer l’abonnement.')}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-[#E9E1D3] p-6 lg:p-8">
          {sent ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 rounded-2xl bg-green-100 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 size={32} className="text-green-600" />
              </div>
              <h3 className="text-xl font-bold text-[#1F1A13]">{tr('استلمنا طلبك بنجاح ✅', 'We received your request ✅', 'Nous avons bien reçu votre demande ✅')}</h3>
              <p className="text-sm text-[#6E6557] mt-2 leading-relaxed">
                {tr('سيتواصل معك فريقنا خلال يوم عمل على بريدك أو جوالك لتفعيل اشتراك شركتك.',
                  'Our team will contact you within one business day by email or phone to activate your company subscription.',
                  'Notre équipe vous contactera sous un jour ouvré par e-mail ou téléphone pour activer votre abonnement.')}
              </p>
              <Link to={home} className="btn-primary mx-auto mt-6 inline-flex">{tr('العودة للرئيسية', 'Back to home', 'Retour à l’accueil')}</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label">{tr('اسم الشركة', 'Company name', 'Nom de l’entreprise')} *</label>
                <input className="input" value={form.companyName} onChange={e => set('companyName', e.target.value)} placeholder={tr('مثال: شركة النخبة للتوزيع', 'e.g. Elite Distribution Co.', 'ex. Société Elite Distribution')} />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">{tr('اسم المسؤول', 'Contact person', 'Responsable')} *</label>
                  <input className="input" value={form.contactName} onChange={e => set('contactName', e.target.value)} />
                </div>
                <div>
                  <label className="label">{tr('رقم الجوال', 'Phone', 'Téléphone')} *</label>
                  <input dir="ltr" className={ltrInput} value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+9665XXXXXXXX" />
                </div>
              </div>
              <div>
                <label className="label">{tr('البريد الإلكتروني', 'Email', 'E-mail')} *</label>
                <input type="email" dir="ltr" className={ltrInput} value={form.email} onChange={e => set('email', e.target.value)} placeholder="you@company.com" />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">{tr('الدولة', 'Country', 'Pays')} *</label>
                  <input className="input" value={form.country} onChange={e => set('country', e.target.value)} placeholder={tr('مثال: السعودية', 'e.g. Saudi Arabia', 'ex. Maroc')} />
                </div>
                <div>
                  <label className="label">{tr('المدينة', 'City', 'Ville')}</label>
                  <input className="input" value={form.city} onChange={e => set('city', e.target.value)} />
                </div>
              </div>
              <div>
                <label className="label">{tr('عدد المناديب المتوقع', 'Expected number of reps', 'Nombre de commerciaux prévu')}</label>
                <input className="input" value={form.repsCount} onChange={e => set('repsCount', e.target.value)} placeholder={tr('مثال: 5', 'e.g. 5', 'ex. 5')} />
              </div>
              <div>
                <label className="label">{tr('ملاحظات إضافية', 'Additional notes', 'Remarques')}</label>
                <textarea className="input" rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder={tr('أخبرنا عن نشاط شركتك أو أي متطلبات خاصة…', 'Tell us about your business or any special requirements…', 'Parlez-nous de votre activité ou de besoins particuliers…')} />
              </div>
              <button type="submit" disabled={sending}
                className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2">
                {sending ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send size={17} />}
                {tr('إرسال طلب الاشتراك', 'Send subscription request', 'Envoyer la demande')}
              </button>
              <p className="text-[11px] text-[#9A8F7E] text-center leading-relaxed">
                {tr('أو ابدأ فوراً بنفسك عبر', 'Or start right away with the', 'Ou commencez immédiatement avec l’')}{' '}
                <Link to="/signup" className="text-[#E15A30] font-semibold hover:underline">{tr('التجربة المجانية 10 أيام', 'free 10-day trial', 'essai gratuit de 10 jours')}</Link>
              </p>
            </form>
          )}
        </div>
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
