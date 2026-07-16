/**
 * حملة واتساب التسويقية — الإعدادات، متغيّرات القالب، والحدّ اليومي.
 *
 * لماذا متغيّرات القالب مهمّة: قوالب Meta المعتمدة نصّها ثابت ولا يقبل إلا متغيّرات
 * موضعية {{1}},{{2}}... فبدل قالب عامّ واحد لكل الدول، نحقن **زاوية الدولة** (نفس
 * COUNTRY_ANGLES المستخدمة في البريد) كمتغيّر — فيصل الموزّع السعودي ذكرَ ZATCA،
 * والمصري ذكرَ ETA، من قالب واحد معتمد.
 */

import prisma from '../config/database';
import { countryAngle, LeadLike } from './marketingTemplate';

// حقول يمكن حقنها في متغيّرات القالب، بالترتيب الذي يختاره المالك
export type WaParam = 'name' | 'city' | 'country' | 'angle' | 'angle_en';
export const WA_PARAMS: WaParam[] = ['name', 'city', 'country', 'angle', 'angle_en'];

export interface WaConfig {
  templateName: string;
  language: string;
  params: WaParam[];   // ترتيب المتغيّرات = ترتيب {{1}},{{2}}... في القالب
  dailyCap: number;    // سقف الرسائل الصادرة في اليوم (حماية تقييم جودة الرقم)
  batchSize: number;   // سقف الدفعة الواحدة
}

const DEFAULT_WA_CONFIG: WaConfig = {
  templateName: '',
  language: 'ar',
  params: ['name', 'angle'],
  dailyCap: 80,
  batchSize: 50,
};

const CONFIG_ID = 'lead_whatsapp';

export async function getWaConfig(): Promise<WaConfig> {
  const row = await prisma.siteContent.findUnique({ where: { id: CONFIG_ID } });
  if (!row?.data) return { ...DEFAULT_WA_CONFIG };
  try {
    return { ...DEFAULT_WA_CONFIG, ...(JSON.parse(row.data) as Partial<WaConfig>) };
  } catch {
    return { ...DEFAULT_WA_CONFIG };
  }
}

export async function saveWaConfig(cfg: WaConfig): Promise<void> {
  await prisma.siteContent.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, data: JSON.stringify(cfg) },
    update: { data: JSON.stringify(cfg) },
  });
}

/**
 * تنظيف قيمة متغيّر القالب حسب قيود Meta:
 * لا أسطر جديدة ولا جدولة ولا أربع مسافات متتالية، ولا قيمة فارغة — وإلا رُفضت الرسالة.
 */
function sanitizeParam(v: string): string {
  const clean = (v || '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  return clean || '-';
}

// بناء متغيّرات القالب لعميل بعينه — الزاوية تُشتقّ من دولته
export function resolveWaParams(params: WaParam[], lead: LeadLike): string[] {
  const angle = countryAngle(lead);
  return params.map((p) => {
    switch (p) {
      case 'name': return sanitizeParam(lead.name);
      case 'city': return sanitizeParam(lead.city || lead.country || '');
      case 'country': return sanitizeParam(lead.country || '');
      case 'angle': return sanitizeParam(angle.ar);
      case 'angle_en': return sanitizeParam(angle.en);
      default: return '-';
    }
  });
}

// معاينة نصّية لما سيُملأ في القالب (لعرضه في لوحة المالك قبل الإرسال)
export function previewWaParams(params: WaParam[], lead: LeadLike): { slot: string; field: WaParam; value: string }[] {
  return resolveWaParams(params, lead).map((value, i) => ({ slot: `{{${i + 1}}}`, field: params[i], value }));
}

// كم رسالة صادرة أُرسلت اليوم؟ (أساس الحدّ اليومي)
// الفاشلة لا تُحتسب: لم تصل أحداً، فلا تستهلك الحصّة ولا تمسّ تقييم جودة الرقم.
export async function waSentToday(): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return prisma.waMessage.count({
    where: { direction: 'OUT', status: { not: 'FAILED' }, createdAt: { gte: start } },
  });
}

// المتبقّي من الحصّة اليومية (لا يقلّ عن صفر)
export async function waRemainingToday(cap?: number): Promise<number> {
  const cfg = cap ?? (await getWaConfig()).dailyCap;
  const used = await waSentToday();
  return Math.max(0, cfg - used);
}
