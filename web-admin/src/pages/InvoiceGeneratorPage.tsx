import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, FileText, Download, Printer, MessageCircle, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';
import { buildZatcaQr, zatcaTimestamp } from '../rep/zatca';
import { elementToPdfBlob } from '../rep/pdf';

/**
 * مولّد الفاتورة الضريبية المجاني — أداة فيروسية (Engineering as Marketing):
 * التاجر يملأ بياناته وبنوده → فاتورة احترافية ثنائية اللغة برمز QR متوافق ZATCA → PDF/طباعة مجاناً.
 * كل فاتورة تحمل بصمة Field Sales وتصل لعملاء التاجر، والمستخدم يعود لكل فاتورة جديدة حتى يشترك.
 * كل شيء يعمل في المتصفح — لا خادم ولا تخزين (بيانات البائع تُحفظ محلياً للراحة فقط).
 */

type Lang = 'ar' | 'en' | 'fr';

interface Item { desc: string; qty: number; price: number }

// إعدادات ضريبة وعملة جاهزة لكل دولة (قابلة للتعديل يدوياً بعد الاختيار)
const COUNTRY_PRESETS: { code: string; ar: string; vat: number; cur: string }[] = [
  { code: 'SA', ar: 'السعودية', vat: 15, cur: '﷼' },
  { code: 'EG', ar: 'مصر', vat: 14, cur: 'ج.م' },
  { code: 'AE', ar: 'الإمارات', vat: 5, cur: 'د.إ' },
  { code: 'KW', ar: 'الكويت', vat: 0, cur: 'د.ك' },
  { code: 'QA', ar: 'قطر', vat: 0, cur: 'ر.ق' },
  { code: 'BH', ar: 'البحرين', vat: 10, cur: 'د.ب' },
  { code: 'OM', ar: 'عُمان', vat: 5, cur: 'ر.ع' },
  { code: 'JO', ar: 'الأردن', vat: 16, cur: 'د.أ' },
  { code: 'IQ', ar: 'العراق', vat: 0, cur: 'د.ع' },
  { code: 'MA', ar: 'المغرب', vat: 20, cur: 'د.م' },
  { code: 'DZ', ar: 'الجزائر', vat: 19, cur: 'د.ج' },
  { code: 'TN', ar: 'تونس', vat: 19, cur: 'د.ت' },
];

const T: Record<Lang, Record<string, string>> = {
  ar: {
    backLabel: 'تعرّف على Field Sales',
    title: 'مولّد الفاتورة الضريبية المجاني',
    subtitle: 'أنشئ فاتورة ضريبية احترافية برمز QR متوافق مع «فاتورة» ZATCA خلال 30 ثانية — وحمّلها PDF مجاناً بلا تسجيل.',
    seller: 'بيانات البائع (شركتك)',
    sellerName: 'اسم الشركة *',
    vatNumber: 'الرقم الضريبي (يظهر رمز QR عند تعبئته)',
    address: 'العنوان (اختياري)',
    buyer: 'بيانات العميل',
    buyerName: 'اسم العميل *',
    buyerVat: 'الرقم الضريبي للعميل (اختياري)',
    invoice: 'الفاتورة',
    invNo: 'رقم الفاتورة',
    invDate: 'التاريخ',
    country: 'الدولة (تضبط الضريبة والعملة)',
    vatRate: 'الضريبة %',
    currency: 'العملة',
    items: 'البنود',
    desc: 'الوصف',
    qty: 'الكمية',
    price: 'سعر الوحدة',
    addItem: 'إضافة بند',
    discount: 'الخصم (مبلغ)',
    download: 'تحميل PDF',
    print: 'طباعة',
    share: 'شارك الأداة واتساب',
    shareText: 'أداة مجانية تنشئ فاتورة ضريبية احترافية برمز QR (متوافق ZATCA) خلال ثوانٍ وتحمّلها PDF — بلا تسجيل:',
    ctaTitle: 'أتعبك إصدارها يدوياً لكل عميل؟',
    ctaBody: 'مع Field Sales يُصدرها مندوبك تلقائياً من جواله في الميدان: فاتورة برمز QR وطباعة حرارية وخصم فوري من المخزون.',
    cta: 'جرّب Field Sales مجاناً — 10 أيام بلا بطاقة',
    generating: 'جارٍ التوليد…',
    downloaded: 'تم تحميل الفاتورة PDF ✓',
    needFields: 'أدخل اسم الشركة واسم العميل وبنداً واحداً على الأقل',
    tryCalc: 'جرّب أيضاً: حاسبة تسريب الإيرادات — كم تخسر شهرياً؟',
  },
  en: {
    backLabel: 'Discover Field Sales',
    title: 'Free Tax Invoice Generator',
    subtitle: 'Create a professional tax invoice with a ZATCA-compliant QR code in 30 seconds — and download it as a PDF, free, no signup.',
    seller: 'Seller (your company)',
    sellerName: 'Company name *',
    vatNumber: 'VAT number (QR appears when filled)',
    address: 'Address (optional)',
    buyer: 'Customer',
    buyerName: 'Customer name *',
    buyerVat: 'Customer VAT number (optional)',
    invoice: 'Invoice',
    invNo: 'Invoice number',
    invDate: 'Date',
    country: 'Country (sets VAT & currency)',
    vatRate: 'VAT %',
    currency: 'Currency',
    items: 'Items',
    desc: 'Description',
    qty: 'Qty',
    price: 'Unit price',
    addItem: 'Add item',
    discount: 'Discount (amount)',
    download: 'Download PDF',
    print: 'Print',
    share: 'Share the tool on WhatsApp',
    shareText: 'A free tool that creates a professional tax invoice with a ZATCA-compliant QR code in seconds and downloads it as a PDF — no signup:',
    ctaTitle: 'Tired of issuing them manually for every customer?',
    ctaBody: 'With Field Sales your rep issues them automatically from their phone in the field: QR invoice, thermal printing, and instant stock deduction.',
    cta: 'Try Field Sales free — 10 days, no card',
    generating: 'Generating…',
    downloaded: 'Invoice PDF downloaded ✓',
    needFields: 'Enter company name, customer name and at least one item',
    tryCalc: 'Also try: the Revenue Leak Calculator — how much do you lose monthly?',
  },
  fr: {
    backLabel: 'Découvrir Field Sales',
    title: 'Générateur gratuit de factures fiscales',
    subtitle: 'Créez une facture fiscale professionnelle avec un code QR conforme ZATCA en 30 secondes — et téléchargez-la en PDF, gratuitement, sans inscription.',
    seller: 'Vendeur (votre entreprise)',
    sellerName: 'Nom de l’entreprise *',
    vatNumber: 'Numéro de TVA (le QR apparaît une fois rempli)',
    address: 'Adresse (optionnel)',
    buyer: 'Client',
    buyerName: 'Nom du client *',
    buyerVat: 'Numéro de TVA du client (optionnel)',
    invoice: 'Facture',
    invNo: 'Numéro de facture',
    invDate: 'Date',
    country: 'Pays (définit TVA et devise)',
    vatRate: 'TVA %',
    currency: 'Devise',
    items: 'Lignes',
    desc: 'Description',
    qty: 'Qté',
    price: 'Prix unitaire',
    addItem: 'Ajouter une ligne',
    discount: 'Remise (montant)',
    download: 'Télécharger le PDF',
    print: 'Imprimer',
    share: 'Partager l’outil sur WhatsApp',
    shareText: 'Un outil gratuit qui crée une facture fiscale professionnelle avec code QR conforme ZATCA en quelques secondes et la télécharge en PDF — sans inscription :',
    ctaTitle: 'Fatigué de les émettre manuellement pour chaque client ?',
    ctaBody: 'Avec Field Sales, votre commercial les émet automatiquement depuis son téléphone : facture QR, impression thermique et stock déduit instantanément.',
    cta: 'Essayez Field Sales gratuitement — 10 jours, sans carte',
    generating: 'Génération…',
    downloaded: 'PDF téléchargé ✓',
    needFields: 'Entrez le nom de l’entreprise, du client et au moins une ligne',
    tryCalc: 'Essayez aussi : le calculateur de fuite de revenus',
  },
};

const SEO = {
  ar: {
    title: 'مولّد فاتورة ضريبية مجاني برمز QR — نموذج فاتورة ضريبية جاهز | FieldSales',
    description: 'أنشئ فاتورة ضريبية احترافية مجاناً برمز QR متوافق مع هيئة الزكاة والضريبة (ZATCA) وحمّلها PDF خلال ثوانٍ — نموذج فاتورة ضريبية ومبسطة بلا تسجيل.',
    keywords: 'نموذج فاتورة ضريبية, مولد فاتورة ضريبية, فاتورة ضريبية مبسطة, فاتورة QR, فاتورة ZATCA, انشاء فاتورة مجانا, فاتورة الكترونية',
    locale: 'ar' as const,
  },
  en: {
    title: 'Free Tax Invoice Generator with QR Code — Ready Invoice Template | FieldSales',
    description: 'Create a professional tax invoice free with a ZATCA-compliant QR code and download it as PDF in seconds — standard & simplified invoice templates, no signup.',
    keywords: 'free invoice generator, tax invoice template, ZATCA QR invoice, e-invoice generator, simplified tax invoice',
    locale: 'en' as const,
  },
  fr: {
    title: 'Générateur gratuit de factures fiscales avec code QR | FieldSales',
    description: 'Créez gratuitement une facture fiscale professionnelle avec code QR conforme ZATCA et téléchargez-la en PDF en quelques secondes — sans inscription.',
    keywords: 'générateur de factures gratuit, modèle facture fiscale, facture QR ZATCA, facture électronique',
    locale: 'fr' as const,
  },
};

const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

// بيانات البائع تُحفظ محلياً (راحة العائدين — الأداة تُستخدم مع كل فاتورة جديدة)
const LS_KEY = 'fs_invgen_seller';

export default function InvoiceGeneratorPage() {
  const lang = useLang((s) => s.lang) as Lang;
  const dir = useDir();
  const t = (k: string) => (T[lang] || T.ar)[k] || T.ar[k];

  const home = pathForLocale('/', lang);
  const seoUrl = seoUrls('/invoice-generator', lang);
  useSeo({ ...SEO[lang], canonical: seoUrl.canonical, alternates: seoUrl.alternates, image: 'https://fieldsa.net/og-image.png' });

  const saved = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Record<string, string>; } catch { return {}; }
  }, []);

  const [sellerName, setSellerName] = useState(saved.sellerName || '');
  const [vatNumber, setVatNumber] = useState(saved.vatNumber || '');
  const [address, setAddress] = useState(saved.address || '');
  const [buyerName, setBuyerName] = useState('');
  const [buyerVat, setBuyerVat] = useState('');
  const [invNo, setInvNo] = useState('INV-0001');
  const [invDate, setInvDate] = useState(today());
  const [country, setCountry] = useState('SA');
  const [vatRate, setVatRate] = useState(15);
  const [cur, setCur] = useState('﷼');
  const [discount, setDiscount] = useState(0);
  const [items, setItems] = useState<Item[]>([{ desc: '', qty: 1, price: 0 }]);
  const [qrUrl, setQrUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const docRef = useRef<HTMLDivElement>(null);

  // حفظ بيانات البائع محلياً
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ sellerName, vatNumber, address })); } catch { /* تجاهل */ }
  }, [sellerName, vatNumber, address]);

  const applyCountry = (code: string) => {
    setCountry(code);
    const p = COUNTRY_PRESETS.find((c) => c.code === code);
    if (p) { setVatRate(p.vat); setCur(p.cur); }
  };

  const totals = useMemo(() => {
    const subtotal = items.reduce((s, it) => s + (it.qty || 0) * (it.price || 0), 0);
    const disc = Math.min(discount || 0, subtotal);
    const taxable = subtotal - disc;
    const vat = taxable * (vatRate / 100);
    return { subtotal, disc, taxable, vat, total: taxable + vat };
  }, [items, discount, vatRate]);

  // نوع الفاتورة وفق ZATCA: مبسطة (B2C) أو ضريبية (B2B برقم ضريبي للعميل)
  const isSimplified = !buyerVat.trim();

  // رمز QR بصيغة TLV (يُرسم كصورة PNG لا canvas — درس html2canvas)
  useEffect(() => {
    const vn = vatNumber.trim();
    if (!vn || !sellerName.trim() || totals.total <= 0) { setQrUrl(''); return; }
    const payload = buildZatcaQr({
      sellerName: sellerName.trim(),
      vatNumber: vn,
      timestamp: zatcaTimestamp(invDate),
      total: totals.total,
      vatTotal: totals.vat,
    });
    QRCode.toDataURL(payload, { width: 220, margin: 1 }).then(setQrUrl).catch(() => setQrUrl(''));
  }, [sellerName, vatNumber, invDate, totals.total, totals.vat]);

  const validItems = items.filter((it) => it.desc.trim() && it.qty > 0);
  const ready = sellerName.trim() && buyerName.trim() && validItems.length > 0 && totals.total > 0;

  const downloadPdf = async () => {
    if (!ready || !docRef.current) { toast.error(t('needFields')); return; }
    setBusy(true);
    try {
      const blob = await elementToPdfBlob(docRef.current);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${invNo || 'invoice'}.pdf`; a.click();
      URL.revokeObjectURL(url);
      toast.success(t('downloaded'));
    } catch {
      toast.error('PDF error');
    } finally {
      setBusy(false);
    }
  };

  const printDoc = () => {
    if (!ready) { toast.error(t('needFields')); return; }
    window.print();
  };

  const shareUrl = 'https://fieldsa.net/invoice-generator?utm_source=whatsapp&utm_medium=share&utm_campaign=invoice_generator';
  const waHref = `https://wa.me/?text=${encodeURIComponent(`🧾 ${t('shareText')}\n${shareUrl}`)}`;

  const setItem = (i: number, patch: Partial<Item>) => setItems((arr) => arr.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  const invTitle = isSimplified ? 'فاتورة ضريبية مبسطة · Simplified Tax Invoice' : 'فاتورة ضريبية · Tax Invoice';

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      {/* عند الطباعة تظهر الفاتورة وحدها */}
      <style>{`@media print { body * { visibility: hidden; } #inv-doc, #inv-doc * { visibility: visible; } #inv-doc { position: absolute; top: 0; right: 0; left: 0; margin: 0; box-shadow: none !important; } }`}</style>

      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur print:hidden">
        <div className="max-w-6xl mx-auto px-3 sm:px-5 h-16 flex items-center justify-between gap-2">
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

      <main className="max-w-6xl mx-auto px-4 sm:px-5 py-8 sm:py-12">
        <div className="text-center mb-9 print:hidden">
          <div className="w-16 h-16 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4">
            <FileText size={30} className="text-[#E15A30]" />
          </div>
          <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight">{t('title')}</h1>
          <p className="text-[#6E6557] mt-3 max-w-2xl mx-auto leading-relaxed">{t('subtitle')}</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6 items-start">
          {/* ------------------------- النموذج ------------------------- */}
          <div className="space-y-4 print:hidden">
            <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-3">
              <p className="text-sm font-bold">{t('seller')}</p>
              <input className="input" placeholder={t('sellerName')} value={sellerName} onChange={(e) => setSellerName(e.target.value)} />
              <div className="grid grid-cols-2 gap-3">
                <input className="input" dir="ltr" placeholder={t('vatNumber')} value={vatNumber} onChange={(e) => setVatNumber(e.target.value.replace(/[^\d]/g, ''))} />
                <input className="input" placeholder={t('address')} value={address} onChange={(e) => setAddress(e.target.value)} />
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-3">
              <p className="text-sm font-bold">{t('buyer')}</p>
              <div className="grid grid-cols-2 gap-3">
                <input className="input" placeholder={t('buyerName')} value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
                <input className="input" dir="ltr" placeholder={t('buyerVat')} value={buyerVat} onChange={(e) => setBuyerVat(e.target.value.replace(/[^\d]/g, ''))} />
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-3">
              <p className="text-sm font-bold">{t('invoice')}</p>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">{t('invNo')}</label><input className="input" dir="ltr" value={invNo} onChange={(e) => setInvNo(e.target.value)} /></div>
                <div><label className="label">{t('invDate')}</label><input type="date" className="input" dir="ltr" value={invDate} onChange={(e) => setInvDate(e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">{t('country')}</label>
                  <select className="input" value={country} onChange={(e) => applyCountry(e.target.value)}>
                    {COUNTRY_PRESETS.map((c) => <option key={c.code} value={c.code}>{c.ar}</option>)}
                  </select>
                </div>
                <div><label className="label">{t('vatRate')}</label><input type="number" min={0} max={30} className="input text-center" value={vatRate} onChange={(e) => setVatRate(Math.max(0, Math.min(30, Number(e.target.value) || 0)))} /></div>
                <div><label className="label">{t('currency')}</label><input className="input text-center" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-2.5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">{t('items')}</p>
                <button onClick={() => setItems((a) => [...a, { desc: '', qty: 1, price: 0 }])} className="text-xs font-bold text-[#E15A30] hover:underline flex items-center gap-1"><Plus size={14} /> {t('addItem')}</button>
              </div>
              {items.map((it, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input className="input flex-1" placeholder={t('desc')} value={it.desc} onChange={(e) => setItem(i, { desc: e.target.value })} />
                  <input type="number" min={0} className="input w-16 sm:w-20 text-center" placeholder={t('qty')} value={it.qty || ''} onChange={(e) => setItem(i, { qty: Number(e.target.value) || 0 })} />
                  <input type="number" min={0} className="input w-20 sm:w-28 text-center" placeholder={t('price')} value={it.price || ''} onChange={(e) => setItem(i, { price: Number(e.target.value) || 0 })} />
                  {items.length > 1 && <button onClick={() => setItems((a) => a.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500 shrink-0"><Trash2 size={16} /></button>}
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <label className="label mb-0 whitespace-nowrap">{t('discount')}</label>
                <input type="number" min={0} className="input w-28 text-center" value={discount || ''} onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))} />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <button onClick={downloadPdf} disabled={busy}
                className="flex-1 bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors">
                <Download size={17} /> {busy ? t('generating') : t('download')}
              </button>
              <button onClick={printDoc}
                className="px-6 py-3.5 rounded-xl border border-[#E9E1D3] bg-white text-sm font-bold text-[#6E6557] hover:border-[#E8C9BC] flex items-center justify-center gap-2 transition-colors">
                <Printer size={16} /> {t('print')}
              </button>
            </div>

            <a href={waHref} target="_blank" rel="noreferrer"
              className="bg-[#25D366] hover:bg-[#1eb356] text-white font-bold py-3 rounded-xl text-center text-sm transition-colors flex items-center justify-center gap-2">
              <MessageCircle size={17} /> {t('share')}
            </a>

            {/* جسر التحويل: من أداة يدوية إلى النظام الكامل */}
            <div className="bg-[#1F1A13] rounded-2xl p-5 text-center relative overflow-hidden">
              <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full" style={{ background: 'radial-gradient(circle, rgba(225,90,48,.3), transparent 65%)' }} />
              <p className="relative text-white font-bold">{t('ctaTitle')}</p>
              <p className="relative text-[#B7AD9D] text-xs mt-1.5 leading-relaxed">{t('ctaBody')}</p>
              <a href="/signup?utm_source=invoice_generator&utm_medium=tool&utm_campaign=viral"
                className="relative inline-block bg-[#E15A30] hover:bg-[#C94E28] text-white text-sm font-bold px-6 py-2.5 rounded-xl mt-3 transition-colors">
                {t('cta')}
              </a>
            </div>

            <Link to={pathForLocale('/calculator', lang)} className="block text-center text-xs font-semibold text-[#E15A30] hover:underline">
              {t('tryCalc')} ↗
            </Link>
          </div>

          {/* ------------------------- معاينة الفاتورة (وثيقة ثنائية اللغة) ------------------------- */}
          <div className="overflow-x-auto">
            <div id="inv-doc" ref={docRef} dir="rtl"
              className="bg-white mx-auto shadow-sm border border-[#E9E1D3] rounded-lg"
              style={{ width: 620, minWidth: 620, padding: '34px 38px', fontFamily: "'IBM Plex Sans Arabic', 'Segoe UI', sans-serif", color: '#1F1A13' }}>
              {/* الترويسة */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '3px solid #E15A30', paddingBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{sellerName || '— اسم شركتك —'}</div>
                  {address && <div style={{ fontSize: 12, color: '#6E6557', marginTop: 3 }}>{address}</div>}
                  {vatNumber && <div style={{ fontSize: 12, color: '#6E6557', marginTop: 2 }} dir="ltr">VAT: {vatNumber}</div>}
                </div>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#E15A30' }}>{invTitle}</div>
                  <div style={{ fontSize: 12.5, color: '#6E6557', marginTop: 5 }} dir="ltr">{invNo}</div>
                  <div style={{ fontSize: 12.5, color: '#6E6557' }} dir="ltr">{invDate}</div>
                </div>
              </div>

              {/* العميل */}
              <div style={{ margin: '14px 0 4px', fontSize: 13 }}>
                <span style={{ color: '#9A8F7E' }}>العميل · Customer: </span>
                <b>{buyerName || '— اسم العميل —'}</b>
                {buyerVat && <span style={{ color: '#6E6557' }} dir="ltr"> · VAT: {buyerVat}</span>}
              </div>

              {/* البنود */}
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#FAF7F0' }}>
                    <th style={{ textAlign: 'right', padding: '9px 10px', borderBottom: '2px solid #E9E1D3' }}>الوصف · Description</th>
                    <th style={{ textAlign: 'center', padding: '9px 10px', borderBottom: '2px solid #E9E1D3', width: 64 }}>الكمية<br />Qty</th>
                    <th style={{ textAlign: 'center', padding: '9px 10px', borderBottom: '2px solid #E9E1D3', width: 92 }}>السعر<br />Price</th>
                    <th style={{ textAlign: 'center', padding: '9px 10px', borderBottom: '2px solid #E9E1D3', width: 100 }}>الإجمالي<br />Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(validItems.length ? validItems : [{ desc: '—', qty: 0, price: 0 }]).map((it, i) => (
                    <tr key={i}>
                      <td style={{ padding: '8px 10px', borderBottom: '1px solid #F1EBDF' }}>{it.desc}</td>
                      <td style={{ padding: '8px 10px', borderBottom: '1px solid #F1EBDF', textAlign: 'center' }} dir="ltr">{it.qty}</td>
                      <td style={{ padding: '8px 10px', borderBottom: '1px solid #F1EBDF', textAlign: 'center' }} dir="ltr">{fmt(it.price)}</td>
                      <td style={{ padding: '8px 10px', borderBottom: '1px solid #F1EBDF', textAlign: 'center', fontWeight: 600 }} dir="ltr">{fmt(it.qty * it.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* المجاميع + QR */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 18, gap: 16 }}>
                <div style={{ width: 150 }}>
                  {qrUrl ? (
                    <div style={{ display: 'block', width: 130 }}>
                      <img src={qrUrl} alt="ZATCA QR" width={130} height={130} style={{ display: 'block', border: '1px solid #E9E1D3', borderRadius: 8 }} />
                      <div style={{ fontSize: 9.5, color: '#9A8F7E', marginTop: 4, textAlign: 'center' }}>رمز الفاتورة الضريبية · ZATCA QR</div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 10.5, color: '#c3bcae', maxWidth: 150, lineHeight: 1.7 }}>أدخل الرقم الضريبي ليظهر رمز QR المتوافق مع ZATCA</div>
                  )}
                </div>
                <div style={{ width: 260, fontSize: 13.5 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}><span style={{ color: '#6E6557' }}>المجموع · Subtotal</span><span dir="ltr">{fmt(totals.subtotal)} {cur}</span></div>
                  {totals.disc > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', color: '#DC2626' }}><span>الخصم · Discount</span><span dir="ltr">- {fmt(totals.disc)} {cur}</span></div>}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', color: '#1E7A52' }}><span>الضريبة {vatRate}% · VAT</span><span dir="ltr">{fmt(totals.vat)} {cur}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', marginTop: 6, borderTop: '2px solid #E15A30', fontWeight: 800, fontSize: 16.5, color: '#E15A30' }}>
                    <span>الإجمالي · Total</span><span dir="ltr">{fmt(totals.total)} {cur}</span>
                  </div>
                </div>
              </div>

              {/* التذييل + البصمة الفيروسية */}
              <div style={{ marginTop: 30, paddingTop: 12, borderTop: '1px solid #F1EBDF', textAlign: 'center', fontSize: 11.5, color: '#9A8F7E' }}>
                شكراً لتعاملكم معنا · Thank you for your business
                <div style={{ marginTop: 5, fontSize: 9.5, color: '#c3bcae' }}>
                  أُنشئت مجاناً عبر منصّة Field Sales · fieldsa.net/invoice-generator
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E] print:hidden">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
