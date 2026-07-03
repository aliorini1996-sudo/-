/**
 * قالب البريد التسويقي المشترك (بطاقة بصرية + نصّ ثنائي اللغة) —
 * يُستخدم في الإرسال اليدوي (routes/leads) والإرسال التلقائي المستمر (services/leadEmailer).
 *
 * يدعم: زاوية مخصّصة لكل دولة (امتثال/ألم محلي)، تتبّع فتح/نقر، ورابط إلغاء اشتراك —
 * كلها بلا تغيير مخطّط (التتبّع يُسجَّل في LeadActivity عبر نقاط leads-cron العامة).
 */

export interface LeadLike { id?: string; name: string; city?: string | null; country?: string | null; countryCode?: string | null }

// عنوان الـAPI العام (لبكسل الفتح وروابط النقر) — قابل للضبط بالبيئة
const API_BASE = (process.env.PUBLIC_API_URL || 'https://api.fieldsa.net').replace(/\/+$/, '');
const SITE = 'https://fieldsa.net';

// ------------------------- زاوية مخصّصة لكل دولة عربية ------------------------- //
// سطر «ألم محلي/امتثال» يُحقن في البريد حسب دولة العميل — يرفع الصلة والردود.
const COUNTRY_ANGLES: Record<string, { ar: string; en: string }> = {
  SA: { ar: 'فواتير إلكترونية متوافقة مع «فاتورة» هيئة الزكاة والضريبة والجمارك (ZATCA) — المرحلة الثانية جاهزة.', en: 'ZATCA Phase-2 compliant e-invoicing, ready out of the box.' },
  EG: { ar: 'جاهز لمنظومة الفاتورة الإلكترونية المصرية (ETA) وإيصالات التحصيل النقدي للمناديب.', en: 'Ready for Egypt’s ETA e-invoicing and cash-collection receipts for your reps.' },
  AE: { ar: 'فواتير ضريبة القيمة المضافة 5% متوافقة مع الهيئة الاتحادية للضرائب (FTA).', en: 'FTA-compliant 5% VAT invoicing for the UAE.' },
  KW: { ar: 'إدارة الذمم والتحصيل الميداني — أكبر وجع في توزيع الجملة بالكويت.', en: 'Receivables & field collections — the #1 pain in Kuwaiti wholesale.' },
  QA: { ar: 'تتبّع مناديبك في الدوحة والمناطق الصناعية لحظة بلحظة عبر GPS.', en: 'Track your Doha & industrial-area reps live on GPS.' },
  BH: { ar: 'فواتير VAT 10% جاهزة لمتطلبات البحرين، مع مخزون سيارة المندوب.', en: 'Bahrain-ready 10% VAT invoicing with van-stock control.' },
  OM: { ar: 'فواتير ضريبية متوافقة مع جهاز الضرائب العُماني، وتحصيل ميداني موثّق.', en: 'Oman Tax Authority-compliant invoicing with documented field collections.' },
  JO: { ar: 'جاهز لمنظومة الفوترة الوطنية الأردنية (JoFotara) وتحصيل الذمم.', en: 'Ready for Jordan’s national e-invoicing (JoFotara) and receivables.' },
  MA: { ar: 'إدارة موزّعين بالعربية والفرنسية، مع فواتير TVA المغربية.', en: 'Arabic + French distributor management with Moroccan TVA invoices.' },
  DZ: { ar: 'واجهة عربية/فرنسية وإدارة توزيع تغطي الولايات الجزائرية كلها.', en: 'Arabic/French interface covering distribution across all Algerian wilayas.' },
  TN: { ar: 'إدارة مناديب التوزيع بالعربية والفرنسية مع فواتير TVA التونسية.', en: 'Rep management in Arabic & French with Tunisian TVA invoicing.' },
  IQ: { ar: 'يعمل بلا تعقيد حتى مع ضعف الإنترنت — مصمَّم لواقع التوزيع في العراق.', en: 'Works reliably even on weak connections — built for Iraq’s distribution reality.' },
  LB: { ar: 'فوترة متعددة العملات (ليرة/دولار) تناسب واقع السوق اللبناني.', en: 'Multi-currency invoicing (LBP/USD) built for the Lebanese market.' },
  LY: { ar: 'نظام سحابي خفيف يدير التوزيع بين المدن الليبية بلا خوادم محلية.', en: 'Light cloud system managing distribution across Libyan cities — no local servers.' },
  PS: { ar: 'إدارة كاملة للمناديب والتحصيل تعمل من أي جهاز وبأي ظرف.', en: 'Full rep & collection management from any device, under any conditions.' },
  SD: { ar: 'يدير مبيعاتك الميدانية بأقل تكلفة وبنية تحتية — سحابي بالكامل.', en: 'Runs your field sales fully in the cloud with minimal cost and infrastructure.' },
  YE: { ar: 'خفيف على الإنترنت الضعيف، ويوثّق التحصيل النقدي أولاً بأول.', en: 'Light on weak internet, documenting cash collections in real time.' },
  SY: { ar: 'ابدأ رقمنة التوزيع بلا أي بنية تحتية — سحابي ويعمل فوراً.', en: 'Digitize distribution with zero infrastructure — cloud-based, instant start.' },
  MR: { ar: 'إدارة التوزيع بالعربية والفرنسية تناسب السوق الموريتاني.', en: 'Arabic & French distribution management for the Mauritanian market.' },
};

// زاوية الدولة (بالرمز أولاً ثم بالاسم العربي احتياطاً) — أو سطر عام إن لم تُعرف
export function countryAngle(lead: LeadLike): { ar: string; en: string } {
  const cc = (lead.countryCode || '').toUpperCase();
  if (cc && COUNTRY_ANGLES[cc]) return COUNTRY_ANGLES[cc];
  const byName: Record<string, string> = {
    'السعودية': 'SA', 'مصر': 'EG', 'الإمارات': 'AE', 'الكويت': 'KW', 'قطر': 'QA', 'البحرين': 'BH',
    'عُمان': 'OM', 'عمان': 'OM', 'الأردن': 'JO', 'المغرب': 'MA', 'الجزائر': 'DZ', 'تونس': 'TN',
    'العراق': 'IQ', 'لبنان': 'LB', 'ليبيا': 'LY', 'فلسطين': 'PS', 'السودان': 'SD', 'اليمن': 'YE',
    'سوريا': 'SY', 'موريتانيا': 'MR',
  };
  const code = byName[(lead.country || '').trim()];
  if (code && COUNTRY_ANGLES[code]) return COUNTRY_ANGLES[code];
  return {
    ar: 'فواتير ضريبية، تحصيل وذمم، مخزون سيارة المندوب، وتتبّع GPS — في لوحة واحدة.',
    en: 'Tax invoicing, collections, van inventory and GPS tracking — one dashboard.',
  };
}

// يستبدل العناصر النائبة {{name}} / {{city}} / {{country}} / {{angle}}
export function personalize(text: string, lead: LeadLike): string {
  const angle = countryAngle(lead);
  return text
    .replace(/\{\{\s*name\s*\}\}/g, lead.name || '')
    .replace(/\{\{\s*city\s*\}\}/g, lead.city || '')
    .replace(/\{\{\s*country\s*\}\}/g, lead.country || '')
    .replace(/\{\{\s*angle\s*\}\}/g, angle.ar)
    .replace(/\{\{\s*angle_en\s*\}\}/g, angle.en);
}

export interface TrackingOpts { leadId?: string; touch?: number }

// رابط CTA متتبَّع: يمرّ عبر نقطة النقر العامة ثم يعيد التوجيه للموقع مع UTM
function ctaUrl(t: TrackingOpts): string {
  const dest = `${SITE}/?utm_source=coldmail&utm_medium=email&utm_campaign=touch${t.touch || 1}`;
  if (!t.leadId) return dest;
  return `${API_BASE}/api/leads-cron/c/${t.leadId}?t=${t.touch || 1}&u=${encodeURIComponent(dest)}`;
}

// قالب بريد تسويقي بهوية Field Sales (بطاقة hero + زاوية الدولة + شريط ميزات + CTA متتبَّع)
export function marketingHtml(bodyText: string, lead: LeadLike, tracking: TrackingOpts = {}): string {
  const safe = personalize(bodyText, lead)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  const angle = countryAngle(lead);
  const cta = ctaUrl(tracking);
  const feat = (ar: string, en: string) => `<td style="padding:9px 12px;vertical-align:top;width:50%">
    <span style="color:#E15A30;font-weight:700">●</span>
    <span style="color:#1F1A13;font-size:14px;font-weight:600"> ${ar}</span>
    <span style="color:#9A8F7E;font-size:12px"> · ${en}</span></td>`;
  const pixel = tracking.leadId
    ? `<img src="${API_BASE}/api/leads-cron/o/${tracking.leadId}.gif?t=${tracking.touch || 1}" width="1" height="1" alt="" style="display:block;border:0" />`
    : '';
  const unsub = tracking.leadId
    ? `<a href="${API_BASE}/api/leads-cron/u/${tracking.leadId}" style="color:#6E6557;text-decoration:underline">إلغاء الاشتراك · Unsubscribe</a>`
    : 'ردّ بكلمة «إلغاء» · reply "unsubscribe"';
  return `<div style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#F1EBDF;padding:24px 12px">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 2px 10px rgba(31,26,19,0.08)">
      <a href="${cta}" style="display:block"><img src="https://fieldsa.net/email/hero.png" alt="Field Sales" width="600" style="width:100%;max-width:600px;display:block;border:0" /></a>
      <div dir="auto" style="padding:26px 28px 10px;color:#3a342b;font-size:15px;line-height:1.95">${safe}</div>
      <div dir="auto" style="margin:6px 24px;padding:12px 16px;background:#FFF6F1;border-right:3px solid #E15A30;border-radius:10px;color:#1F1A13;font-size:13.5px;line-height:1.8">
        <b style="color:#E15A30">✦</b> ${angle.ar}<br><span style="color:#9A8F7E;font-size:12px">${angle.en}</span>
      </div>
      <table role="presentation" width="100%" style="border-collapse:collapse;margin:4px 14px 6px">
        <tr>${feat('فواتير ضريبية', 'Tax e-invoicing')}${feat('التحصيل والذمم', 'Collections')}</tr>
        <tr>${feat('مخزون سيارة المندوب', 'Van inventory')}${feat('تتبّع GPS', 'Live GPS tracking')}</tr>
      </table>
      <div style="padding:16px 24px 26px;text-align:center">
        <a href="${cta}" style="display:inline-block;background:#E15A30;color:#ffffff;text-decoration:none;padding:14px 38px;border-radius:12px;font-weight:700;font-size:16px">جرّب Field Sales مجاناً &nbsp;·&nbsp; Start free</a>
      </div>
      <div dir="auto" style="padding:14px 26px;color:#9A8F7E;font-size:12px;line-height:1.7;border-top:1px solid #F1EBDF;background:#FAF7F0">
        رسالة أعمال من Field Sales — ${unsub}<br>
        This is a B2B message from Field Sales · <a href="${SITE}" style="color:#6E6557;text-decoration:underline">fieldsa.net</a>
      </div>
    </div>
  </div>${pixel}`;
}

// ------------------------- نصوص السلسلة (3 لمسات) ------------------------- //
// اللمسة 1: تعريف — اللمسة 2: قيمة/إثبات — اللمسة 3: رسالة أخيرة (وداع مهذّب).

export const DEFAULT_EMAIL_SUBJECT = 'Field Sales — نظام مبيعات المناديب والتوزيع | Field-sales & distribution platform';
export const DEFAULT_EMAIL_BODY = [
  'مرحباً فريق {{name}}،',
  '',
  'Field Sales منصّة متكاملة لإدارة مبيعات المناديب الميدانيين والتوزيع: فواتير ضريبية، تحصيل وإدارة ذمم، مخزون سيارة المندوب، وتتبّع المواقع بالـGPS — في لوحة واحدة سهلة.',
  '',
  'يسعدنا أن نعرض عليكم النظام في جولة قصيرة، أو جرّبوه مجاناً على fieldsa.net.',
  '',
  '— — —',
  '',
  'Hello {{name}} team,',
  '',
  'Field Sales is an all-in-one platform to run your field reps and distribution: tax invoicing, collections & receivables, van inventory, and live GPS tracking — all in one simple dashboard.',
  '',
  "We'd be glad to give you a short demo, or start your free trial at fieldsa.net.",
  '',
  'مع خالص التحية · Best regards,',
  'فريق Field Sales',
].join('\n');

export const DEFAULT_EMAIL_SUBJECT_2 = 'كم يضيع من مبيعاتك بين دفتر المندوب والمستودع؟ | Are paper routes costing you sales?';
export const DEFAULT_EMAIL_BODY_2 = [
  'مرحباً مجدداً فريق {{name}}،',
  '',
  'أرسلنا لكم قبل أيام تعريفاً بمنصّة Field Sales — وأحببنا أن نشارككم رقماً واحداً:',
  'الشركات التي تدير مناديبها بالورق أو الواتساب تفقد عادةً 5-12% من إيراداتها بين فواتير ضائعة، وتحصيل غير موثّق، ومخزون سيارة لا يُجرد.',
  '',
  'احسبوا تسريبكم بأنفسكم خلال دقيقة (حاسبة مجانية): fieldsa.net/calculator',
  '',
  'Field Sales يغلق هذه الفجوات كلها من اليوم الأول، والتجربة مجانية بلا بطاقة.',
  '',
  '— — —',
  '',
  'Hello again {{name}} team,',
  '',
  'One number worth sharing: companies running reps on paper or WhatsApp typically leak 5-12% of revenue through lost invoices, undocumented collections and unaudited van stock.',
  '',
  'Field Sales closes all of these gaps from day one — free trial, no card needed.',
  '',
  'مع خالص التحية · Best regards,',
  'فريق Field Sales',
].join('\n');

export const DEFAULT_EMAIL_SUBJECT_3 = 'رسالتنا الأخيرة — الحساب المجاني بانتظاركم | Last note from Field Sales';
export const DEFAULT_EMAIL_BODY_3 = [
  'مرحباً فريق {{name}}،',
  '',
  'هذه آخر رسالة منّا — لا نحب الإزعاج. إن لم يكن تنظيم مبيعات المناديب أولوية الآن فنتفهّم ذلك تماماً.',
  '',
  'إن أحببتم لاحقاً: حسابكم التجريبي المجاني يبقى متاحاً في أي وقت على fieldsa.net، ويجهز خلال دقائق.',
  '',
  '— — —',
  '',
  'Hello {{name}} team,',
  '',
  "This is our last note — we don't like to spam. If organizing your field sales isn't a priority right now, we completely understand.",
  '',
  'Whenever you are ready, your free trial stays available at fieldsa.net — it takes minutes to set up.',
  '',
  'مع خالص التحية · Best regards,',
  'فريق Field Sales',
].join('\n');

// نص/موضوع اللمسة المطلوبة مع احتياط افتراضي
export function touchTemplate(touch: number, cfg: { subject: string; body: string; subject2?: string | null; body2?: string | null; subject3?: string | null; body3?: string | null }): { subject: string; body: string } {
  if (touch === 2) return { subject: cfg.subject2 || DEFAULT_EMAIL_SUBJECT_2, body: cfg.body2 || DEFAULT_EMAIL_BODY_2 };
  if (touch >= 3) return { subject: cfg.subject3 || DEFAULT_EMAIL_SUBJECT_3, body: cfg.body3 || DEFAULT_EMAIL_BODY_3 };
  return { subject: cfg.subject, body: cfg.body };
}
