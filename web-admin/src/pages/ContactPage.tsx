import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi, contactApi } from '../api/client';
import { defaultContent } from '../landing/defaultContent';
import { defaultContentEn } from '../landing/defaultContentEn';
import { defaultContentFr } from '../landing/defaultContentFr';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Mail, Phone, MapPin, MessageCircle, LifeBuoy, Send, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useT } from '../i18n/strings';
import { useSeo } from '../lib/seo';
import { seoUrls } from '../i18n/locale';

// صفحة التواصل مع الشركة — بياناتها من CMS + نموذج يرسل رسالة لبريد الشركة
export default function ContactPage() {
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  const t = useT();
  const { data } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const r = await siteContentApi.get(); return r.data.data as unknown; },
    staleTime: 60_000,
  });
  const content = (data || defaultContent) as typeof defaultContent;
  const cms = content.contact || defaultContent.contact;
  // المقدمة بلغة الواجهة (إنجليزي/فرنسي من محتواها)، وبيانات التواصل (بريد/هاتف) من CMS دائماً
  const c = lang === 'en' ? { ...cms, intro: defaultContentEn.contact.intro }
    : lang === 'fr' ? { ...cms, intro: defaultContentFr.contact.intro }
    : cms;

  const seoUrl = seoUrls('/contact', lang);
  const contactSeo = {
    ar: {
      title: 'تواصل معنا | FieldSales — اطلب عرضاً أو تجربة مجانية لنظام المبيعات الميدانية',
      description: 'تواصل مع فريق FieldSales لطلب عرض توضيحي أو تجربة مجانية لنظام إدارة مبيعات المناديب والتوزيع: فواتير ZATCA، تحصيل المدفوعات، مخزون سيارة المندوب، وتتبّع المناديب.',
      keywords: 'تواصل معنا, طلب عرض توضيحي, تجربة مجانية, دعم FieldSales, نظام مبيعات ميدانية, إدارة مناديب التوزيع',
      locale: 'ar' as const,
    },
    en: {
      title: 'Contact Us | FieldSales — Request a Demo or Free Trial',
      description: 'Contact the FieldSales team to request a demo or free trial of the field sales & distribution management system: ZATCA invoices, payment collection, van stock and GPS rep tracking.',
      keywords: 'contact FieldSales, request a demo, free trial, support, field sales system, sales rep management',
      locale: 'en' as const,
    },
    fr: {
      title: 'Contact | FieldSales — Demandez une démo ou un essai gratuit',
      description: 'Contactez l’équipe FieldSales pour demander une démo ou un essai gratuit du système de gestion des ventes terrain et de la distribution : factures fiscales, encaissement, stock du véhicule et suivi GPS.',
      keywords: 'contact FieldSales, demander une démo, essai gratuit, support, système de vente terrain, gestion des commerciaux',
      locale: 'fr' as const,
    },
  }[lang];
  useSeo({ ...contactSeo, canonical: seoUrl.canonical, alternates: seoUrl.alternates, image: 'https://fieldsa.net/og-image.png' });

  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '' });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error(t('contact.errName')); return; }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(form.email)) { toast.error(t('contact.errEmail')); return; }
    if (!form.message.trim()) { toast.error(t('contact.errMsg')); return; }
    setSending(true);
    try {
      await contactApi.send({ name: form.name.trim(), email: form.email.trim(), phone: form.phone || undefined, message: form.message.trim() });
      setSent(true);
      toast.success(t('contact.successToast'));
    } catch {
      toast.error(t('contact.failToast'));
    } finally {
      setSending(false);
    }
  };

  const cards = [
    c.email && { icon: Mail, label: t('contact.cardEmail'), value: c.email, href: `mailto:${c.email}` },
    c.phone && { icon: Phone, label: t('contact.cardPhone'), value: c.phone, href: `tel:${c.phone}` },
    c.whatsapp && { icon: MessageCircle, label: t('contact.cardWhatsapp'), value: c.whatsapp, href: `https://wa.me/${String(c.whatsapp).replace(/[^0-9]/g, '')}` },
    c.address && { icon: MapPin, label: t('contact.cardAddress'), value: c.address, href: undefined },
  ].filter(Boolean) as { icon: React.ElementType; label: string; value: string; href?: string }[];

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-5xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }} className="text-xl">
              <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Link to="/" className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
              {t('common.backHome')} <ArrowLeft size={15} className={dir === 'rtl' ? '' : 'rotate-180'} />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-5 py-14">
        <div className="text-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4">
            <LifeBuoy size={30} className="text-[#E15A30]" />
          </div>
          <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight">{t('contact.title')}</h1>
          <p className="text-[#6E6557] mt-3 max-w-xl mx-auto leading-relaxed">{c.intro}</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6 items-start">
          {/* بطاقات التواصل */}
          <div className="space-y-3">
            {cards.map((card, i) => {
              const inner = (
                <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 flex items-center gap-4 hover:border-[#E8C9BC] transition-colors">
                  <div className="w-12 h-12 rounded-xl bg-[#FBEBE2] flex items-center justify-center shrink-0">
                    <card.icon size={22} className="text-[#E15A30]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-[#9A8F7E] mb-0.5">{card.label}</p>
                    <p className="font-semibold text-[#1F1A13] truncate" dir="ltr" style={{ textAlign: dir === 'rtl' ? 'right' : 'left' }}>{card.value}</p>
                  </div>
                </div>
              );
              return card.href
                ? <a key={i} href={card.href} target={card.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className="block">{inner}</a>
                : <div key={i}>{inner}</div>;
            })}
          </div>

          {/* نموذج التواصل */}
          <div className="bg-white rounded-2xl border border-[#E9E1D3] p-6 lg:p-7">
            {sent ? (
              <div className="text-center py-10">
                <div className="w-14 h-14 rounded-2xl bg-green-100 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 size={28} className="text-green-600" />
                </div>
                <h3 className="text-lg font-bold text-[#1F1A13]">{t('contact.sentTitle')}</h3>
                <p className="text-sm text-[#6E6557] mt-2">{t('contact.sentBody')}</p>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-3.5">
                <h3 className="font-bold text-[#1F1A13] mb-1">{t('contact.formTitle')}</h3>
                <div>
                  <label className="label">{t('contact.name')} *</label>
                  <input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder={t('contact.namePh')} />
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label">{t('contact.email')} *</label>
                    <input type="email" dir="ltr" className={dir === 'rtl' ? 'input text-right' : 'input text-left'} value={form.email} onChange={e => set('email', e.target.value)} placeholder="you@email.com" />
                  </div>
                  <div>
                    <label className="label">{t('contact.phone')}</label>
                    <input dir="ltr" className={dir === 'rtl' ? 'input text-right' : 'input text-left'} value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+9665XXXXXXXX" />
                  </div>
                </div>
                <div>
                  <label className="label">{t('contact.message')} *</label>
                  <textarea className="input" rows={4} value={form.message} onChange={e => set('message', e.target.value)} placeholder={t('contact.messagePh')} />
                </div>
                <button type="submit" disabled={sending}
                  className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
                  {sending ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send size={17} />}
                  {t('contact.send')}
                </button>
              </form>
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
