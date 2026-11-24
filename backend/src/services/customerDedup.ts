import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { normImportPhone } from './importMatch';
import { phoneDupExempt } from './customerPhoneDup';

/**
 * «منع تكرار العملاء عند فتح عميل جديد» — قيدٌ في إعدادات المندوب (طلب المالك ٢٣ نوفمبر ٢٠٢٦): الشركة تختار لكل مندوب
 * الجوال أو الاسم أو العنوان (أيّ تركيبة) فلا يفتح عميلاً بقيمةٍ مسجَّلةٍ لعميلٍ آخر في الشركة كلها — لا عملاءه وحدهم —
 * والمحذوف (status DELETED) لا يُعدّ. والتعديل يُفحص فيه الحقل المفعَّل حين تتغيّر قيمته وحدها (changedDedupChecks)، فتكرارٌ
 * قديم لا يمنع تعديل غيره. و«الموقع ضمن ٣٠ متراً» قاعدةٌ للشركة كلها كما هي (services/customerLocationDup.ts) لا عَلَمٌ هنا.
 *
 * المطابقة بعد التطبيع: الجوال بـnormImportPhone (+966 و00966 و05 والأرقام الهندية رقمٌ واحد)، والاسم والعنوان بـfoldText:
 * قصّ الطرفين وضمّ المسافات، وحذف التشكيل والتطويل وعلامات الاتجاه الخفية، وأ/إ/آ/ٱ ⇒ ا، وة ⇒ ه، وى/ی ⇒ ي، وک ⇒ ك،
 * والأرقام الهندية لاتينية، والحروف اللاتينية صغيرة. والفارغ والتافه («-»، حرفٌ واحد، «عميل»، «لا يوجد») لا يُطابَق أبداً.
 *
 * القيد للمندوب الحيّ وحده (repDedupChecks): الإدارة لا يمسّها، ومفتاح API وإعادة رفع صندوق المندوب (X-FS-Replay) معفيّان كمنع
 * الموقع (phoneDupExempt) — عميلٌ أُضيف دون اتصال وفواتيره تنتظره بمرجعه، فرفضه يُسقطها. حدٌّ معروف: ما يُفتح دون اتصال لا يُمنع.
 *
 * الاستعلام محصور: مسحٌ واحد للشركة (فهرس tenantId) وغير المحذوف مهما كثرت الحقول، والتطبيع نفسه في SQL (translate بجدول الطيّ
 * المصدَّر هنا ثم ضمّ المسافات، بعد حارس طولٍ رخيص) فلا يُحمَّل عملاء الشركة إلى الذاكرة — ويُعاد التحقّق بالتطبيع في JS على مرشّحين
 * معدودين. ولا فهرس تعبيرٍ (لا يعبّر عنه prisma db push، والمخطّط إضافيٌّ بالأعمدة الثلاثة وحدها).
 */
export const CUSTOMER_DUPLICATE = 'CUSTOMER_DUPLICATE';

export type DedupField = 'phone' | 'name' | 'address';
export interface DedupChecks { phone: boolean; name: boolean; address: boolean }
export interface DedupValues { phone?: string | null; name?: string | null; address?: string | null }
export interface CustomerDuplicate { field: DedupField; id: string; name: string }

/** أعمدة القيد في صفّ المندوب — select موحَّد لمسارات العملاء */
export const DEDUP_REP_SELECT = { dedupCustomerPhone: true, dedupCustomerName: true, dedupCustomerAddress: true } as const;
export interface DedupRepFlags { dedupCustomerPhone?: boolean | null; dedupCustomerName?: boolean | null; dedupCustomerAddress?: boolean | null }

// ═══ التطبيع ═══

const cp = (from: number, to: number = from): string[] => Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));

/** حرفٌ ⇒ بديله (حرفٌ واحد): الهمزات والتاء المربوطة والياءات والكاف الفارسية، والأرقام الهندية، والمسافات غير اللاتينية، واللاتينية الكبيرة */
const FOLD_PAIRS: readonly [string, string][] = [
  ['أ', 'ا'], ['إ', 'ا'], ['آ', 'ا'], ['ٱ', 'ا'], ['ى', 'ي'], ['ی', 'ي'], ['ک', 'ك'], ['ة', 'ه'],
  ...'٠١٢٣٤٥٦٧٨٩'.split('').map((d, i): [string, string] => [d, String(i)]),
  ...'۰۱۲۳۴۵۶۷۸۹'.split('').map((d, i): [string, string] => [d, String(i)]),
  // مسافات يعدّها JS بيضاء ولا تعدّها كل لغات القاعدة: تُوحَّد مسافةً لاتينية قبل الضمّ
  ...['\u00A0', '\u1680', ...cp(0x2000, 0x200A), '\u2028', '\u2029', '\u202F', '\u205F', '\u3000'].map((c): [string, string] => [c, ' ']),
  // اللاتينية الكبيرة (ASCII ثم Latin-1 عدا ×) صغيرةً — جدولٌ ثابت لا lower() يتبع لغة القاعدة
  ...cp(0x41, 0x5A).map((c): [string, string] => [c, String.fromCodePoint(c.codePointAt(0)! + 0x20)]),
  ...[...cp(0xC0, 0xD6), ...cp(0xD8, 0xDE)].map((c): [string, string] => [c, String.fromCodePoint(c.codePointAt(0)! + 0x20)]),
];
/** ما يُحذف: التشكيل (ً–ٟ) والألف الخنجرية والتطويل، ومحارف العرض الخفية (ZWSP/ZWNJ/ZWJ/LRM/RLM والتضمين والعزل وBOM) */
const FOLD_DELETE: readonly string[] = [...cp(0x064B, 0x065F), '\u0670', '\u0640', ...cp(0x200B, 0x200F), ...cp(0x202A, 0x202E), ...cp(0x2066, 0x2069), '\uFEFF'];

/**
 * وسيطا translate() في SQL: محارف FROM الأولى تقابل TO حرفاً بحرف، والزائد بعدها يُحذف (دلالة PostgreSQL) — فالجدول نفسه
 * يطبّع في القاعدة وفي foldText، ولا يفترقان
 */
export const SQL_FOLD_FROM = FOLD_PAIRS.map(([f]) => f).join('') + FOLD_DELETE.join('');
export const SQL_FOLD_TO = FOLD_PAIRS.map(([, t]) => t).join('');

const FOLD_MAP = new Map<string, string>(FOLD_PAIRS);
const FOLD_DEL = new Set<string>(FOLD_DELETE);

/** تطبيع النصّ للمطابقة (الاسم والعنوان) — نظير SQL في findCustomerDuplicate حرفياً: translate ثم ضمّ [[:space:]]+ ثم btrim */
export function foldText(s: unknown): string {
  if (s === null || s === undefined) return '';
  let out = '';
  for (const ch of String(s)) {
    const m = FOLD_MAP.get(ch);
    if (m !== undefined) out += m;
    else if (!FOLD_DEL.has(ch)) out += ch;
  }
  return out.replace(/[\t\n\v\f\r ]+/g, ' ').replace(/^ | $/g, '');
}

/** قيمٌ تافهة لا يُطابَق بها (مطبَّعة): الاسم البديل للعميل بلا اسم («عميل» — routes/customers.ts) وعبارات «لا شيء» الشائعة */
const PLACEHOLDERS = new Set([
  'عميل', 'عميل جديد', 'لا يوجد', 'لايوجد', 'لا شيء', 'لا شي', 'بدون', 'بدون اسم', 'بدون عنوان', 'غير معروف', 'غير محدد', 'غير متوفر',
  'n/a', 'na', 'none', 'null', 'nil', 'undefined', 'unknown', 'no', 'nothing',
].map(foldText));

/** المطبَّع تافهٌ: أقلّ من حرفين أو رقمين (فارغ، «-»، «.»، حرفٌ واحد) أو عبارة «لا شيء» */
export function isTrivialFolded(folded: string): boolean {
  const significant = folded.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return significant < 2 || PLACEHOLDERS.has(folded);
}

/** مفتاح الاسم للمطابقة، أو null إن كان فارغاً أو تافهاً */
export function normalizeName(s: unknown): string | null {
  const f = foldText(s);
  return isTrivialFolded(f) ? null : f;
}

/** مفتاح العنوان للمطابقة (التطبيع نفسه)، أو null إن كان فارغاً أو تافهاً */
export function normalizeAddress(s: unknown): string | null {
  return normalizeName(s);
}

// ═══ من يُفحص ومتى ═══

/**
 * فحوص القيد لهذا الطلب، أو null (لا فحص): لغير المندوب (الإدارة لا يمسّها)، وللمعفى (مفتاح API وإعادة رفع صندوق المندوب —
 * phoneDupExempt)، وللمندوب بلا أيّ عَلَم (السلوك قبله حرفياً)
 */
export function repDedupChecks(
  req: { headers: Record<string, unknown>; user?: { role?: string | null; apiKeyId?: string | null } | null },
  rep: DedupRepFlags | null | undefined,
): DedupChecks | null {
  if (req.user?.role !== 'SALES_REP' || phoneDupExempt(req)) return null;
  const checks: DedupChecks = {
    phone: rep?.dedupCustomerPhone === true, name: rep?.dedupCustomerName === true, address: rep?.dedupCustomerAddress === true,
  };
  return checks.phone || checks.name || checks.address ? checks : null;
}

const phoneKey = (v: unknown): string | null => normImportPhone(v);
const KEY_OF: Record<DedupField, (v: unknown) => string | null> = { phone: phoneKey, name: normalizeName, address: normalizeAddress };

/**
 * فحوص التعديل: الحقل المفعَّل المرسَل الذي تغيّرت قيمته المطبَّعة عن المحفوظ وحده — القيمة نفسها (ولو بمسافةٍ أو همزةٍ مختلفة)
 * لا تُفحص فتكرارٌ قديم لا يمنع تعديل غيره، والغائب (undefined) لا يُمسّ، والممسوح أو التافه لا يُطابَق. null ⇒ لا فحص
 */
export function changedDedupChecks(checks: DedupChecks | null, sent: DedupValues, stored: DedupValues | null | undefined): DedupChecks | null {
  if (!checks) return null;
  const out: DedupChecks = { phone: false, name: false, address: false };
  for (const f of ['phone', 'name', 'address'] as const) {
    if (!checks[f] || sent[f] === undefined) continue;
    const key = KEY_OF[f](sent[f]);
    out[f] = key !== null && key !== KEY_OF[f](stored?.[f]);
  }
  return out.phone || out.name || out.address ? out : null;
}

// ═══ البحث ═══

/** حدّ المرشّحين في المسح الواحد — يُرتَّبون بأولوية الحقل أولاً فلا يُزاح مرشّح الجوال بمئات العملاء بالاسم نفسه (فروع سلسلة) */
const DEDUP_CANDIDATES_LIMIT = 200;

/** عدد المحارف كما يعدّها length() في PostgreSQL (نقاط ترميز، لا وحدات UTF-16 كـ.length) */
const pgLength = (s: string): number => Array.from(s).length;

/** مرشّح الجوال: آخر ثمانية أرقام داخل أرقام الجوال (بعد ترجمة الهندية) — والحكم بعده لـnormImportPhone هنا */
const phonePredicate = (key: string): Prisma.Sql => Prisma.sql`(strpos(regexp_replace(translate(coalesce(phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), ${key.slice(-8)}) > 0)`;

/**
 * الاسم أو العنوان مطبَّعاً في SQL بجدول الطيّ نفسه (والحكم بعده لـfoldText). يسبقه حارس طولٍ رخيص يقيّمه PostgreSQL أوّلاً
 * (AND من اليسار): الطيّ لا يُطيل القيمة أبداً — translate حرفٌ بحرفٍ أو حذف، وضمّ المسافات وbtrim يقصّران — فما قصر خامُه عن
 * المفتاح لا يطابقه، ولا يُحسب له translate بجدوله الطويل
 */
const foldedPredicate = (column: 'name' | 'address', key: string): Prisma.Sql => {
  const col = column === 'name' ? Prisma.sql`name` : Prisma.sql`address`;
  return Prisma.sql`(length(${col}) >= ${pgLength(key)}::int AND btrim(regexp_replace(translate(coalesce(${col}, ''), ${SQL_FOLD_FROM}, ${SQL_FOLD_TO}), '[[:space:]]+', ' ', 'g')) = ${key})`;
};

/**
 * أوّل تكرارٍ في الشركة للحقول المفعَّلة بالترتيب: الجوال ثم الاسم ثم العنوان — أو null. القيمة الفارغة أو التافهة لا تُبحث،
 * و`exceptId` العميل نفسه عند التعديل.
 *
 * مسحٌ واحد لعملاء الشركة غير المحذوفين مهما كثرت الحقول المفعَّلة (شروطها بـOR)، مرتَّبٌ بأولوية الحقل الذي طابقه الصفّ ثم الأقدم —
 * لا ثلاثة مسوحٍ متتالية لشركةٍ كبيرة — ثم الحكم لكل حقلٍ بالترتيب بالتطبيع في JS على المرشّحين المعدودين
 */
export async function findCustomerDuplicate(
  tid: string, values: DedupValues, opts: { exceptId?: string | null; checks: DedupChecks },
): Promise<CustomerDuplicate | null> {
  const { checks, exceptId } = opts;
  const keys = {
    phone: checks.phone ? phoneKey(values.phone) : null,
    name: checks.name ? normalizeName(values.name) : null,
    address: checks.address ? normalizeAddress(values.address) : null,
  };
  const preds: Prisma.Sql[] = [];
  if (keys.phone) preds.push(phonePredicate(keys.phone));
  if (keys.name) preds.push(foldedPredicate('name', keys.name));
  if (keys.address) preds.push(foldedPredicate('address', keys.address));
  if (preds.length === 0) return null;
  // أولوية الصفّ: رتبة أوّل شرطٍ يطابقه (يُحسب للصفوف المطابقة وحدها بعد الترشيح) — رتبٌ ثابتة من الكود لا مدخل
  const rank = preds.length > 1
    ? Prisma.sql`CASE ${Prisma.join(preds.slice(0, -1).map((p, i) => Prisma.sql`WHEN ${p} THEN ${Prisma.raw(String(i))}`), ' ')} ELSE ${Prisma.raw(String(preds.length - 1))} END, `
    : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: string; name: string; phone: string | null; address: string | null }[]>`
    SELECT id, name, phone, address FROM customers
    WHERE "tenantId" = ${tid} AND status <> 'DELETED'
      ${exceptId ? Prisma.sql`AND id <> ${exceptId}` : Prisma.empty}
      AND (${Prisma.join(preds, ' OR ')})
    ORDER BY ${rank}"createdAt" ASC, id ASC
    LIMIT ${Prisma.raw(String(DEDUP_CANDIDATES_LIMIT))}`;
  const list = rows ?? [];
  const pick = (field: DedupField, same: (r: (typeof list)[number]) => boolean): CustomerDuplicate | null => {
    const hit = list.find(same);
    return hit ? { field, id: hit.id, name: hit.name } : null;
  };
  return (keys.phone ? pick('phone', (r) => normImportPhone(r.phone) === keys.phone) : null)
    ?? (keys.name ? pick('name', (r) => foldText(r.name) === keys.name) : null)
    ?? (keys.address ? pick('address', (r) => foldText(r.address) === keys.address) : null);
}

// ═══ الردّ ═══

const MESSAGES: Record<DedupField, { seen: (name: string) => string; hidden: string }> = {
  phone: { seen: (n) => `رقم الجوال مسجل للعميل «${n}»`, hidden: 'رقم الجوال مسجل لعميل آخر في الشركة' },
  name: { seen: (n) => `اسم العميل مسجل للعميل «${n}»`, hidden: 'يوجد عميل آخر بالاسم نفسه في الشركة' },
  address: { seen: (n) => `العنوان مسجل للعميل «${n}»`, hidden: 'يوجد عميل آخر بالعنوان نفسه في الشركة' },
};

/** جسم ردّ 409 — اسم العميل الآخر ومعرّفه لمن يراه وحده (canAccessCustomer): عزل عملاء المناديب لا يُكشف به عميلٌ غير مُسنَد */
export function customerDupBody(dup: CustomerDuplicate, canSee: boolean) {
  const m = MESSAGES[dup.field];
  return {
    success: false as const,
    code: CUSTOMER_DUPLICATE,
    field: dup.field,
    message: canSee ? m.seen(dup.name) : m.hidden,
    ...(canSee && { existingId: dup.id, existingName: dup.name }),
  };
}
