/**
 * «إدارة المبيعات» (طلب المالك ١٦ نوفمبر ٢٠٢٦) — كل من تواصل مع المنصة في قائمة واحدة: التسجيل التجريبي (مباشرةً أو عبر سفير)،
 * و«احجز اجتماع»، و«تواصل معنا»، وطلب الاشتراك وطلب عرض السعر، ومحادثات بوت واتساب. عملاء مولّد الفواتير خارجها عمداً (أمر المالك).
 *
 * ثوابت وأدوات صرفة لنافذة components/SalesCrmPanel.tsx — مفاتيح القنوات والحالات هي نفسها في الخادم
 * (backend/src/services/salesInbox.ts ومسارا /api/leads/sales-inbox)، والنصوص العربية تُعرض بـtr() فترجمتها في i18n/strings.ts.
 */
import { ALL_DIAL } from '../i18n/dialCodes';

/** القنوات بترتيب العرض — `cls` شارة القناة في عمود «من أين أتى» */
export const SALES_CHANNELS = [
  { value: 'TRIAL', label: 'تسجيل تجريبي', cls: 'bg-[#FBEBE2] text-[#C94E28]' },
  { value: 'AMBASSADOR_TRIAL', label: 'تجربة عبر سفير', cls: 'bg-amber-50 text-amber-800' },
  { value: 'MEETING', label: 'طلب اجتماع', cls: 'bg-indigo-50 text-indigo-700' },
  { value: 'CONTACT', label: 'تواصل معنا', cls: 'bg-sky-50 text-sky-700' },
  { value: 'SUBSCRIPTION', label: 'طلب اشتراك', cls: 'bg-green-50 text-green-700' },
  { value: 'QUOTE_REQUEST', label: 'طلب عرض سعر', cls: 'bg-purple-50 text-purple-700' },
  { value: 'WHATSAPP', label: 'واتساب', cls: 'bg-[#E7F8EE] text-[#128C7E]' },
] as const;
export type SalesChannel = typeof SALES_CHANNELS[number]['value'];

/** مراحل المتابعة السبع — PUT يرفض غيرها (400) */
export const SALES_STAGES = [
  { value: 'NEW', label: 'جديد', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  { value: 'CONTACTED', label: 'تم التواصل', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  { value: 'MEETING', label: 'تم الاجتماع', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  { value: 'NEGOTIATION', label: 'المفاوضة', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  { value: 'WON', label: 'مشتري', cls: 'bg-green-50 text-green-700 border-green-200' },
  { value: 'LOST', label: 'تم خسارة العميل', cls: 'bg-red-50 text-red-700 border-red-200' },
  { value: 'NOT_FIT', label: 'غير مناسب', cls: 'bg-gray-100 text-gray-700 border-gray-200' },
] as const;
export type SalesStage = typeof SALES_STAGES[number]['value'];

/** حدّ الملاحظة — كحدّ الخادم */
export const SALES_NOTE_MAX = 2000;

/** حجم الصفحة: الافتراضي كافتراضي الخادم، و«عرض المزيد» يرفعه إلى سقفه */
export const SALES_LIMIT_DEFAULT = 300;
export const SALES_LIMIT_MAX = 1000;

/** صفّ القائمة كما يرسله GET /api/leads/sales-inbox */
export interface SalesRow {
  id: string;
  channel: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  country: string | null;
  message: string | null;
  origin: string | null;
  tenantId: string | null;
  stage: string;
  note: string | null;
  firstAt: string;
  lastAt: string;
}

export interface SalesInbox {
  rows: SalesRow[];
  total: number;
  /** على كل ما يحقّ للمستخدم رؤيته — لا على الصفحة المرشَّحة وحدها */
  counts: { byChannel: Record<string, number>; byStage: Record<string, number> };
  /** included=false: لا صلاحية لمحادثات البوت فلا صفوف واتساب أصلاً · ok=false: تعذّر جلبها هذه المرة */
  whatsapp: { ok: boolean; included: boolean; error?: string };
  syncedAt: string;
}

export interface SalesInboxParams { channel?: string; stage?: string; q?: string; limit?: number }
export interface SalesUpdate { stage?: SalesStage; note?: string | null }

/** القناة بمفتاحها — والمجهولة (خادمٌ أحدث) تُعرض بمفتاحها كما هو بشارة محايدة */
export function channelOf(value: string): { value: string; label: string; cls: string } {
  return SALES_CHANNELS.find((c) => c.value === value) ?? { value, label: value, cls: 'bg-gray-100 text-gray-600' };
}

export function stageOf(value: string): { value: string; label: string; cls: string } {
  return SALES_STAGES.find((s) => s.value === value) ?? { value, label: value, cls: 'bg-white text-gray-500 border-gray-200' };
}

/** توحيد اسم الدولة للمطابقة: حروفٌ صغيرة، وبلا تشكيل ولا تطويل، والهمزات ألفاً والتاء المربوطة هاءً، وبلا «ال» في أوله */
const normCountry = (s: string): string => s.trim().toLowerCase()
  .replace(/[\u064B-\u0652\u0640]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[.\-_'’]/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/^ال/, '');

/** أسماءٌ شائعة لا تطابق اسم الدولة في dialCodes حرفياً — رمزها ISO */
const COUNTRY_ALIASES: Record<string, string> = {
  ksa: 'SA', saudi: 'SA', 'kingdom of saudi arabia': 'SA', 'مملكه العربيه السعوديه': 'SA',
  uae: 'AE', emirates: 'AE', 'امارات العربيه المتحده': 'AE',
  usa: 'US', uk: 'GB',
};

let dialIndex: Map<string, string> | null = null;
/** مفتاح الاتصال (+XXX) من دولة الصفّ: رمزها ISO (التجارب و«احجز اجتماع») أو اسمها كما كُتب في نموذج الاشتراك
 *  وعرض السعر (عربياً أو إنجليزياً) — '' إن لم تُعرف */
export function dialForCountry(country: string | null | undefined): string {
  const t = (country ?? '').trim();
  if (!t) return '';
  if (!dialIndex) {
    dialIndex = new Map();
    for (const d of ALL_DIAL) {
      for (const k of [normCountry(d.ar), normCountry(d.en)]) if (k && !dialIndex.has(k)) dialIndex.set(k, d.dial);
    }
  }
  const up = t.toUpperCase();
  const byCode = /^[A-Z]{2}$/.test(up) ? ALL_DIAL.find((d) => d.code === up) : undefined;
  if (byCode) return byCode.dial;
  const n = normCountry(t);
  const alias = COUNTRY_ALIASES[n];
  if (alias) return ALL_DIAL.find((d) => d.code === alias)?.dial ?? '';
  return dialIndex.get(n) ?? '';
}

/**
 * الشكل الدولي للرقم أرقاماً فقط (بلا +) للروابط — null إن لم يكفِ للاتصال أو لم يُعرف مفتاحه.
 * countryGiven: للصفّ دولةٌ مكتوبة — فإن لم تُعرف (dial فارغ) لا يُخمَّن الرقم المحلي ولا يُقبل المجرّد دولياً
 * (05xxxxxxxx إماراتيٌّ أيضاً، و51234567 كويتيٌّ لا بيروفي)؛ التخمين السعودي حين لا دولة أصلاً وحده.
 */
export function intlDigits(phone: string | null | undefined, dial = '', countryGiven = false): string | null {
  const raw = (phone ?? '').trim();
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  const cc = dial.replace(/\D/g, '');
  if (raw.startsWith('+')) { /* دوليٌّ كما كُتب */ }
  else if (d.startsWith('00')) d = d.slice(2);
  else if (cc) {
    // دولته معروفة: المحلي بالصفر أو بدونه يُسبق بمفتاحها، وما بدأ بمفتاحها ووراءه رقمٌ كامل دوليٌّ كما هو
    if (d.startsWith('0')) d = cc + d.slice(1);
    else if (!(d.startsWith(cc) && d.length - cc.length >= 7) && d.length <= 10) d = cc + d;
  } else if (countryGiven) return null; // دولةٌ كُتبت ولم تُعرف: لا تخمين
  else if (/^0?5\d{8}$/.test(d)) d = `966${d.replace(/^0/, '')}`; // بلا دولة: الجوال السعودي سوقُنا الأول
  else if (d.startsWith('0') || d.length < 10) return null; // محليٌّ غير سعودي أو أقصر من رقمٍ دوليٍّ كامل — لا يُخمَّن
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** رابط الاتصال: الرقم كما كُتب بأرقامه و+ فقط — لا نصّ آخر داخل tel: */
export function telHref(phone: string | null | undefined): string | null {
  const raw = (phone ?? '').trim();
  if (!raw) return null;
  const clean = (raw.startsWith('+') ? '+' : '') + raw.replace(/\D/g, '');
  return clean.replace('+', '').length >= 6 ? `tel:${clean}` : null;
}

/** رابط واتساب https://wa.me/<digits> — يحتاج رقماً دولياً */
export function waHref(phone: string | null | undefined, dial = '', countryGiven = false): string | null {
  const d = intlDigits(phone, dial, countryGiven);
  return d ? `https://wa.me/${d}` : null;
}

/** رابط واتساب لصفّ القائمة: مفتاح الدولة من رمزها أو اسمها — و«XX» (دولة غير محدّدة) كالفارغة */
export function waHrefForRow(row: { phone: string | null; country: string | null }): string | null {
  const c = (row.country ?? '').trim();
  const given = !!c && c.toUpperCase() !== 'XX';
  return waHref(row.phone, given ? dialForCountry(c) : '', given);
}

/** بريدٌ صالحٌ للرابط فقط (لا مسافات ولا معاملات تُحقن في mailto:) */
export function mailHref(email: string | null | undefined): string | null {
  const e = (email ?? '').trim();
  return /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(e) ? `mailto:${e}` : null;
}

/** معاملات الطلب: الفارغ لا يُرسل، والحدّ إن أُعطي */
export function inboxParams(p: { channel: string; stage: string; q: string; limit?: number }): SalesInboxParams {
  const out: SalesInboxParams = {};
  if (p.channel) out.channel = p.channel;
  if (p.stage) out.stage = p.stage;
  if (p.q.trim()) out.q = p.q.trim();
  if (p.limit) out.limit = p.limit;
  return out;
}
