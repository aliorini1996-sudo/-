/**
 * جسر واتساب ويب — حالة الجلسة والمصادقة.
 *
 * العقل هنا (Render) واليد جسر محلي على جهاز المالك يشغّل whatsapp-web.js.
 * الجسر يسحب الطابور ويُبلّغ النتائج؛ لا يفتح أي منفذ ولا يحتاج IP ثابتاً.
 *
 * حالة الجلسة تُحفظ JSON في siteContent (لا تغيير مخطّط) — فهي حالة عابرة لا بيانات عمل.
 */

import prisma from '../config/database';

export type WaBridgeStatus = 'DISCONNECTED' | 'QR' | 'CONNECTED' | 'AUTH_FAILED';

export interface WaBridgeSession {
  status: WaBridgeStatus;
  qr: string | null;           // صورة QR (data URL) — تُمسح فور الاتصال
  phone: string | null;        // الرقم المرتبط بعد المسح
  pushName: string | null;     // اسم الحساب على واتساب
  lastHeartbeat: string | null; // آخر نبضة من الجسر (ISO) — لكشف انقطاعه
  lastError: string | null;
  command: 'LOGOUT' | null;    // أمر معلّق يلتقطه الجسر عند السحب التالي
  updatedAt: string;
}

const SESSION_ID = 'wa_bridge_session';

const EMPTY: WaBridgeSession = {
  status: 'DISCONNECTED',
  qr: null,
  phone: null,
  pushName: null,
  lastHeartbeat: null,
  lastError: null,
  command: null,
  updatedAt: new Date(0).toISOString(),
};

export async function getBridgeSession(): Promise<WaBridgeSession> {
  const row = await prisma.siteContent.findUnique({ where: { id: SESSION_ID } });
  if (!row?.data) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(row.data) as Partial<WaBridgeSession>) };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveBridgeSession(patch: Partial<WaBridgeSession>): Promise<WaBridgeSession> {
  // نُسقط مفاتيح undefined: نشرها يمسح القيمة الحالية بدل تركها (بخلاف null الذي يعني «امسح» صراحةً)
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next: WaBridgeSession = {
    ...(await getBridgeSession()),
    ...clean,
    updatedAt: new Date().toISOString(),
  };
  await prisma.siteContent.upsert({
    where: { id: SESSION_ID },
    create: { id: SESSION_ID, data: JSON.stringify(next) },
    update: { data: JSON.stringify(next) },
  });
  return next;
}

/**
 * هل الجسر حيّ فعلاً؟ الحالة المحفوظة قد تقول CONNECTED بينما الجسر أُغلق فجأة
 * (إطفاء الجهاز مثلاً) فلا تصل رسالة «فُصلت». النبضة هي الحقيقة.
 */
export function isBridgeAlive(s: WaBridgeSession, maxAgeSec = 90): boolean {
  if (!s.lastHeartbeat) return false;
  return Date.now() - new Date(s.lastHeartbeat).getTime() < maxAgeSec * 1000;
}

// مفتاح مشترك بين الخادم والجسر — بدونه لا يعمل الجسر إطلاقاً
export function bridgeKeyConfigured(): boolean {
  return !!(process.env.WA_BRIDGE_KEY || '').trim();
}

export function checkBridgeKey(provided?: string): boolean {
  const key = (process.env.WA_BRIDGE_KEY || '').trim();
  if (!key) return false; // لم يُضبط المفتاح: نرفض بدل أن نفتح الباب للجميع
  // نُنظّف الطرفين: لصق المفتاح في Render أو PowerShell يجرّ مسافة/سطراً بسهولة،
  // وتنظيف طرف واحد فقط يُنتج عدم تطابق صامتاً يستحيل تفسيره.
  return (provided || '').trim() === key;
}

// ------------------------- نصّ الرسالة الافتراضي ------------------------- //

const DRAFT_ID = 'wa_bridge_draft';

/**
 * رسالة أولى قصيرة ومحترمة: تعريف + زاوية دولة العميل + دعوة خفيفة + مخرج واضح.
 * قصيرة عمداً — الرسائل الطويلة على واتساب تُقرأ كإعلان فتُحظر.
 */
export const DEFAULT_DRAFT = [
  'مرحباً {{name}} 👋',
  '',
  'أنا علي من Field Sales — نظام عربي لإدارة مبيعات المناديب والتوزيع (فواتير، تحصيل وذمم، مخزون سيارة المندوب، تتبّع GPS).',
  '',
  '{{angle}}',
  '',
  'حاب أعرف: كيف تديرون مناديبكم حالياً؟',
  'تجربة مجانية بلا بطاقة: fieldsa.net',
  '',
  'لإيقاف الرسائل ردّ بكلمة «إيقاف».',
].join('\n');

export async function getDraftTemplate(): Promise<string> {
  const row = await prisma.siteContent.findUnique({ where: { id: DRAFT_ID } });
  return row?.data || DEFAULT_DRAFT;
}

export async function saveDraftTemplate(template: string): Promise<void> {
  await prisma.siteContent.upsert({
    where: { id: DRAFT_ID },
    create: { id: DRAFT_ID, data: template },
    update: { data: template },
  });
}
