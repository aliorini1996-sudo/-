/**
 * محرّك وكيل واتساب — القلب الذي يربط الطبقات الخمس:
 *   1) الشخصية (persona.ts) — الأسلوب البشري باللهجة
 *   2) القائمة البيضاء (pricing.ts) — الحدّ الصلب على الأسعار
 *   3) الحارس (guard.ts) — يفحص كل ردّ قبل خروجه
 *   4) النموذج (Claude، احتياطه Gemini) — يولّد الرد
 *   5) التصعيد — يسلّم العميل الجاهز/المعقّد للمالك بملخّص (تسليم دافئ)
 *
 * القرار المعماري الحاكم: النموذج يقترح، والحارس يقرر ما يخرج فعلاً.
 * يُستدعى من handleInboundMessage بعد تسجيل الرسالة الواردة وترقية المرحلة.
 */

import prisma from '../../config/database';
import { sendWhatsAppText, whatsappReady } from '../whatsapp';
import { anthropicChat, anthropicReady, type ChatTurn } from '../anthropic';
import { geminiGenerate, geminiReady } from '../gemini';
import { sendMail, mailLayout } from '../mailer';
import {
  buildSystemPrompt,
  dialectFromPhone,
  handoffSummary,
  type Dialect,
} from './persona';
import { guardReply, safeFallback } from './guard';

/** تفعيل الوكيل — يبقى مطفأً حتى يضبط المالك المفتاح، فلا يردّ آلياً بلا إذن */
export function waAgentEnabled(): boolean {
  return (process.env.WA_AGENT_ENABLED || '').trim() === '1';
}

const HISTORY_LIMIT = 16; // آخر رسائل للسياق — يكفي لمحادثة بيع، ويكبح التكلفة

/** يبني تاريخ المحادثة من WaMessage لهذا الرقم بترتيب زمني */
async function loadHistory(phone: string): Promise<ChatTurn[]> {
  const rows = await prisma.waMessage.findMany({
    where: { phone, body: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
    select: { direction: true, body: true },
  });
  return rows
    .reverse()
    .map((r) => ({
      role: r.direction === 'IN' ? ('user' as const) : ('assistant' as const),
      content: r.body || '',
    }))
    .filter((t) => t.content.trim());
}

/** يستخرج عدد المناديب من نص العميل إن ذكره (لحساب السعر في ملخّص التصعيد) */
function extractRepCount(text: string): number | undefined {
  const m = text.match(/(\d{1,3})\s*(مندوب|مناديب|rep|مندوبين)?/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 && n <= 500 ? n : undefined;
}

/** يولّد الرد عبر Claude، واحتياطه Gemini، ثم يمرّره بالحارس */
async function generateReply(
  system: string,
  history: ChatTurn[],
): Promise<{ text: string; forceEscalate: boolean; violations: string[]; source: string }> {
  let raw = '';
  let source = 'none';

  if (anthropicReady()) {
    raw = await anthropicChat({ system, messages: history, maxTokens: 400, effort: 'medium' });
    if (raw) source = 'claude';
  }
  if (!raw && geminiReady()) {
    // Gemini يأخذ آخر رسالة عميل كـuser والباقي مدموجاً في السياق
    const lastUser = [...history].reverse().find((t) => t.role === 'user')?.content || '';
    const priorContext = history
      .slice(0, -1)
      .map((t) => `${t.role === 'user' ? 'العميل' : 'المساعد'}: ${t.content}`)
      .join('\n');
    raw = await geminiGenerate(system, `سياق سابق:\n${priorContext}\n\nرسالة العميل الآن: ${lastUser}`, {
      maxTokens: 400,
      temperature: 0.7,
    });
    if (raw) source = 'gemini';
  }

  const verdict = guardReply(raw);
  return { text: verdict.text, forceEscalate: verdict.forceEscalate || !verdict.ok, violations: verdict.violations, source };
}

/** يصعّد المحادثة للمالك بملخّص دافئ (بريد) */
async function escalateToOwner(input: {
  waId: string;
  phone: string;
  name?: string;
  reason: string;
  repCount?: number;
  history: ChatTurn[];
}): Promise<void> {
  const transcript = input.history.map((t) => ({
    role: t.role === 'user' ? ('customer' as const) : ('agent' as const),
    text: t.content,
  }));
  const summary = handoffSummary({
    waId: input.phone,
    name: input.name,
    reason: input.reason,
    repCount: input.repCount,
    transcript,
  });
  const html = mailLayout('عميل واتساب يحتاجك 🔔', [
    ['الرقم', input.phone],
    ['الاسم', input.name || '—'],
    ['السبب', input.reason],
    ['عدد المناديب', input.repCount ? String(input.repCount) : '—'],
  ], `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${summary}</pre>`);
  await sendMail({ subject: `🔔 عميل واتساب يحتاجك — ${input.name || input.phone}`, html });
}

/**
 * وضع الظل — يولّد الرد المقترح بلا إرسال ولا تسجيل.
 * المالك يراه ويرسله بنفسه من واتسابه؛ هذه الخطوة الأولى المقترحة قبل الأتمتة الكاملة،
 * تختبر جودة الردود على محادثات حقيقية وتضبط الشخصية بلا أي رقم مسجَّل ولا مخاطرة.
 */
export interface ShadowResult {
  reply: string;          // الرد المقترح للنسخ
  dialect: Dialect;       // اللهجة المستنتجة
  wouldEscalate: boolean; // هل كان الحارس سيصعّد بدل الإرسال
  reason: string;         // سبب التصعيد إن وُجد
  source: string;         // claude | gemini | none
  violations: string[];   // ما رصده الحارس
}

export async function shadowSuggest(input: {
  phone: string;
  customerMessage: string;
  priorMessages?: { role: 'customer' | 'agent'; text: string }[];
  name?: string;
  isReturning?: boolean;
}): Promise<ShadowResult> {
  const phone = (input.phone || '').replace(/[^\d]/g, '');
  const dialect: Dialect = dialectFromPhone(phone);

  // تاريخ يدوي (اختياري) + رسالة العميل الحالية
  const history: ChatTurn[] = [
    ...(input.priorMessages || []).map((m) => ({
      role: m.role === 'customer' ? ('user' as const) : ('assistant' as const),
      content: m.text,
    })),
    { role: 'user' as const, content: input.customerMessage },
  ].filter((t) => t.content.trim());

  const system = buildSystemPrompt({ dialect, customerName: input.name, isReturning: input.isReturning });
  const { text, forceEscalate, violations, source } = await generateReply(system, history);

  if (!text || forceEscalate) {
    return {
      reply: safeFallback(dialect),
      dialect,
      wouldEscalate: true,
      reason: violations.length ? violations.join('؛ ') : 'النموذج لم يُنتج ردّاً آمناً — يُصعَّد للمالك',
      source,
      violations,
    };
  }
  return { reply: text, dialect, wouldEscalate: false, reason: '', source, violations: [] };
}

/**
 * المعالج الرئيسي — يُستدعى بعد تسجيل رسالة العميل الواردة.
 * يردّ آلياً على العميل، أو يصعّد للمالك، بحسب حكم الحارس.
 */
export async function runAgentTurn(input: {
  waId: string;
  phone: string;
  body: string;
  leadId: string | null;
  isReturning: boolean;
  name?: string;
}): Promise<{ replied: boolean; escalated: boolean }> {
  if (!waAgentEnabled()) return { replied: false, escalated: false };
  if (!whatsappReady()) return { replied: false, escalated: false };

  const dialect: Dialect = dialectFromPhone(input.phone);
  const history = await loadHistory(input.phone);
  if (!history.length) return { replied: false, escalated: false };

  const system = buildSystemPrompt({
    dialect,
    customerName: input.name,
    isReturning: input.isReturning,
  });

  const { text, forceEscalate, violations, source } = await generateReply(system, history);
  const repCount = extractRepCount(input.body);

  // فشل النموذج تماماً أو حجب الحارس الرد → رسالة آمنة + تصعيد
  if (!text || forceEscalate) {
    const fallback = safeFallback(dialect);
    await sendWhatsAppText(input.phone, fallback);
    await escalateToOwner({
      waId: input.waId,
      phone: input.phone,
      name: input.name,
      reason: violations.length ? violations.join('؛ ') : 'النموذج لم يُنتج ردّاً آمناً',
      repCount,
      history: [...history, { role: 'assistant', content: fallback }],
    });
    if (input.leadId) {
      await prisma.leadActivity.create({
        data: { leadId: input.leadId, type: 'WHATSAPP_ESCALATED', content: `تصعيد: ${violations.join('؛ ') || 'رد محجوب'}`, createdBy: 'وكيل واتساب' },
      }).catch(() => {});
    }
    return { replied: true, escalated: true };
  }

  // ردّ سليم → أرسله وسجّله كرسالة صادرة (فيدخل التاريخ ويمنع تكرار السياق)
  const wamid = await sendWhatsAppText(input.phone, text);
  await prisma.waMessage.create({
    data: {
      waId: wamid || `agent-${input.waId}`,
      leadId: input.leadId,
      phone: input.phone,
      direction: 'OUT',
      body: text,
      status: wamid ? 'SENT' : 'FAILED',
    },
  }).catch(() => {});

  if (input.leadId) {
    await prisma.leadActivity.create({
      data: { leadId: input.leadId, type: 'WHATSAPP_AGENT', content: `ردّ الوكيل (${source}): ${text.slice(0, 120)}`, createdBy: 'وكيل واتساب' },
    }).catch(() => {});
  }

  return { replied: true, escalated: false };
}
