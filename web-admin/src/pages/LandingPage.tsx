import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { LANDING_TEMPLATE } from '../landing/landingTemplate';
import { defaultContent } from '../landing/defaultContent';
import { defaultContentEn } from '../landing/defaultContentEn';
import { useLang } from '../i18n/lang';
import { seoUrls } from '../i18n/locale';
import { useSeo } from '../lib/seo';

// مسارات أيقونات منصّات التواصل (SVG glyph واحد لكل منصّة)
const SOCIAL_ICONS: Record<string, string> = {
  whatsapp: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z',
  x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  instagram: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z',
  linkedin: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  snapchat: 'M12.206 0c.749 0 3.077.196 4.198 2.706.378.846.286 2.286.214 3.44l-.003.04c-.007.12-.015.236-.02.35.057.03.16.064.32.064.24-.008.534-.08.86-.214a.99.99 0 01.4-.084c.16 0 .32.03.46.084.394.14.65.464.66.84.007.48-.46.89-1.395 1.26-.103.04-.227.077-.367.117-.475.137-1.19.345-1.39.807-.103.243-.06.55.13.91l.006.013c.063.146 1.54 3.566 4.84 4.106.262.043.45.275.438.538a.595.595 0 01-.043.193c-.218.508-1.146.876-2.85 1.13-.054.08-.11.395-.152.61-.04.193-.08.397-.14.61-.064.235-.213.35-.44.35h-.025c-.105 0-.254-.018-.442-.06-.345-.075-.795-.15-1.357-.15-.323 0-.66.027-1.005.077-.66.097-1.232.51-1.894.99-.943.685-2.013 1.46-3.65 1.46-.07 0-.14-.003-.207-.008-.082.005-.165.008-.247.008-1.636 0-2.705-.775-3.65-1.46-.66-.48-1.232-.892-1.894-.99-.345-.05-.682-.077-1.005-.077-.562 0-1.012.077-1.357.15-.188.042-.337.06-.442.06a.45.45 0 01-.465-.35c-.06-.213-.1-.42-.14-.61-.042-.215-.097-.53-.152-.61-1.704-.254-2.632-.622-2.85-1.13a.595.595 0 01-.043-.193.535.535 0 01.438-.538c3.3-.54 4.777-3.96 4.84-4.106l.006-.013c.19-.36.233-.667.13-.91-.2-.462-.915-.67-1.39-.807-.14-.04-.264-.077-.367-.117-.935-.37-1.402-.78-1.395-1.26.01-.376.266-.7.66-.84.14-.054.3-.084.46-.084.13 0 .268.022.4.084.326.134.62.206.86.214.16 0 .263-.034.32-.064-.005-.114-.013-.23-.02-.35l-.003-.04c-.072-1.154-.164-2.594.214-3.44C9.13.196 11.458 0 12.206 0z',
  youtube: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  facebook: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
  tiktok: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
};

// يبني صف أيقونات التواصل بحجم قابل للضبط (الروابط الفارغة تُخفى)
function socialIcons(social: Record<string, string> = {}, size = 38): string {
  const r = Math.round(size * 0.29);
  const ic = Math.round(size * 0.48);
  return Object.entries(SOCIAL_ICONS)
    .filter(([k]) => social[k] && String(social[k]).trim())
    .map(([k, path]) => {
      let url = String(social[k]).trim();
      if (k === 'whatsapp') url = `https://wa.me/${url.replace(/[^0-9]/g, '')}`;
      else if (!/^https?:\/\//.test(url)) url = `https://${url}`;
      return `<a href="${url}" target="_blank" rel="noreferrer" aria-label="${k}" style="width:${size}px;height:${size}px;border-radius:${r}px;background:#2C261D;display:inline-flex;align-items:center;justify-content:center;transition:background .2s,transform .2s" onmouseover="this.style.background='#E15A30';this.style.transform='translateY(-3px)'" onmouseout="this.style.background='#2C261D';this.style.transform='none'"><svg width="${ic}" height="${ic}" viewBox="0 0 24 24" fill="#FAF7F0"><path d="${path}"></path></svg></a>`;
    })
    .join('');
}

// أيقونات التذييل الصغيرة
function renderSocial(social: Record<string, string> = {}): string {
  const items = socialIcons(social, 38);
  return items ? `<div style="display:flex;gap:9px;flex-wrap:wrap">${items}</div>` : '';
}

// القسم البارز «تابعنا على مواقع التواصل» (يظهر فقط عند وجود رابط واحد على الأقل)
function renderSocialSection(social: Record<string, string> = {}, lang: 'ar' | 'en' = 'ar'): string {
  const items = socialIcons(social, 50);
  if (!items) return '';
  const heading = lang === 'en' ? 'Follow us on social media' : 'تابِعنا على مواقع التواصل';
  return `<section style="max-width:1200px; margin:0 auto; padding:6px 28px 64px; text-align:center;">
    <div style="font-family:'IBM Plex Sans',sans-serif; font-size:12px; letter-spacing:2.5px; text-transform:uppercase; color:#E15A30; font-weight:600;">FOLLOW US</div>
    <h2 style="font-size:30px; line-height:1.2; font-weight:700; letter-spacing:-0.5px; margin-top:10px;">${heading}</h2>
    <div style="display:flex; gap:13px; justify-content:center; flex-wrap:wrap; margin-top:24px;">${items}</div>
  </section>`;
}

// يملأ القالب بقيم المحتوى عبر العناصر النائبة {{path}}، ويعالج أقسام التواصل
export function applyContent(template: string, content: Record<string, unknown>, lang: 'ar' | 'en' = 'ar'): string {
  const social = content.social as Record<string, string>;
  let html = template.split('{{__SOCIAL_SECTION__}}').join(renderSocialSection(social, lang));
  html = html.split('{{__SOCIAL__}}').join(renderSocial(social));
  html = html.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const val = path.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), content);
    return val == null ? '' : String(val);
  });
  return html;
}

// ترجمة النص الثابت داخل القالب (تنقّل، بطاقات العرض، تسميات الباقات، التذييل) إلى الإنجليزية
const CHROME_EN: [string, string][] = [
  ['dir="rtl"', 'dir="ltr"'],
  // التنقّل
  ['>المميزات<', '>Features<'], ['>كيف يعمل<', '>How it works<'], ['>الأسعار<', '>Pricing<'],
  ['>الأسئلة<', '>FAQ<'], ['>دخول الأدمن<', '>Admin login<'], ['>تطبيق المندوب<', '>Rep app<'],
  ['ابدأ مجانًا', 'Get started free'],
  // بطاقات العرض في القسم الرئيسي
  ['المبيعات والتحصيل', 'Sales & collection'], ['٧ أيام', '7 days'], ['محصّل اليوم', 'Collected today'],
  ['+12.4% عن أمس', '+12.4% vs. yesterday'], ['>سند قبض<', '>Receipt<'], ['>المبلغ<', '>Amount<'],
  ['>الحالة<', '>Status<'], ['تم الإرسال', 'Sent'], ['طلب #10428 قيد التنفيذ', 'Order #10428 in progress'],
  ['٩٢٬٧٠٠', '92,700'], ['٨٠٠٫٠٠ ر.س', 'SAR 800.00'],
  // الأسعار (نص ثابت)
  [' ر.س / شهريًا', ' SAR / mo'],
  ['إدارة الطلبات والتحصيل', 'Order & collection management'],
  ['فواتير ضريبية وسندات قبض', 'Tax invoices & receipts'],
  ['تطبيق جوال للمناديب', 'Mobile app for reps'],
  ['تقارير أساسية', 'Basic reports'],
  ['>ابدأ الآن<', '>Get started<'],
  ['كل مميزات الباقة', 'Everything in'], ['على الخريطة', 'on the map'],
  ['تقارير وكشوف حساب متقدمة', 'Advanced reports & statements'],
  ['دعم أولوية', 'Priority support'],
  ['كل مميزات', 'Everything in'],
  ['تكامل ERP ومحاسبة', 'ERP & accounting integration'],
  ['مدير حساب مخصّص', 'Dedicated account manager'],
  ['تدريب وإعداد كامل', 'Full training & onboarding'],
  ['تواصل مع المبيعات', 'Contact sales'],
  // التذييل
  ['>المنتج<', '>Product<'], ['تطبيق الجوال', 'Mobile app'],
  ['>الشركة<', '>Company<'], ['>من نحن<', '>About us<'], ['>تواصل معنا<', '>Contact us<'],
  ['>قانوني<', '>Legal<'], ['>سياسة الخصوصية<', '>Privacy Policy<'],
  ['>الشروط والأحكام<', '>Terms & Conditions<'], ['>اتفاقية الخدمة<', '>Service Agreement<'],
  ['© ٢٠٢٦ Field Sales — جميع الحقوق محفوظة.', '© 2026 Field Sales — All rights reserved.'],
];

function translateChrome(html: string): string {
  let out = html;
  for (const [ar, en] of CHROME_EN) out = out.split(ar).join(en);
  return out;
}

// زر تبديل اللغة المحقون في شريط التنقّل (HTML خام يستدعي دالة عامّة)
function langButton(label: string): string {
  return `<button onclick="window.__fsToggleLang&&window.__fsToggleLang()" aria-label="Toggle language" style="display:inline-flex; align-items:center; gap:6px; font-size:14px; font-weight:600; color:#1F1A13; background:#fff; border:1.5px solid #DED5C4; padding:8px 13px; border-radius:11px; cursor:pointer; font-family:inherit;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.5" stroke="#1F1A13" stroke-width="1.7"></circle><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" stroke="#1F1A13" stroke-width="1.5"></path></svg>${label}</button>`;
}

// يحقن زر اللغة قبل أزرار الدخول في شريط التنقّل
function injectLangButton(html: string, label: string): string {
  return html.replace(
    '<div style="margin-right:auto; display:flex; align-items:center; gap:12px;">',
    `<div style="margin-right:auto; display:flex; align-items:center; gap:12px;">${langButton(label)}`
  );
}

function mergeContent<T>(base: T, saved: unknown): T {
  if (Array.isArray(base)) {
    const savedArray = Array.isArray(saved) ? saved : [];
    return base.map((item, index) => mergeContent(item, savedArray[index])) as T;
  }

  if (base && typeof base === 'object') {
    const savedObj = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
    const out: Record<string, unknown> = { ...savedObj };
    for (const [key, value] of Object.entries(base as Record<string, unknown>)) {
      out[key] = mergeContent(value, savedObj[key]);
    }
    return out as T;
  }

  return (saved == null || saved === '') ? base : saved as T;
}

// صفحة الهبوط التعريفية التسويقية — تصميم Field Sales، محتواها يُدار من لوحة المالك (CMS)
export default function LandingPage() {
  const lang = useLang((s) => s.lang);
  const navigate = useNavigate();
  const { canonical, alternates } = seoUrls('/', lang);

  const { data } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const res = await siteContentApi.get(); return res.data.data as unknown; },
    staleTime: 60_000,
  });
  // sameAs لمحرّكات البحث — يُبنى من روابط التواصل في الـCMS (يربط العلامة بحساباتك الاجتماعية)
  const social = (data as { social?: Record<string, string> } | null | undefined)?.social || {};
  const sameAs = [social.x, social.instagram, social.linkedin, social.facebook, social.youtube, social.tiktok, social.snapchat,
    social.whatsapp ? `https://wa.me/${String(social.whatsapp).replace(/[^0-9]/g, '')}` : '']
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const orgJsonLd = sameAs.length
    ? { '@context': 'https://schema.org', '@type': 'Organization', '@id': 'https://fieldsa.net/#organization', url: 'https://fieldsa.net/', sameAs }
    : undefined;

  // SEO الصفحة الرئيسية — كلمات مفتاحية لكل خدمة + canonical/hreflang حسب اللغة (دولي)
  useSeo(lang === 'en' ? {
    title: 'FieldSales | Field Sales & Distribution Management System',
    description: 'FieldSales is a complete platform to manage field distribution reps: ZATCA e-invoices, collection, van stock, GPS tracking and reports. Free 10-day trial.',
    keywords: 'field sales system, sales rep management software, distribution management software, route accounting, ZATCA e-invoicing, tax invoice, payment collection, accounts receivable, van sales, van stock management, GPS rep tracking, customer management, product catalog, ERP integration',
    locale: 'en', canonical, alternates,
    image: 'https://fieldsa.net/og-image.png',
    jsonLd: orgJsonLd,
  } : {
    title: 'FieldSales فيلد سيلز | نظام مبيعات المناديب والتوزيع',
    description: 'فيلد سيلز نظام عربي لإدارة مبيعات مناديب التوزيع في السعودية ومصر والمغرب العربي: فواتير ضريبية، تحصيل وإدارة الذمم، سندات قبض، مخزون السيارة، وتتبّع المناديب GPS. جرّبه مجاناً.',
    keywords: 'نظام مبيعات ميدانية, إدارة مناديب التوزيع, نظام توزيع, برنامج توزيع, فواتير ضريبية, ZATCA, الفوترة الإلكترونية, فاتورة ضريبية مبسطة, تحصيل المدفوعات, إدارة الذمم المدينة, سندات قبض, مخزون سيارة المندوب, البيع المتنقل van sales, تتبع المناديب GPS, إدارة العملاء وحدود الائتمان, كتالوج المنتجات والأسعار, تكامل ERP, نظام مبيعات للأسواق العربية, نظام مبيعات مصر, نظام توزيع المغرب, برنامج مناديب الجزائر وتونس وليبيا, نظام مبيعات السعودية, فيلد سيلز',
    locale: 'ar', canonical, alternates,
    image: 'https://fieldsa.net/og-image.png',
    jsonLd: orgJsonLd,
  });

  // زر تبديل اللغة المحقون في شريط التنقّل ينتقل بين / و/en (روابط منفصلة للفهرسة)
  useEffect(() => {
    (window as unknown as { __fsToggleLang?: () => void }).__fsToggleLang = () => navigate(lang === 'ar' ? '/en' : '/');
  }, [lang, navigate]);

  // محتوى CMS المحفوظ قد يكون قديماً (عدد ميزاته لا يطابق الكود الحالي) — حينها نتجاهله
  // ونستخدم المحتوى الافتراضي الحالي حتى لا تُعرَض ميزات/نصوص قديمة. وإلا ندمج تحرير المالك.
  const savedItems = (data as { features?: { items?: unknown[] } } | null | undefined)?.features?.items;
  const cmsCurrent = Array.isArray(savedItems) && savedItems.length === defaultContent.features.items.length;
  const arContent = (cmsCurrent ? mergeContent(defaultContent, data) : defaultContent) as Record<string, unknown>;

  let html: string;
  if (lang === 'en') {
    // النسخة الإنجليزية: محتوى إنجليزي ثابت + روابط تواصل من CMS + ترجمة النص الثابت
    const enContent = { ...defaultContentEn, social: (arContent.social as Record<string, string>) || defaultContentEn.social };
    html = translateChrome(applyContent(LANDING_TEMPLATE, enContent as Record<string, unknown>, 'en'));
    html = injectLangButton(html, 'العربية');
  } else {
    html = applyContent(LANDING_TEMPLATE, arContent, 'ar');
    html = injectLangButton(html, 'English');
  }

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
