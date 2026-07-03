import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, TrendingDown, MessageCircle, Link2, FileWarning, Banknote, PackageX, Timer } from 'lucide-react';
import toast from 'react-hot-toast';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';

/**
 * حاسبة تسريب الإيرادات — أداة فيروسية مجانية (Engineering as Marketing):
 * صاحب شركة التوزيع يُدخل أرقامه → يرى كم يخسر شهرياً بالإدارة الورقية → يشاركها واتساب.
 * النسب تحفّظية مبنية على متوسطات قطاع التوزيع (أخطاء فوترة، تحصيل غير موثّق، عجز مخزون، وقت ضائع).
 */

type Lang = 'ar' | 'en' | 'fr';

const T: Record<Lang, Record<string, string>> = {
  ar: {
    backLabel: 'تعرّف على Field Sales',
    title: 'حاسبة تسريب الإيرادات',
    subtitle: 'كم تخسر شركتك شهرياً بإدارة المناديب على الورق والواتساب؟ أدخل أرقامك وشاهد الحقيقة.',
    reps: 'عدد المناديب',
    invPerDay: 'متوسط فواتير المندوب يومياً',
    avgInvoice: 'متوسط قيمة الفاتورة',
    workDays: 'أيام العمل شهرياً',
    cashPct: 'نسبة البيع النقدي والتحصيل الميداني',
    method: 'كيف تُدار مبيعاتك اليوم؟',
    methodPaper: 'ورق ودفاتر',
    methodWhatsapp: 'واتساب + إكسل',
    methodOld: 'نظام قديم لا يغطي الميدان',
    currency: 'العملة',
    revenueLabel: 'مبيعاتك الشهرية التقديرية',
    leakTitle: 'تسريبك الشهري المُقدَّر',
    leakYear: 'أي ما يقارب {y} سنوياً 😱',
    b1: 'فواتير مفقودة وأخطاء تسعير',
    b2: 'تحصيل نقدي غير موثّق ومتأخر',
    b3: 'عجز وفروقات مخزون السيارات',
    b4: 'وقت مناديب ضائع في الإدخال اليدوي',
    note: 'نسب تحفّظية من متوسطات قطاع التوزيع — الواقع غالباً أعلى.',
    cta: 'أوقف التسريب — جرّب Field Sales مجاناً',
    ctaSub: '10 أيام مجاناً · بلا بطاقة ائتمان · جاهز خلال دقائق',
    share: 'شارك النتيجة واتساب',
    copy: 'نسخ رابط الحاسبة',
    copied: 'نُسخ الرابط ✓',
    shareText: '😱 حسبت تسريب الإيرادات في شركة التوزيع: نظام الورق والواتساب قد يكلّف {m} شهرياً ({y} سنوياً)!\nاحسب تسريبك مجاناً هنا:',
    disclaimer: 'الحاسبة تقديرية للتوعية ولا تُعد وعداً بنتائج. النسب: 1.2% أخطاء فوترة، 2.5% من النقدي تحصيل غير موثّق، 1% عجز مخزون، 1.5% وقت ضائع — تنخفض بحسب طريقة إدارتك الحالية.',
  },
  en: {
    backLabel: 'Discover Field Sales',
    title: 'Revenue Leak Calculator',
    subtitle: 'How much does your distribution company lose every month running reps on paper and WhatsApp? Enter your numbers and see the truth.',
    reps: 'Number of field reps',
    invPerDay: 'Invoices per rep per day',
    avgInvoice: 'Average invoice value',
    workDays: 'Working days per month',
    cashPct: 'Cash sales & field collection share',
    method: 'How do you run sales today?',
    methodPaper: 'Paper & notebooks',
    methodWhatsapp: 'WhatsApp + Excel',
    methodOld: 'Legacy system (no field coverage)',
    currency: 'Currency',
    revenueLabel: 'Estimated monthly sales',
    leakTitle: 'Your estimated monthly leak',
    leakYear: 'That is roughly {y} per year 😱',
    b1: 'Lost invoices & pricing errors',
    b2: 'Undocumented & late cash collections',
    b3: 'Van stock shrinkage & discrepancies',
    b4: 'Rep time wasted on manual entry',
    note: 'Conservative rates from distribution-industry averages — reality is usually higher.',
    cta: 'Stop the leak — try Field Sales free',
    ctaSub: '10 days free · no credit card · ready in minutes',
    share: 'Share result on WhatsApp',
    copy: 'Copy calculator link',
    copied: 'Link copied ✓',
    shareText: '😱 I calculated our distribution revenue leak: paper & WhatsApp management may cost {m} per month ({y}/year)!\nCalculate yours free here:',
    disclaimer: 'This calculator is an educational estimate, not a promise of results. Rates: 1.2% invoicing errors, 2.5% of cash undocumented, 1% stock shrinkage, 1.5% wasted time — reduced based on your current method.',
  },
  fr: {
    backLabel: 'Découvrir Field Sales',
    title: 'Calculateur de fuite de revenus',
    subtitle: 'Combien votre entreprise de distribution perd-elle chaque mois avec le papier et WhatsApp ? Entrez vos chiffres et voyez la vérité.',
    reps: 'Nombre de commerciaux terrain',
    invPerDay: 'Factures par commercial par jour',
    avgInvoice: 'Valeur moyenne d’une facture',
    workDays: 'Jours ouvrés par mois',
    cashPct: 'Part des ventes en espèces / encaissement terrain',
    method: 'Comment gérez-vous vos ventes aujourd’hui ?',
    methodPaper: 'Papier et carnets',
    methodWhatsapp: 'WhatsApp + Excel',
    methodOld: 'Ancien système (sans le terrain)',
    currency: 'Devise',
    revenueLabel: 'Ventes mensuelles estimées',
    leakTitle: 'Votre fuite mensuelle estimée',
    leakYear: 'Soit environ {y} par an 😱',
    b1: 'Factures perdues et erreurs de prix',
    b2: 'Encaissements non documentés et tardifs',
    b3: 'Écarts de stock des véhicules',
    b4: 'Temps perdu en saisie manuelle',
    note: 'Taux prudents issus des moyennes du secteur de la distribution — la réalité est souvent supérieure.',
    cta: 'Stoppez la fuite — essayez Field Sales gratuitement',
    ctaSub: '10 jours gratuits · sans carte bancaire · prêt en quelques minutes',
    share: 'Partager sur WhatsApp',
    copy: 'Copier le lien',
    copied: 'Lien copié ✓',
    shareText: '😱 J’ai calculé la fuite de revenus de notre distribution : le papier et WhatsApp peuvent coûter {m} par mois ({y}/an) !\nCalculez la vôtre gratuitement ici :',
    disclaimer: 'Ce calculateur est une estimation éducative, pas une promesse de résultats. Taux : 1,2 % erreurs de facturation, 2,5 % des espèces non documentées, 1 % écarts de stock, 1,5 % temps perdu — réduits selon votre méthode actuelle.',
  },
};

const CURRENCIES = ['﷼', 'ج.م', 'د.إ', 'د.ك', 'ر.ق', 'د.ب', 'ر.ع', 'د.أ', 'د.ع', 'د.م', 'د.ج', 'د.ت', 'ل.ل', '$'];

// معامل الطريقة الحالية: الورق يسرّب أكثر، والنظام القديم أقل
const METHOD_FACTOR: Record<string, number> = { paper: 1, whatsapp: 0.8, old: 0.5 };

const SEO = {
  ar: {
    title: 'حاسبة تسريب الإيرادات لشركات التوزيع — كم تخسر شهرياً؟ | FieldSales',
    description: 'أداة مجانية: احسب كم تخسر شركة التوزيع شهرياً من فواتير مفقودة وتحصيل غير موثّق وعجز مخزون سيارات المناديب — وأوقف التسريب.',
    keywords: 'حاسبة خسائر التوزيع, تسريب الإيرادات, إدارة مناديب المبيعات, التحصيل الميداني, عجز مخزون السيارة, نظام مبيعات ميدانية',
    locale: 'ar' as const,
  },
  en: {
    title: 'Revenue Leak Calculator for Distributors — How Much Do You Lose Monthly? | FieldSales',
    description: 'Free tool: calculate how much your distribution company loses each month to lost invoices, undocumented cash collections and van stock shrinkage — and stop the leak.',
    keywords: 'distribution revenue leak calculator, field sales losses, van sales shrinkage, cash collection, sales rep management',
    locale: 'en' as const,
  },
  fr: {
    title: 'Calculateur de fuite de revenus pour distributeurs | FieldSales',
    description: 'Outil gratuit : calculez combien votre entreprise de distribution perd chaque mois (factures perdues, encaissements non documentés, écarts de stock) — et stoppez la fuite.',
    keywords: 'calculateur pertes distribution, fuite de revenus, vente terrain, encaissement, gestion commerciaux',
    locale: 'fr' as const,
  },
};

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export default function LeakCalculatorPage() {
  const lang = useLang((s) => s.lang) as Lang;
  const dir = useDir();
  const t = (k: string) => (T[lang] || T.ar)[k] || T.ar[k];

  const home = pathForLocale('/', lang);
  const seoUrl = seoUrls('/calculator', lang);
  useSeo({ ...SEO[lang], canonical: seoUrl.canonical, alternates: seoUrl.alternates, image: 'https://fieldsa.net/og-image.png' });

  const [reps, setReps] = useState(5);
  const [invPerDay, setInvPerDay] = useState(15);
  const [avgInvoice, setAvgInvoice] = useState(400);
  const [workDays, setWorkDays] = useState(26);
  const [cashPct, setCashPct] = useState(60);
  const [method, setMethod] = useState('paper');
  const [cur, setCur] = useState('﷼');

  const r = useMemo(() => {
    const revenue = reps * invPerDay * avgInvoice * workDays;
    const m = METHOD_FACTOR[method] ?? 1;
    const b1 = revenue * 0.012 * m;                       // فواتير مفقودة وأخطاء تسعير
    const b2 = revenue * 0.025 * (cashPct / 100) * m;     // تحصيل نقدي غير موثّق
    const b3 = revenue * 0.01 * m;                        // عجز مخزون السيارة
    const b4 = revenue * 0.015 * m;                       // وقت ضائع
    const total = b1 + b2 + b3 + b4;
    return { revenue, b1, b2, b3, b4, total, yearly: total * 12 };
  }, [reps, invPerDay, avgInvoice, workDays, cashPct, method]);

  const shareUrl = 'https://fieldsa.net/calculator?utm_source=whatsapp&utm_medium=share&utm_campaign=leak_calculator';
  const shareText = t('shareText').replace('{m}', `${fmt(r.total)} ${cur}`).replace('{y}', `${fmt(r.yearly)} ${cur}`);
  const waHref = `https://wa.me/?text=${encodeURIComponent(`${shareText}\n${shareUrl}`)}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success(t('copied'));
    } catch {
      toast.error(shareUrl);
    }
  };

  const bars = [
    { icon: FileWarning, label: t('b1'), value: r.b1 },
    { icon: Banknote, label: t('b2'), value: r.b2 },
    { icon: PackageX, label: t('b3'), value: r.b3 },
    { icon: Timer, label: t('b4'), value: r.b4 },
  ];
  const maxBar = Math.max(...bars.map((b) => b.value), 1);

  const num = (v: number, set: (n: number) => void, min: number, max: number) => (
    <input type="number" min={min} max={max} value={v} dir="ltr"
      onChange={(e) => set(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
      className="input text-center font-bold" />
  );

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-5xl mx-auto px-3 sm:px-5 h-16 flex items-center justify-between gap-2">
          <Link to={home} className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }} className="text-lg sm:text-xl hidden min-[400px]:inline">
              <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            <LanguageToggle />
            <Link to={home}
              className="text-xs sm:text-sm font-bold text-white bg-[#E15A30] hover:bg-[#C94E28] rounded-full px-3 sm:px-4 py-2 flex items-center gap-1.5 transition-colors whitespace-nowrap">
              {t('backLabel')}
              <ArrowLeft size={14} className={dir === 'rtl' ? '' : 'rotate-180'} />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-5 py-8 sm:py-12">
        <div className="text-center mb-9">
          <div className="w-16 h-16 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4">
            <TrendingDown size={30} className="text-[#E15A30]" />
          </div>
          <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight">{t('title')}</h1>
          <p className="text-[#6E6557] mt-3 max-w-2xl mx-auto leading-relaxed">{t('subtitle')}</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6 items-start">
          {/* المدخلات */}
          <div className="bg-white rounded-2xl border border-[#E9E1D3] p-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">{t('reps')}</label>{num(reps, setReps, 1, 500)}</div>
              <div><label className="label">{t('invPerDay')}</label>{num(invPerDay, setInvPerDay, 1, 200)}</div>
              <div><label className="label">{t('avgInvoice')}</label>{num(avgInvoice, setAvgInvoice, 10, 1000000)}</div>
              <div><label className="label">{t('workDays')}</label>{num(workDays, setWorkDays, 1, 31)}</div>
            </div>
            <div>
              <label className="label">{t('cashPct')} — <b className="text-[#E15A30]">{cashPct}%</b></label>
              <input type="range" min={0} max={100} step={5} value={cashPct} onChange={(e) => setCashPct(Number(e.target.value))} className="w-full accent-[#E15A30]" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{t('method')}</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)} className="input">
                  <option value="paper">{t('methodPaper')}</option>
                  <option value="whatsapp">{t('methodWhatsapp')}</option>
                  <option value="old">{t('methodOld')}</option>
                </select>
              </div>
              <div>
                <label className="label">{t('currency')}</label>
                <select value={cur} onChange={(e) => setCur(e.target.value)} className="input">
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <p className="text-xs text-[#9A8F7E]">{t('revenueLabel')}: <b dir="ltr">{fmt(r.revenue)}</b> {cur}</p>
          </div>

          {/* النتيجة */}
          <div className="space-y-4">
            <div className="bg-[#1F1A13] text-white rounded-2xl p-7 text-center relative overflow-hidden">
              <div className="absolute -top-16 -left-16 w-52 h-52 rounded-full" style={{ background: 'radial-gradient(circle, rgba(225,90,48,.25), transparent 65%)' }} />
              <p className="text-sm text-slate-300 relative">{t('leakTitle')}</p>
              <p className="text-4xl sm:text-5xl font-extrabold mt-2 text-[#E15A30] relative" dir="ltr">{fmt(r.total)} <span className="text-xl sm:text-2xl">{cur}</span></p>
              <p className="text-sm text-slate-300 mt-2 relative">{t('leakYear').replace('{y}', `${fmt(r.yearly)} ${cur}`)}</p>
            </div>

            <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-3">
              {bars.map((b, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="flex items-center gap-1.5 text-[#3a342b]"><b.icon size={15} className="text-[#E15A30]" /> {b.label}</span>
                    <b dir="ltr">{fmt(b.value)} {cur}</b>
                  </div>
                  <div className="h-2 bg-[#F1EBDF] rounded-full overflow-hidden">
                    <div className="h-full bg-[#E15A30] rounded-full transition-all" style={{ width: `${(b.value / maxBar) * 100}%` }} />
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-[#9A8F7E] pt-1">{t('note')}</p>
            </div>

            <a href={`/signup?utm_source=leak_calculator&utm_medium=tool&utm_campaign=viral`}
              className="block bg-[#E15A30] hover:bg-[#C94E28] text-white font-bold py-4 rounded-xl text-center transition-colors">
              {t('cta')}
              <span className="block text-xs font-normal opacity-85 mt-1">{t('ctaSub')}</span>
            </a>

            <div className="flex flex-col sm:flex-row gap-2">
              <a href={waHref} target="_blank" rel="noreferrer"
                className="flex-1 bg-[#25D366] hover:bg-[#1eb356] text-white font-bold py-3 rounded-xl text-center text-sm transition-colors flex items-center justify-center gap-2">
                <MessageCircle size={17} /> {t('share')}
              </a>
              <button onClick={copyLink}
                className="px-4 py-3 rounded-xl border border-[#E9E1D3] bg-white text-sm text-[#6E6557] hover:border-[#E8C9BC] flex items-center justify-center gap-1.5 transition-colors">
                <Link2 size={15} /> {t('copy')}
              </button>
            </div>
          </div>
        </div>

        <p className="text-[11px] text-[#9A8F7E] text-center mt-10 max-w-3xl mx-auto leading-relaxed">{t('disclaimer')}</p>
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
