/**
 * فوترة ZATCA المرحلة الثانية (Z5.6c) — قراءة ردّ الإصدار في العميل: نقيّة، بلا React ولا شبكة ولا قاموس.
 *
 * ثلاثة ردود «تنجح» في زمن التنفيذ بلا استثناء يُرمى، وكلٌّ منها كان يُنتج ورقةً خاطئة أو نقرةً صامتة:
 *
 *  • **202 `ZATCA_CLEARANCE_PENDING`** — الفاتورة القياسية أُنشئت ووُقّعت ولم تعتمدها الهيئة بعد. أكسيوس لا يرمي على
 *    2xx، فبلا حارسٍ تُفتح ورقة «فاتورة ضريبية» عن مستندٍ لا يعتمده المشتري لخصم مدخلاته. وقرار المالك D5: البضاعة
 *    خرجت فعلاً ⇒ يُسلَّم **سند تسليم** غير ضريبيّ الآن، وتصل الفاتورة المعتمدة بعد الاعتماد. والصفّ كاملاً يأتي في
 *    جسم الردّ (`data`) ومعه `einvoice`، فمنه تُبنى ورقة التسليم بلا نداء ثانٍ.
 *  • **202 `ZATCA_CLEARED_NO_XML`** — حسمتها الهيئة ولم تصل نسختها المعتمدة: المعاملة نفسها (سند تسليم بتنبيهه).
 *  • **426 `ZATCA_CLIENT_UPDATE_REQUIRED`** — حزمةٌ مفتوحة منذ ما قبل النشر لا تفهم المرحلة الثانية. رسالة الخادم
 *    تقول «أغلق التطبيق وافتحه»، وهي في جوّال المندوب تعني إلغاء تسجيل عامل الخدمة وإعادة التحميل — زرٌّ واحد.
 *
 * وما عدا ذلك يبقى كما هو: 201 ⇒ الطباعة كما اليوم (والقرار في `docPrint` يختار العنوان والرمز).
 *
 * وطلب المالك ٣١ أكتوبر ٢٠٢٦ (فكّ قيد الرقم الضريبي والعنوان الوطني): 201 قد يحمل `notice` بجانب `data` —
 * `ZATCA_BUYER_SIMPLIFIED`: صدرت لمنشأةٍ ناقصة البيانات مبسطةً (02) لا ضريبية. إعلاميّ لا يغيّر الورقة (عنوانها من الخادم)؛
 * يُقال للمستخدم مرّة بعد الإصدار، ولا يُطبع على الورقة.
 */

import { zatcaDocView, type ZatcaDocView } from './docStatus';
import { zatcaPrintDecision } from './docPrint';
import { BUYER_BILLING_FIELDS, type BuyerField } from './buyerData';
import { BUYER_FIELD_UI_LABELS_AR } from './buyerForm';

export const ZATCA_OUTDATED_CODE = 'ZATCA_CLIENT_UPDATE_REQUIRED';
export const ZATCA_OFFLINE_CODE = 'ZATCA_OFFLINE_BLOCKED';

/** ردّ إصدارٍ كما يصل العميل (axios) — ما يُقرأ منه فقط. */
export interface IssueResponseLike {
  status?: unknown;
  data?: { message?: unknown; code?: unknown; data?: unknown } | null;
}

export type ZatcaIssueOutcome =
  /** 201: صدرت ويُطبع مستندها كما اليوم. */
  | { kind: 'issued' }
  /** 202 ومعه صفٌّ يصلح سند تسليم (D5): تُفتح الورقة غير الضريبية بهذا العرض. */
  | { kind: 'deliveryNote'; row: Record<string, unknown>; view: ZatcaDocView; message: string }
  /** لا ورقة: رسالة الخادم وحدها (202 بلا صفّ صالح، أو أيّ ردّ آخر). */
  | { kind: 'halt'; message: string };

const str = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');

/**
 * قراءة ردّ `POST /invoices`. `fallbackMessage` نصٌّ مترجَم يمرّره المستدعي حين لا يرسل الخادم رسالة.
 *
 * الشرط على سند التسليم مقصود الضيق: لا يُفتح إلا إن **قرّر** `docPrint` أنّه سند تسليم (قياسية غير معتمدة، فاتورةٌ
 * لا إشعار) وكان للصفّ رقمٌ يُطبع. وما عداه — إشعار دائن معلّق، مستند مُبطل، صفٌّ ناقص — لا ورقة له أصلاً.
 */
export function zatcaIssueOutcome(res: IssueResponseLike | null | undefined, fallbackMessage: string): ZatcaIssueOutcome {
  if (res?.status === 201) return { kind: 'issued' };
  const message = str(res?.data?.message) || fallbackMessage;
  const row = res?.data?.data;
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { kind: 'halt', message };
  const view = zatcaDocView(row as Record<string, unknown>);
  if (!view) return { kind: 'halt', message };
  const decision = zatcaPrintDecision({}, view);
  if (decision.kind !== 'deliveryNote' || !str((row as { number?: unknown }).number)) return { kind: 'halt', message };
  return { kind: 'deliveryNote', row: row as Record<string, unknown>, view, message };
}

/** خطأ 426: حزمةٌ قديمة لا تفهم المستند المختوم — الرمز أوّلاً ثمّ الحالة (وسيطٌ قد يبتلع الجسم). */
export function isZatcaOutdatedClient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const r = (err as { response?: { status?: unknown; data?: { code?: unknown } | null } }).response;
  if (!r) return false;
  return r.data?.code === ZATCA_OUTDATED_CODE || r.status === 426;
}

/**
 * إعادة تحميل الحزمة بعد 426: عامل الخدمة هو الذي يقدّم الحزمة القديمة من الذاكرة المؤقّتة، فإلغاء تسجيله قبل
 * إعادة التحميل هو الفرق بين «حدّثتُ فلم يتغيّر شيء» وبين حزمةٍ جديدة فعلاً. الحقن يجعلها قابلة للاختبار بلا متصفّح.
 */
export interface ReloadEnv {
  sw?: { getRegistrations(): Promise<ReadonlyArray<{ unregister(): Promise<unknown> }>> } | null;
  reload: () => void;
}

export async function zatcaReloadForUpdate(env: ReloadEnv): Promise<void> {
  try {
    const regs = (await env.sw?.getRegistrations()) ?? [];
    await Promise.all(regs.map(r => r.unregister().catch(() => undefined)));
  } catch {
    // إلغاء التسجيل ليس شرطاً للإصلاح — إعادة التحميل تجري في كل حال
  }
  env.reload();
}

// ─── فكّ القيد: إشعار «صدرت مبسطة» في ردّ 201 ───

export const ZATCA_BUYER_SIMPLIFIED_CODE = 'ZATCA_BUYER_SIMPLIFIED';

export interface BuyerNotice {
  /** حقول البطاقة الناقصة كما أرسلها الخادم (المعروفة وحدها). */
  fields: BuyerField[];
  /** المستدعي يعرف ما أصدر: فاتورة بيع أو إشعار (مرتجع). */
  kind: 'invoice' | 'note';
}

/**
 * قراءة `notice` من جسم ردّ الإصدار (res.data). لا يُقبل إلا رمز ZATCA_BUYER_SIMPLIFIED، والحقول تُصفّى إلى حقول الفوترة المعروفة
 * — فنصٌّ حرّ من الخادم لا يصل إلى قاموس الترجمة. غيابه أو شكلٌ غريب ⇒ null (والإصدار كما هو).
 */
export function buyerNoticeOf(body: unknown, kind: 'invoice' | 'note' = 'invoice'): BuyerNotice | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const n = (body as { notice?: unknown }).notice;
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  const { code, fields } = n as { code?: unknown; fields?: unknown };
  if (code !== ZATCA_BUYER_SIMPLIFIED_CODE) return null;
  const known = Array.isArray(fields)
    ? fields.filter((f): f is BuyerField => typeof f === 'string' && (BUYER_BILLING_FIELDS as readonly string[]).includes(f))
    : [];
  return { fields: [...new Set(known)], kind };
}

/** نصّ الإشعار بلغة الواجهة: الجملة ثم «ناقص للفاتورة الضريبية: …» بأسماء الحقول المترجمة. */
export function buyerNoticeText(n: BuyerNotice, tr: (key: string) => string): string {
  const head = n.kind === 'note'
    ? tr('صدر الإشعار مبسطا لأن بيانات العميل ناقصة للفاتورة الضريبية')
    : tr('صدرت فاتورة ضريبية مبسطة لأن بيانات العميل ناقصة للفاتورة الضريبية');
  if (n.fields.length === 0) return head;
  return `${head} — ${tr('ناقص للفاتورة الضريبية')}: ${n.fields.map(f => tr(BUYER_FIELD_UI_LABELS_AR[f])).join('، ')}`;
}

/**
 * نصوص هذا المسار في واجهة المندوب — يحرس اختبار القاموس أنّ لكلّ نصّ ترجماته الأربع.
 * (رسالة 202 نفسها تأتي من الخادم، وعند غيابها يمرّر المستدعي نصّ Z5.2 المترجَم سلفاً.)
 */
export const ZATCA_ISSUE_PHRASES: readonly string[] = Object.freeze([
  'تحديث التطبيق وإعادة الفتح',
  'مستندات صدرت دون اتصال قبل تفعيل الفوترة الإلكترونية محجوزة لمراجعة الإدارة ولن تضيع ولا يلزمك شيء',
  'صدرت فاتورة ضريبية مبسطة لأن بيانات العميل ناقصة للفاتورة الضريبية',
  'صدر الإشعار مبسطا لأن بيانات العميل ناقصة للفاتورة الضريبية',
]);
