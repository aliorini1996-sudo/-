import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { LANDING_TEMPLATE } from '../landing/landingTemplate';
import { defaultContent } from '../landing/defaultContent';
import { defaultContentEn } from '../landing/defaultContentEn';
import { defaultContentFr } from '../landing/defaultContentFr';
import { useLang, type Lang } from '../i18n/lang';
import { useCurrency, type Currency } from '../i18n/currency';
import { seoUrls, pathForLocale } from '../i18n/locale';
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
function renderSocialSection(social: Record<string, string> = {}, lang: Lang = 'ar'): string {
  const items = socialIcons(social, 50);
  if (!items) return '';
  const heading = lang === 'en' ? 'Follow us on social media'
    : lang === 'fr' ? 'Suivez-nous sur les réseaux sociaux'
    : 'تابِعنا على مواقع التواصل';
  return `<section style="max-width:1200px; margin:0 auto; padding:6px 28px 64px; text-align:center;">
    <div style="font-family:'IBM Plex Sans',sans-serif; font-size:12px; letter-spacing:2.5px; text-transform:uppercase; color:#E15A30; font-weight:600;">FOLLOW US</div>
    <h2 style="font-size:30px; line-height:1.2; font-weight:700; letter-spacing:-0.5px; margin-top:10px;">${heading}</h2>
    <div style="display:flex; gap:13px; justify-content:center; flex-wrap:wrap; margin-top:24px;">${items}</div>
  </section>`;
}

// قسم بارز لحاسبة تسريب الإيرادات — منتصف الصفحة، أيقونة كبيرة عائمة بتوهّج نابض (يُحقن قبل الأسعار)
function renderCalculatorSection(lang: Lang = 'ar'): string {
  const t = {
    ar: {
      eyebrow: 'أداة مجانية · احسبها بنفسك',
      h: 'كم تخسر شركتك من إيراداتها كل شهر؟',
      p: 'حاسبة تسريب الإيرادات تكشف لك خلال دقيقة ما يضيع بين الفواتير المفقودة والتحصيل غير الموثّق وعجز مخزون سيارات المناديب — أدخل أرقامك وشاهد الحقيقة.',
      cta: 'احسب تسريبك الآن',
      tool2Title: 'مولّد الفاتورة الضريبية المجاني',
      cta2: 'أنشئ فاتورة ضريبية برمز QR مجاناً خلال 30 ثانية',
      note: 'مجانية 100% · بلا تسجيل · شارك نتيجتك واتساب',
    },
    en: {
      eyebrow: 'Free tool · See for yourself',
      h: 'How much revenue does your company leak every month?',
      p: 'The Revenue Leak Calculator shows you in one minute what slips away in lost invoices, undocumented collections and van stock shrinkage — enter your numbers and see the truth.',
      cta: 'Calculate your leak now',
      tool2Title: 'Free Tax Invoice Generator',
      cta2: 'Create a free QR tax invoice in 30 seconds',
      note: '100% free · no signup · share your result on WhatsApp',
    },
    fr: {
      eyebrow: 'Outil gratuit · Voyez par vous-même',
      h: 'Combien de revenus votre entreprise perd-elle chaque mois ?',
      p: 'Le calculateur de fuite de revenus vous montre en une minute ce qui disparaît entre factures perdues, encaissements non documentés et écarts de stock — entrez vos chiffres et voyez la vérité.',
      cta: 'Calculez votre fuite',
      tool2Title: 'Générateur gratuit de factures fiscales',
      cta2: 'Créez gratuitement une facture fiscale QR en 30 secondes',
      note: '100 % gratuit · sans inscription · partagez sur WhatsApp',
    },
  }[lang];
  const arrow = lang === 'ar'
    ? '<path d="M19 12H5m0 0l6-6m-6 6l6 6"/>'
    : '<path d="M5 12h14m0 0l-6-6m6 6l-6 6"/>';
  return `<section id="leak-calculator" style="max-width:1200px; margin:0 auto; padding:34px 28px 70px;">
    <style>
      @keyframes fsCalcFloat { 0%,100%{ transform:translateY(0) rotate(-3deg);} 50%{ transform:translateY(-12px) rotate(3deg);} }
      @keyframes fsCalcGlow { 0%,100%{ box-shadow:0 18px 46px rgba(225,90,48,.45);} 50%{ box-shadow:0 26px 72px rgba(225,90,48,.8);} }
      @keyframes fsCalcRing { 0%{ transform:scale(1); opacity:.55;} 100%{ transform:scale(1.65); opacity:0;} }
      @keyframes fsInvFloat { 0%,100%{ transform:translateY(0) rotate(2.5deg);} 50%{ transform:translateY(-8px) rotate(-2.5deg);} }
      @keyframes fsInvGlow { 0%,100%{ box-shadow:0 12px 32px rgba(30,122,82,.45);} 50%{ box-shadow:0 18px 50px rgba(30,122,82,.8);} }
      #leak-calculator .fs-calc-cta:hover { background:#C94E28 !important; transform:translateY(-2px); }
      #leak-calculator .fs-inv-link:hover .fs-inv-title { color:#7ED9A9 !important; }
    </style>
    <div style="position:relative; overflow:hidden; background:#1F1A13; border-radius:30px; padding:64px 28px 58px; text-align:center;">
      <div style="position:absolute; top:-160px; right:-120px; width:480px; height:480px; border-radius:50%; background:radial-gradient(circle, rgba(225,90,48,.28), transparent 65%);"></div>
      <div style="position:absolute; bottom:-160px; left:-120px; width:440px; height:440px; border-radius:50%; background:radial-gradient(circle, rgba(30,122,82,.2), transparent 65%);"></div>
      <div style="position:relative; display:inline-block; margin-bottom:26px;">
        <span style="position:absolute; inset:0; border-radius:34px; border:2px solid #E15A30; animation:fsCalcRing 2.2s ease-out infinite;"></span>
        <span style="width:116px; height:116px; border-radius:34px; background:linear-gradient(145deg,#E15A30,#C94E28); display:inline-flex; align-items:center; justify-content:center; animation:fsCalcFloat 3.6s ease-in-out infinite, fsCalcGlow 3.6s ease-in-out infinite;">
          <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#FAF7F0" stroke-width="1.7" stroke-linecap="round">
            <rect x="4.5" y="2.5" width="15" height="19" rx="2.5"></rect>
            <path d="M8 6.5h8"></path>
            <path d="M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 14.5h.01M12 14.5h.01M15.5 14.5h.01M8.5 18h.01M12 18h.01M15.5 18h.01" stroke-width="2.6"></path>
          </svg>
        </span>
      </div>
      <div style="position:relative; font-family:'IBM Plex Sans',sans-serif; font-size:12.5px; letter-spacing:2.5px; text-transform:uppercase; color:#E15A30; font-weight:700;">${t.eyebrow}</div>
      <h2 style="position:relative; color:#FAF7F0; font-size:clamp(26px,4.6vw,42px); line-height:1.25; font-weight:800; letter-spacing:-0.8px; margin:14px auto 0; max-width:760px;">${t.h}</h2>
      <p style="position:relative; color:#B7AD9D; font-size:clamp(15px,2.2vw,17.5px); line-height:1.9; margin:16px auto 0; max-width:640px;">${t.p}</p>
      <a href="/calculator" class="fs-calc-cta" style="position:relative; display:inline-flex; align-items:center; gap:10px; background:#E15A30; color:#fff; font-weight:800; font-size:clamp(16px,2.4vw,19px); padding:17px 42px; border-radius:16px; text-decoration:none; margin-top:30px; transition:background .2s, transform .2s;">
        ${t.cta}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${arrow}</svg>
      </a>
      <div style="position:relative; color:#9A8F7E; font-size:13px; margin-top:16px;">${t.note}</div>
      <!-- الأداة الثانية: مولّد الفواتير — أيقونة عائمة مميزة أصغر من أيقونة الحاسبة (80px مقابل 116px) بتدرّج أخضر -->
      <div style="position:relative; margin-top:38px; padding-top:30px; border-top:1px solid rgba(250,247,240,.12);">
        <a href="/invoice-generator" class="fs-inv-link" style="display:inline-block; text-decoration:none;">
          <span style="display:inline-flex; width:80px; height:80px; border-radius:24px; background:linear-gradient(145deg,#1E7A52,#155C3D); align-items:center; justify-content:center; animation:fsInvFloat 4.2s ease-in-out infinite, fsInvGlow 4.2s ease-in-out infinite;">
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#FAF7F0" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"></path>
              <path d="M9 7h6M9 11h6"></path>
              <rect x="9" y="14" width="3.2" height="3.2" rx="0.6" stroke-width="1.5"></rect>
            </svg>
          </span>
          <span class="fs-inv-title" style="display:block; color:#FAF7F0; font-size:clamp(16px,2.4vw,19px); font-weight:800; margin-top:14px; transition:color .2s;">${t.tool2Title}</span>
          <span style="display:block; color:#B7AD9D; font-size:clamp(13px,1.9vw,14.5px); margin-top:6px;">${t.cta2} ↗</span>
        </a>
      </div>
    </div>
  </section>`;
}

// يملأ القالب بقيم المحتوى عبر العناصر النائبة {{path}}، ويعالج أقسام التواصل
export function applyContent(template: string, content: Record<string, unknown>, lang: Lang = 'ar'): string {
  const social = content.social as Record<string, string>;
  let html = template.split('{{__SOCIAL_SECTION__}}').join(renderSocialSection(social, lang));
  // حقن قسم الحاسبة البارز قبل قسم الأسعار مباشرة (منتصف الصفحة)
  html = html.replace('<section id="pricing"', renderCalculatorSection(lang) + '<section id="pricing"');
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
  ['ابدأ مجانًا', 'Get started free'], ['المدوّنة', 'Blog'], ['حاسبة التسريب', 'Leak Calculator'], ['مولّد الفواتير', 'Invoice Generator'],
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

// ترجمة النص الثابت داخل القالب إلى الفرنسية (للأسواق الفرنكوفونية — المغرب العربي)
const CHROME_FR: [string, string][] = [
  ['dir="rtl"', 'dir="ltr"'],
  // التنقّل
  ['>المميزات<', '>Fonctionnalités<'], ['>كيف يعمل<', '>Comment ça marche<'], ['>الأسعار<', '>Tarifs<'],
  ['>الأسئلة<', '>FAQ<'], ['>دخول الأدمن<', '>Espace admin<'], ['>تطبيق المندوب<', '>App commercial<'],
  ['ابدأ مجانًا', 'Essai gratuit'], ['المدوّنة', 'Blog'], ['حاسبة التسريب', 'Calculateur de fuite'], ['مولّد الفواتير', 'Générateur de factures'],
  // بطاقات العرض في القسم الرئيسي
  ['المبيعات والتحصيل', 'Ventes et encaissement'], ['٧ أيام', '7 jours'], ['محصّل اليوم', 'Encaissé aujourd’hui'],
  ['+12.4% عن أمس', '+12,4 % vs hier'], ['>سند قبض<', '>Bon de reçu<'], ['>المبلغ<', '>Montant<'],
  ['>الحالة<', '>Statut<'], ['تم الإرسال', 'Envoyé'], ['طلب #10428 قيد التنفيذ', 'Commande #10428 en cours'],
  ['٩٢٬٧٠٠', '92 700'], ['٨٠٠٫٠٠ ر.س', '800,00 SAR'],
  // الأسعار (نص ثابت)
  [' ر.س / شهريًا', ' SAR / mois'],
  ['إدارة الطلبات والتحصيل', 'Gestion des commandes et encaissement'],
  ['فواتير ضريبية وسندات قبض', 'Factures fiscales et bons de reçu'],
  ['تطبيق جوال للمناديب', 'Application mobile pour commerciaux'],
  ['تقارير أساسية', 'Rapports de base'],
  ['>ابدأ الآن<', '>Commencer<'],
  ['كل مميزات الباقة', 'Toutes les fonctionnalités de l’offre'],
  ['تقارير وكشوف حساب متقدمة', 'Rapports et relevés avancés'],
  ['دعم أولوية', 'Support prioritaire'],
  ['كل مميزات', 'Toutes les fonctionnalités de l’offre'],
  ['تكامل ERP ومحاسبة', 'Intégration ERP et comptabilité'],
  ['مدير حساب مخصّص', 'Gestionnaire de compte dédié'],
  ['تدريب وإعداد كامل', 'Formation et mise en place complètes'],
  ['تواصل مع المبيعات', 'Contacter les ventes'],
  // التذييل
  ['>المنتج<', '>Produit<'], ['تطبيق الجوال', 'Application mobile'],
  ['>الشركة<', '>Entreprise<'], ['>من نحن<', '>À propos<'], ['>تواصل معنا<', '>Contact<'],
  ['>قانوني<', '>Légal<'], ['>سياسة الخصوصية<', '>Politique de confidentialité<'],
  ['>الشروط والأحكام<', '>Conditions générales<'], ['>اتفاقية الخدمة<', '>Contrat de service<'],
  ['© ٢٠٢٦ Field Sales — جميع الحقوق محفوظة.', '© 2026 Field Sales — Tous droits réservés.'],
];

function translateChromeFr(html: string): string {
  let out = html;
  for (const [ar, fr] of CHROME_FR) out = out.split(ar).join(fr);
  return out;
}

// مبدّل اللغة الثلاثي المحقون في شريط التنقّل (ع/إ/فر) — ينتقل عبر الروابط للفهرسة الدولية
function langSwitcher(current: Lang): string {
  const items: [Lang, string][] = [['ar', 'ع'], ['en', 'EN'], ['fr', 'FR']];
  const btn = (code: Lang, label: string) => {
    const active = code === current;
    return `<button onclick="window.__fsSetLangRoute&&window.__fsSetLangRoute('${code}')" aria-label="${code}" style="border:none; cursor:pointer; font-family:inherit; font-size:13px; font-weight:700; padding:6px 11px; border-radius:8px; transition:all .15s; ${active ? 'background:#E15A30; color:#fff;' : 'background:transparent; color:#6E6557;'}">${label}</button>`;
  };
  return `<div role="group" aria-label="Language" style="display:inline-flex; align-items:center; gap:2px; background:#fff; border:1.5px solid #DED5C4; border-radius:11px; padding:3px;">${items.map(([c, l]) => btn(c, l)).join('')}</div>`;
}

// يحقن مبدّل اللغة قبل أزرار الدخول في شريط التنقّل
function injectLangSwitcher(html: string, current: Lang): string {
  return html.replace(
    '<div style="margin-right:auto; display:flex; align-items:center; gap:12px;">',
    `<div style="margin-right:auto; display:flex; align-items:center; gap:12px;">${langSwitcher(current)}`
  );
}

// ---- قسم «تغطية العالم العربي» — يبرز خدمة النظام وتوافقه مع أنظمة الدول العربية ----
const COVERAGE_COUNTRIES: { flag: string; ar: string; en: string; fr: string }[] = [
  { flag: '🇸🇦', ar: 'السعودية', en: 'Saudi Arabia', fr: 'Arabie saoudite' },
  { flag: '🇪🇬', ar: 'مصر', en: 'Egypt', fr: 'Égypte' },
  { flag: '🇦🇪', ar: 'الإمارات', en: 'UAE', fr: 'Émirats' },
  { flag: '🇰🇼', ar: 'الكويت', en: 'Kuwait', fr: 'Koweït' },
  { flag: '🇶🇦', ar: 'قطر', en: 'Qatar', fr: 'Qatar' },
  { flag: '🇧🇭', ar: 'البحرين', en: 'Bahrain', fr: 'Bahreïn' },
  { flag: '🇴🇲', ar: 'عُمان', en: 'Oman', fr: 'Oman' },
  { flag: '🇲🇦', ar: 'المغرب', en: 'Morocco', fr: 'Maroc' },
  { flag: '🇩🇿', ar: 'الجزائر', en: 'Algeria', fr: 'Algérie' },
  { flag: '🇹🇳', ar: 'تونس', en: 'Tunisia', fr: 'Tunisie' },
  { flag: '🇯🇴', ar: 'الأردن', en: 'Jordan', fr: 'Jordanie' },
];

function coverageSection(lang: Lang): string {
  const t = {
    ar: {
      eyebrow: 'تغطية إقليمية',
      title: 'يخدم شركات التوزيع في العالم العربي',
      sub: 'من السعودية إلى مصر ودول الخليج والمغرب العربي — عملة كل دولة وضريبتها وصيغة فاتورتها، بالعربية والإنجليزية والفرنسية.',
      note: 'متوافق مع أنظمة الفوترة الإلكترونية والضريبة في كل سوق — ZATCA (السعودية) — مع تطبيق عملة كل دولة ونسبة ضريبتها تلقائيًا.',
    },
    en: {
      eyebrow: 'Regional coverage',
      title: 'Built for distribution companies across the Arab world',
      sub: 'From Saudi Arabia to Egypt, the Gulf, and the Maghreb — each country’s currency, tax, and invoice format, in Arabic, English, and French.',
      note: 'Compliant with each market’s e-invoicing and tax systems — ZATCA (Saudi Arabia) — with each country’s currency and VAT applied automatically.',
    },
    fr: {
      eyebrow: 'Couverture régionale',
      title: 'Conçu pour les entreprises de distribution du monde arabe',
      sub: 'De l’Arabie saoudite à l’Égypte, au Golfe et au Maghreb — la devise, la taxe et le format de facture de chaque pays, en arabe, anglais et français.',
      note: 'Conforme aux systèmes de facturation électronique et de taxe de chaque marché — ZATCA (Arabie saoudite) — avec la devise et la TVA de chaque pays appliquées automatiquement.',
    },
  }[lang];
  const pills = COVERAGE_COUNTRIES.map((c) =>
    `<span style="display:inline-flex; align-items:center; gap:8px; background:#FAF7F0; border:1px solid #E9E1D3; border-radius:999px; padding:9px 16px; font-size:14.5px; font-weight:600; color:#1F1A13;"><span style="font-size:17px;">${c.flag}</span>${c[lang]}</span>`
  ).join('');
  return `<section style="max-width:1200px; margin:0 auto; padding:20px 28px 50px;">
    <div style="background:#fff; border:1px solid #E9E1D3; border-radius:26px; padding:48px 40px; text-align:center;">
      <div style="font-family:'IBM Plex Sans',sans-serif; font-size:12px; letter-spacing:2.5px; text-transform:uppercase; color:#E15A30; font-weight:600;">${t.eyebrow}</div>
      <h2 style="font-size:34px; line-height:1.18; font-weight:700; letter-spacing:-0.7px; margin-top:12px;">${t.title}</h2>
      <p style="font-size:16.5px; line-height:1.6; color:#6E6557; margin-top:14px; max-width:660px; margin-inline:auto;">${t.sub}</p>
      <div style="display:flex; flex-wrap:wrap; gap:12px; justify-content:center; margin-top:30px;">${pills}</div>
      <div style="display:inline-flex; align-items:flex-start; gap:10px; margin-top:30px; max-width:680px; text-align:start; background:#E4F1EA; border:1px solid #C9E4D6; border-radius:16px; padding:16px 20px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="flex-shrink:0; margin-top:2px;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#1E7A52" stroke-width="1.8" stroke-linejoin="round"></path><path d="M9 12l2 2 4-4" stroke="#1E7A52" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>
        <span style="font-size:14.5px; line-height:1.6; color:#1F5C3F; font-weight:500;">${t.note}</span>
      </div>
    </div>
  </section>`;
}

// يحقن قسم تغطية العالم العربي قبل قسم الأسعار
function injectCoverage(html: string, lang: Lang): string {
  const anchor = '<!-- ============ PRICING ============ -->';
  return html.replace(anchor, `${coverageSection(lang)}\n  ${anchor}`);
}

// ---- مربع «للتواصل وطلبات الاشتراك» — بياناته من CMS (قسم «تواصل معنا» بلوحة المالك) ----
type ContactInfo = { email?: string; phone?: string; whatsapp?: string; address?: string };

function contactSection(contact: ContactInfo, lang: Lang): string {
  const t = {
    ar: { title: 'للتواصل وطلبات الاشتراك', sub: 'راسلنا أو اتصل بنا مباشرة — فريقنا جاهز لمساعدتك وتفعيل اشتراك شركتك.', email: 'البريد الرسمي', phone: 'الهاتف', address: 'مقر الشركة', cta: 'اطلب اشتراكك الآن', whatsapp: 'واتساب' },
    en: { title: 'Contact & Subscription Requests', sub: 'Email or call us directly — our team is ready to help and activate your company subscription.', email: 'Official email', phone: 'Phone', address: 'Head office', cta: 'Request your subscription', whatsapp: 'WhatsApp' },
    fr: { title: 'Contact et demandes d’abonnement', sub: 'Écrivez-nous ou appelez-nous directement — notre équipe est prête à vous aider et à activer votre abonnement.', email: 'E-mail officiel', phone: 'Téléphone', address: 'Siège social', cta: 'Demandez votre abonnement', whatsapp: 'WhatsApp' },
  }[lang];
  // العنوان الافتراضي العربي يُعرَض مترجماً في النسختين الأجنبيتين؛ وأي نص يكتبه المالك يُعرض كما هو
  const addressRaw = String(contact.address || '').trim();
  const address = addressRaw === 'المملكة العربية السعودية' && lang !== 'ar'
    ? (lang === 'en' ? 'Saudi Arabia' : 'Arabie saoudite') : addressRaw;
  const email = String(contact.email || '').trim();
  const phone = String(contact.phone || '').trim();
  const wa = String(contact.whatsapp || '').trim();

  // أيقونات SVG بأسلوب الهوية
  const icon = (path: string) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E15A30" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">${path}</svg>`;
  const icEmail = icon('<rect x="2" y="4" width="20" height="16" rx="3"></rect><path d="m3 6 9 7 9-7"></path>');
  const icPhone = icon('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"></path>');
  const icPin = icon('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle>');
  const icWa = icon('<path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 1 0 12 2z"></path><path d="M8.5 9.5c.5 2.5 3.5 5.5 6 6l1.5-1.5-2-1.5-1 .5c-1-.5-2-1.5-2.5-2.5l.5-1-1.5-2z"></path>');

  // بطاقة معلومة واحدة (تُخفى إن كانت القيمة فارغة — يعبّئها المالك من لوحته)
  const card = (ic: string, label: string, valueHtml: string) =>
    `<div style="display:flex; align-items:flex-start; gap:13px; background:#FAF7F0; border:1px solid #E9E1D3; border-radius:16px; padding:18px 20px; min-width:230px; flex:1; text-align:start;">
      <span style="width:40px;height:40px;border-radius:12px;background:#FBEBE2;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${ic}</span>
      <span><span style="display:block;font-size:12px;color:#9A8F7E;font-weight:600;margin-bottom:3px">${label}</span><span style="font-size:15.5px;font-weight:700;color:#1F1A13;word-break:break-word">${valueHtml}</span></span>
    </div>`;

  const cards = [
    email ? card(icEmail, t.email, `<a href="mailto:${email}" style="color:#1F1A13;text-decoration:none" dir="ltr">${email}</a>`) : '',
    phone ? card(icPhone, t.phone, `<a href="tel:${phone.replace(/[^+0-9]/g, '')}" style="color:#1F1A13;text-decoration:none" dir="ltr">${phone}</a>`) : '',
    wa ? card(icWa, t.whatsapp, `<a href="https://wa.me/${wa.replace(/[^0-9]/g, '')}" target="_blank" rel="noreferrer" style="color:#1F1A13;text-decoration:none" dir="ltr">${wa}</a>`) : '',
    address ? card(icPin, t.address, address) : '',
  ].filter(Boolean).join('');
  if (!cards) return '';

  // زر «اطلب اشتراكك الآن» → صفحة «تسجيل طلب اشتراك جديد» (يصل الطلب للإدارة بريدياً)
  const requestUrl = lang === 'ar' ? '/subscribe-request' : `/${lang}/subscribe-request`;
  return `<section id="contact-box" style="max-width:1200px; margin:0 auto; padding:6px 28px 60px;">
    <div style="background:#fff; border:1px solid #E9E1D3; border-radius:26px; padding:44px 40px; text-align:center;">
      <div style="font-family:'IBM Plex Sans',sans-serif; font-size:12px; letter-spacing:2.5px; text-transform:uppercase; color:#E15A30; font-weight:600;">CONTACT</div>
      <h2 style="font-size:32px; line-height:1.2; font-weight:700; letter-spacing:-0.6px; margin-top:10px;">${t.title}</h2>
      <p style="font-size:16px; line-height:1.6; color:#6E6557; margin-top:12px; max-width:620px; margin-inline:auto;">${t.sub}</p>
      <div style="display:flex; flex-wrap:wrap; gap:14px; justify-content:center; margin-top:28px;">${cards}</div>
      <a href="${requestUrl}" style="display:inline-flex; align-items:center; gap:8px; margin-top:28px; background:#E15A30; color:#fff; font-weight:700; font-size:15.5px; padding:13px 30px; border-radius:14px; text-decoration:none; box-shadow:0 8px 22px rgba(225,90,48,.32);">${t.cta}</a>
    </div>
  </section>`;
}

// يحقن مربع التواصل قبل التذييل مباشرة (بعد دعوة الإجراء الأخيرة)
function injectContactBox(html: string, contact: ContactInfo, lang: Lang): string {
  const anchor = '<!-- ============ FOOTER ============ -->';
  return html.replace(anchor, `${contactSection(contact, lang)}\n  ${anchor}`);
}

// يضيف بادئة اللغة (/en · /fr) لروابط الصفحات التسويقية داخلياً حتى تبقى اللغة ثابتة عند التنقّل.
// (مسارات التطبيق /login · /rep · /signup تُترك — تحفظ لغتها من localStorage؛ والروابط الخارجية/المرساة تُترك.)
const LOCALIZED_PATHS = ['/about', '/contact', '/subscribe-request', '/blog', '/calculator', '/invoice-generator', '/privacy', '/terms', '/service-agreement'];
function localizeLinks(html: string, lang: Lang): string {
  if (lang === 'ar') return html;
  const prefix = lang === 'en' ? '/en' : '/fr';
  let out = html;
  for (const p of LOCALIZED_PATHS) {
    // href="/contact" → href="/en/contact"  (تطابق تام مع علامة الاقتباس لتفادي مطابقة /blog داخل /blog/slug)
    out = out.split(`href="${p}"`).join(`href="${prefix}${p}"`);
  }
  return out;
}

// ---- تبديل عملة عرض الأسعار (ريال ⇄ دولار) ----
// الريال مربوط رسميًا بالدولار عند 3.75، فنحوّل القيمة نفسها دون تغيير التكلفة الفعلية.
const SAR_PER_USD = 3.75;

// يحوّل نصّ سعر بالريال (أرقام عربية أو لاتينية) إلى قيمته المكافئة بالدولار،
// ويُعيد null لغير الأرقام («حسب الطلب / Custom») فتبقى كما هي.
function sarToUsd(price: string): string | null {
  const western = price.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const n = parseFloat(western.replace(/[^\d.]/g, ''));
  if (isNaN(n)) return null;
  const usd = n / SAR_PER_USD;
  return Number.isInteger(usd) ? String(usd) : usd.toFixed(2); // خانتان عشريتان للحفاظ على القيمة بدقّة
}

// يستبدل أسعار الباقات بقيمتها المكافئة بالدولار عند اختيار USD (لا يمسّ «حسب الطلب/Custom»)
function applyCurrency(content: Record<string, unknown>, cur: Currency): Record<string, unknown> {
  if (cur === 'sar') return content;
  const pricing = content.pricing as { plans?: Array<Record<string, unknown>> } | undefined;
  if (!pricing?.plans) return content;
  const plans = pricing.plans.map((p) => {
    const usd = sarToUsd(p.price as string);
    return usd ? { ...p, price: usd } : p;
  });
  return { ...content, pricing: { ...pricing, plans } };
}

// يُطبّق أسعار الـCMS الرقمية (التي يحرّرها المالك على النسخة العربية) على نسخ اللغات الأخرى،
// فيتغيّر السعر في كل اللغات معًا. السعر رقم لا يتأثّر باللغة؛ والأسعار غير الرقمية («حسب الطلب»)
// تبقى بنصّ اللغة الهدف (Custom / Sur devis). يتطابق ترتيب الباقات بين اللغات.
function applyCmsPrices(target: Record<string, unknown>, arContent: Record<string, unknown>): Record<string, unknown> {
  const arPricing = arContent.pricing as { plans?: Array<Record<string, unknown>> } | undefined;
  const tPricing = target.pricing as { plans?: Array<Record<string, unknown>> } | undefined;
  if (!arPricing?.plans || !tPricing?.plans) return target;
  const plans = tPricing.plans.map((p, i) => {
    const raw = arPricing.plans?.[i]?.price;
    if (typeof raw !== 'string') return p;
    const digits = raw.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\d.]/g, '');
    return /\d/.test(digits) ? { ...p, price: digits } : p; // رقمي فقط؛ «حسب الطلب» يبقى كما هو
  });
  return { ...target, pricing: { ...tPricing, plans } };
}

// مبدّل عملة الأسعار (ريال ⇄ دولار) على شكل زرّين مقسّمين, يُحقن داخل قسم الأسعار بجوار البطاقات
function currencyToggle(currency: Currency, lang: Lang): string {
  const sarLabel = lang === 'ar' ? 'ريال ﷼' : 'SAR ﷼';
  const usdLabel = lang === 'ar' ? 'دولار $' : 'USD $';
  const pill = (active: boolean) =>
    `padding:8px 22px; border:none; border-radius:9px; font-size:14.5px; font-weight:700; cursor:pointer; font-family:inherit; transition:all .15s;` +
    (active ? 'background:#E15A30; color:#fff; box-shadow:0 1px 4px rgba(225,90,48,.35);' : 'background:transparent; color:#6E6557;');
  return `<div style="text-align:center; margin-bottom:30px;"><div style="display:inline-flex; align-items:center; gap:4px; background:#F3EDE3; border:1.5px solid #DED5C4; border-radius:13px; padding:4px;"><button type="button" aria-label="SAR" onclick="window.__fsSetCurrency&&window.__fsSetCurrency('sar')" style="${pill(currency === 'sar')}">${sarLabel}</button><button type="button" aria-label="USD" onclick="window.__fsSetCurrency&&window.__fsSetCurrency('usd')" style="${pill(currency === 'usd')}">${usdLabel}</button></div></div>`;
}

// يحقن مبدّل العملة قبل شبكة بطاقات الباقات مباشرةً (المُحدِّد فريد في القالب)
function injectCurrencyToggle(html: string, currency: Currency, lang: Lang): string {
  const anchor = '<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:20px; align-items:stretch;">';
  return html.replace(anchor, `${currencyToggle(currency, lang)}${anchor}`);
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
  const currency = useCurrency((s) => s.currency);
  const navigate = useNavigate();
  const { canonical, alternates } = seoUrls('/', lang);

  const { data } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const res = await siteContentApi.get(); return res.data.data as unknown; },
    staleTime: 60_000,
  });
  // sameAs لمحرّكات البحث — روابط الـCMS، والحقول الفارغة تسقط للحسابات الافتراضية (نفس سلوك بقية الصفحة)
  const cmsSocial = (data as { social?: Record<string, string> } | null | undefined)?.social || {};
  const social: Record<string, string> = {
    ...defaultContent.social,
    ...Object.fromEntries(Object.entries(cmsSocial).filter(([, v]) => v && String(v).trim())),
  };
  const sameAs = [social.x, social.instagram, social.linkedin, social.facebook, social.youtube, social.tiktok, social.snapchat,
    social.whatsapp ? `https://wa.me/${String(social.whatsapp).replace(/[^0-9]/g, '')}` : '']
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const orgJsonLd = sameAs.length
    ? { '@context': 'https://schema.org', '@type': 'Organization', '@id': 'https://fieldsa.net/#organization', url: 'https://fieldsa.net/', sameAs }
    : undefined;

  // SEO الصفحة الرئيسية — كلمات مفتاحية لكل خدمة + canonical/hreflang حسب اللغة (دولي: ع/إ/فر)
  const seoByLang = {
    ar: {
      title: 'FieldSales فيلد سيلز | نظام مبيعات المناديب والتوزيع',
      description: 'فيلد سيلز نظام عربي لإدارة مبيعات مناديب التوزيع في السعودية ومصر والمغرب العربي: فواتير ضريبية، تحصيل وإدارة الذمم، سندات قبض، مخزون السيارة، وتتبّع المناديب GPS. جرّبه مجاناً.',
      keywords: 'نظام مبيعات ميدانية, إدارة مناديب التوزيع, نظام توزيع, برنامج توزيع, فواتير ضريبية, ZATCA, الفوترة الإلكترونية, فاتورة ضريبية مبسطة, تحصيل المدفوعات, إدارة الذمم المدينة, سندات قبض, مخزون سيارة المندوب, البيع المتنقل van sales, تتبع المناديب GPS, إدارة العملاء وحدود الائتمان, كتالوج المنتجات والأسعار, تكامل ERP, نظام مبيعات للأسواق العربية, نظام مبيعات مصر, نظام توزيع المغرب, برنامج مناديب الجزائر وتونس وليبيا, نظام مبيعات السعودية, فيلد سيلز',
      locale: 'ar' as const,
    },
    en: {
      title: 'FieldSales | Field Sales & Distribution Management System',
      description: 'FieldSales is a complete platform to manage field distribution reps: ZATCA e-invoices, collection, van stock, GPS tracking and reports. Free 10-day trial.',
      keywords: 'field sales system, sales rep management software, distribution management software, route accounting, ZATCA e-invoicing, tax invoice, payment collection, accounts receivable, van sales, van stock management, GPS rep tracking, customer management, product catalog, ERP integration',
      locale: 'en' as const,
    },
    fr: {
      title: 'FieldSales | Système de gestion des ventes terrain et de la distribution',
      description: 'FieldSales est une plateforme complète pour gérer les commerciaux de distribution : factures fiscales, encaissement, stock du véhicule, suivi GPS et rapports. Essai gratuit de 10 jours.',
      keywords: 'système de vente terrain, logiciel de gestion des commerciaux, logiciel de gestion de distribution, facturation électronique, facture fiscale, encaissement, gestion des créances, stock du véhicule, suivi GPS des commerciaux, gestion des clients, catalogue produits, intégration ERP, logiciel de distribution Maroc, logiciel commercial Algérie Tunisie',
      locale: 'fr' as const,
    },
  }[lang];
  useSeo({ ...seoByLang, canonical, alternates, image: 'https://fieldsa.net/og-image.png', jsonLd: orgJsonLd });

  // مبدّل اللغة المحقون في شريط التنقّل ينتقل بين / · /en · /fr (روابط منفصلة للفهرسة الدولية)
  useEffect(() => {
    (window as unknown as { __fsSetLangRoute?: (l: Lang) => void }).__fsSetLangRoute = (l) =>
      navigate(pathForLocale('/', l));
  }, [navigate]);

  // مبدّل العملة — يضبط الريال/الدولار محليًا دون تغيير المسار (يُحفظ الاختيار)
  useEffect(() => {
    (window as unknown as { __fsSetCurrency?: (c: Currency) => void }).__fsSetCurrency = (c) => useCurrency.getState().setCurrency(c);
  }, []);

  // محتوى CMS المحفوظ قد يكون قديماً (عدد ميزاته لا يطابق الكود الحالي) — حينها نتجاهله
  // ونستخدم المحتوى الافتراضي الحالي حتى لا تُعرَض ميزات/نصوص قديمة. وإلا ندمج تحرير المالك.
  const savedItems = (data as { features?: { items?: unknown[] } } | null | undefined)?.features?.items;
  const cmsCurrent = Array.isArray(savedItems) && savedItems.length === defaultContent.features.items.length;
  // ندمج تخصيصات CMS (روابط/تواصل/أسعار) دائماً؛ لكن إن كانت مميزات CMS أقدم (عدد مختلف)
  // نستبدلها بالمميزات الافتراضية الحالية حتى تظهر الميزات الجديدة دون فقد تخصيصات المالك.
  const merged = data ? mergeContent(defaultContent, data) : defaultContent;
  const arContent = (cmsCurrent ? merged : { ...merged, features: defaultContent.features }) as Record<string, unknown>;

  const socialLinks = (arContent.social as Record<string, string>) || {};
  let html: string;
  if (lang === 'en') {
    // النسخة الإنجليزية: محتوى إنجليزي ثابت + روابط CMS + أسعار CMS الرقمية + ترجمة النص الثابت
    const enBase = { ...defaultContentEn, social: socialLinks || defaultContentEn.social, heroImage: arContent.heroImage } as Record<string, unknown>;
    const enContent = applyCmsPrices(enBase, arContent);
    html = translateChrome(applyContent(LANDING_TEMPLATE, applyCurrency(enContent, currency), 'en'));
  } else if (lang === 'fr') {
    // النسخة الفرنسية: محتوى فرنسي ثابت + روابط CMS + أسعار CMS الرقمية + ترجمة النص الثابت (المغرب العربي)
    const frBase = { ...defaultContentFr, social: socialLinks || defaultContentFr.social, heroImage: arContent.heroImage } as Record<string, unknown>;
    const frContent = applyCmsPrices(frBase, arContent);
    html = translateChromeFr(applyContent(LANDING_TEMPLATE, applyCurrency(frContent, currency), 'fr'));
  } else {
    html = applyContent(LANDING_TEMPLATE, applyCurrency(arContent, currency), 'ar');
  }
  html = injectLangSwitcher(html, lang);
  html = injectCoverage(html, lang);
  // مربع «للتواصل وطلبات الاشتراك» — بياناته من CMS العربي (المصدر الواحد) وتُعرض بكل اللغات
  html = injectContactBox(html, (arContent.contact as ContactInfo) || {}, lang);
  html = localizeLinks(html, lang); // يبقي لغة الروابط ثابتة عند الانتقال للصفحات التالية

  // مبدّل العملة داخل قسم الأسعار + ضبط لاحقة السعر حسب العملة (لاحقة « ر.س / شهريًا» ثابتة في القالب)
  html = injectCurrencyToggle(html, currency, lang);
  if (currency === 'usd') {
    html = html
      .split(' ر.س / شهريًا').join(' دولار / شهريًا')
      .split(' SAR / mo').join(' USD / mo')
      .split(' SAR / mois').join(' USD / mois');
  }

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
