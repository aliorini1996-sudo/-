/**
 * «رقم العميل» (طلب المالك ٢٣ نوفمبر ٢٠٢٦): رقمٌ تسلسليّ لكل عميل داخل شركته يبدأ من ١ ويُبحث به في كل مكان
 * (التقارير وخطوط السير وكل منتقي عملاء) بدل الكود الآلي (cuid) الذي لا يحفظه أحد.
 *
 * القواعد:
 *  - الرقم لكل شركة على حدة، يمنحه الخادم وحده داخل معاملة الإنشاء نفسها — لا يُعدَّل ولا يُقبل من أي جسم طلب.
 *  - لا يُعاد استعماله أبداً: العدّاد Tenant.customerSeq لا ينقص، فحذف العميل يترك فجوة.
 *  - العملاء القدامى (null) يُرقَّمون أوّلاً بترتيب الإنشاء (createdAt ثم id) قبل منح رقمٍ جديد — فالقديم أصغر رقماً دائماً،
 *    والمسح الدوريّ (startCustomerNumberSweep) هو ترحيل النشر لكل الشركات وشبكة الأمان لأي عميلٍ فاته الترقيم.
 *  - هذا الملف وحده يُنشئ العملاء (createNumberedCustomer/createNumberedCustomers) — حارسٌ ثابت يمنع customer.create في غيره
 *    (tests/customer-number-guard.test.ts).
 *
 * ⚠️ لا @@unique على (tenantId, number): قيدٌ فريد على جدول customers الحامل لبيانات يُفشل db push بلا --accept-data-loss.
 * التفرّد يحرسه قفل صفّ الشركة: كل منحٍ للأرقام يمرّ تحته متسلسلاً.
 *
 * كل الاستعلامات $queryRaw بقوالب موسومة (لا $executeRaw) — فالبدائل المزيّفة في الاختبارات تكفيها $queryRaw تُعيد []،
 * ومعها لا رقم ويُنشأ العميل بلاه.
 */
import { Prisma, PrismaClient, Customer } from '@prisma/client';
import prisma from '../config/database';
import { customerCreatedInput, recordActivityInTx, type ActivityMeta } from './customerActivityEvents';

type Tx = Prisma.TransactionClient;

/**
 * «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦): هذا الملف وحده يُنشئ العملاء، فحدث إضافتهم يُكتب هنا في معاملة
 * الإنشاء نفسها — مرّةً واحدة أيّاً كان المسار. المعامل إلزاميّ في التوقيع: كل مستدعٍ يقرّر صراحةً — الفاعل والمصدر، أو null
 * حين يكتب الحدث بنفسه في المعاملة ذاتها (الاستيراد: دفعةً واحدة لكل شريحة).
 */
export interface CustomerCreationLog extends ActivityMeta {
  /** CUSTOMER_CREATED (الافتراضي) أو CUSTOMER_IMPORTED */
  action?: 'CUSTOMER_CREATED' | 'CUSTOMER_IMPORTED';
  /** تفاصيل إضافية في data (الوثائق المرفقة، المندوب المُسنَد…) */
  data?: Record<string, unknown> | null;
}

/** مهلة معاملة الإنشاء المرقَّم: انتظار القفل والترقيم الأوّل للقدامى قد يطول قليلاً بعد النشر */
export const CUSTOMER_NUMBER_TX: { maxWait: number; timeout: number } = { maxWait: 10_000, timeout: 30_000 };

/** أكبر رقم يحتمله عمود Int في Postgres (int4) */
export const CUSTOMER_NUMBER_MAX = 2147483647;

function assertTenant(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || !tenantId.trim()) throw new RangeError('customerNumber: tenantId مطلوب');
}

/**
 * قفل صفّ الشركة لمنح أرقام عملائها متسلسلةً. FOR NO KEY UPDATE لا FOR UPDATE: إدراج أي صفٍّ يشير إلى الشركة بمفتاح أجنبي
 * (فاتورة، سند، عميل…) يأخذ FOR KEY SHARE على صفّها — وهو لا يتعارض مع NO KEY UPDATE فلا ينتظر كاتبٌ آخر هذا القفل،
 * بينما FOR UPDATE كان سيوقف كل إدراجٍ للشركة حتى ينتهي الترقيم. وهو قفل tenant.update نفسه (routes/tenants.ts).
 */
export async function lockTenantForCustomerNumbers(tx: Tx, tenantId: string): Promise<void> {
  assertTenant(tenantId);
  await tx.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${tenantId} FOR NO KEY UPDATE`;
}

/**
 * الأساس تحت القفل: الأكبر من العدّاد وأعلى رقمٍ ممنوح فعلاً — فلا يُعاد رقمٌ حتى لو تأخّر العدّاد عن الأرقام.
 * MAX باستعلامٍ فرعيّ يمرّ على الفهرس (tenantId, number) بلا مسحٍ لكل عملاء الشركة. null ⇒ لا صفّ للشركة.
 */
async function readBase(tx: Tx, tenantId: string): Promise<number | null> {
  const rows = await tx.$queryRaw<{ base: number | bigint | null }[]>`SELECT GREATEST(t."customerSeq", COALESCE((SELECT MAX(c."number") FROM "customers" c WHERE c."tenantId" = t."id"), 0))::int AS "base" FROM "tenants" t WHERE t."id" = ${tenantId}`;
  const raw = Array.isArray(rows) ? rows[0]?.base : undefined;
  if (raw == null) return null;
  const base = Number(raw);
  return Number.isSafeInteger(base) && base >= 0 ? base : null;
}

/**
 * ترقيم القدامى بلا رقم بترتيب الإنشاء ابتداءً من base+1 — يُعيد عددهم (count) وأعلى رقمٍ صار ممنوحاً (top؛ base إن لم يُرقَّم شيء).
 * SQL خام عمداً: لا يلمس updatedAt، فلا يُعاد دفع كل عملاء الشركة لربط ERP ومزامنة API (services/apiSync.ts) دفعةً واحدة.
 *
 * ⚠️ top من الأرقام المُعادة فعلاً لا base+count: ROW_NUMBER من لقطة الاستعلام الفرعيّ، وفي READ COMMITTED يتخطّى UPDATE صفّاً
 * حذفته معاملةٌ أخرى وهو ينتظر قفله (DELETE /customers/:id يمسك FOR UPDATE على صفّ العميل طوال معاملته) — فقد يُمنح base+1 وbase+3
 * ويُتخطّى base+2، فيكون count=2 وأعلى رقمٍ base+3؛ وbase+count+1 كان سيكرّر base+3. الأكبر منهما آمنٌ دائماً (فجوةٌ لا تكرار)،
 * وbase+count يغطّي بديلاً مزيّفاً يُعيد المعرّف وحده.
 */
async function numberLegacy(tx: Tx, tenantId: string, base: number): Promise<{ count: number; top: number }> {
  const rows = await tx.$queryRaw<{ id: string; number: number | bigint | null }[]>`UPDATE "customers" AS c SET "number" = (${base}::int + o."rn")::int FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS "rn" FROM "customers" WHERE "tenantId" = ${tenantId} AND "number" IS NULL) AS o WHERE c."id" = o."id" RETURNING c."id", c."number"`;
  const list = Array.isArray(rows) ? rows : [];
  let top = base + list.length;
  for (const r of list) {
    const n = r?.number == null ? NaN : Number(r.number);
    if (Number.isSafeInteger(n) && n > top) top = n;
  }
  return { count: list.length, top };
}

/** حفظ العدّاد بـSQL خام فلا يتغيّر updatedAt الشركة */
async function persistSeq(tx: Tx, tenantId: string, seq: number): Promise<void> {
  if (seq > CUSTOMER_NUMBER_MAX) throw new RangeError('customerNumber: تجاوز العدّاد أكبر رقمٍ ممكن');
  await tx.$queryRaw`UPDATE "tenants" SET "customerSeq" = ${seq}::int WHERE "id" = ${tenantId} RETURNING "customerSeq"`;
}

/**
 * يرقّم عملاء الشركة القدامى بلا رقم (داخل معاملة المستدعي وتحت قفل الشركة) ويحفظ العدّاد — يُعيد عددهم.
 * آمنٌ للتكرار: الثانية لا تجد شيئاً فتُعيد ٠.
 */
export async function numberUnnumberedCustomers(tx: Tx, tenantId: string): Promise<number> {
  await lockTenantForCustomerNumbers(tx, tenantId);
  const base = await readBase(tx, tenantId);
  if (base == null) return 0;
  const { count, top } = await numberLegacy(tx, tenantId, base);
  if (count > 0) await persistSeq(tx, tenantId, top);
  return count;
}

/**
 * يحجز count رقماً متتالياً للشركة (بعد ترقيم قدامها أوّلاً) ويحفظ العدّاد — داخل معاملة المستدعي التي تُدرج العملاء.
 * فشل المعاملة يُرجع العدّاد معها فلا فجوة. [] حين لا صفّ للشركة (أو بديلٍ مزيّف في اختبار). count<=0 يرقّم القدامى ويُعيد [].
 */
export async function reserveCustomerNumbers(tx: Tx, tenantId: string, count: number): Promise<number[]> {
  const want = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  await lockTenantForCustomerNumbers(tx, tenantId);
  const base = await readBase(tx, tenantId);
  if (base == null) return [];
  // الجديد بعد أعلى رقمٍ مُعادٍ من ترقيم القدامى — لا base+عددهم (انظر numberLegacy)
  const legacy = await numberLegacy(tx, tenantId, base);
  const top = legacy.top;
  const first = top + 1;
  if (legacy.count > 0 || want > 0) await persistSeq(tx, tenantId, top + want);
  return Array.from({ length: want }, (_, i) => first + i);
}

/** بيانات العميل كما يرسلها المستدعي — tenantId اختياريّ فيها لأنه يُفرض من المعامل، وnumber يُهمل دائماً */
type CustomerCreateData = Omit<Prisma.CustomerUncheckedCreateInput, 'tenantId' | 'number'> & { tenantId?: string; number?: unknown };

function withNumber(tenantId: string, data: CustomerCreateData, n: number | undefined): Prisma.CustomerUncheckedCreateInput {
  // أي number في الجسم يُسقط: الرقم من الخادم وحده
  const { number: _ignored, ...rest } = data;
  return { ...rest, tenantId, ...(n != null ? { number: n } : {}) };
}

/**
 * الموضع الوحيد في الخادم الذي يُنشئ عميلاً: يحجز الرقم التالي ويُدرج العميل في معاملة المستدعي نفسها.
 * مثال: `await prisma.$transaction((tx) => createNumberedCustomer(tx, tid, data), CUSTOMER_NUMBER_TX)`.
 * الآثار الجانبية بالـprisma العام (الإسناد، إبطال التقديرات…) بعد الالتزام لا داخلها.
 */
export async function createNumberedCustomer(tx: Tx, tenantId: string, data: CustomerCreateData, log: CustomerCreationLog | null): Promise<Customer> {
  assertTenant(tenantId);
  const [n] = await reserveCustomerNumbers(tx, tenantId, 1);
  const created = await tx.customer.create({ data: withNumber(tenantId, data, n) });
  // «أرشيف العميل»: حدث الإضافة في المعاملة نفسها — يلتزم مع العميل أو يُلغى معه
  if (log) await recordActivityInTx(tx, customerCreatedInput(tenantId, created as unknown as Record<string, unknown> & { id: string }, log, { action: log.action, data: log.data }));
  return created;
}

/** إنشاء دفعة عملاء (الاستيراد): حجزٌ واحد لكتلة متتالية ثم إدراجٌ متسلسل بترتيب المُدخَل — يُعيد الصفوف المُنشأة بترتيبها */
export async function createNumberedCustomers(tx: Tx, tenantId: string, rows: CustomerCreateData[], log: CustomerCreationLog | null): Promise<Customer[]> {
  assertTenant(tenantId);
  if (!rows.length) return [];
  const nums = await reserveCustomerNumbers(tx, tenantId, rows.length);
  const out: Customer[] = [];
  for (let i = 0; i < rows.length; i++) out.push(await tx.customer.create({ data: withNumber(tenantId, rows[i], nums[i]) }));
  // «أرشيف العميل»: حدثٌ لكل عميل في إدراجٍ واحد (createMany) داخل المعاملة نفسها
  if (log) {
    await recordActivityInTx(tx, out.map((c) => customerCreatedInput(tenantId, c as unknown as Record<string, unknown> & { id: string }, log, { action: log.action ?? 'CUSTOMER_IMPORTED', data: log.data })));
  }
  return out;
}

/**
 * المسح: يرقّم القدامى بلا رقم لكل شركة في معاملةٍ قصيرة مستقلّة — ترحيل النشر وشبكة الأمان معاً. آمنٌ للتكرار وللتوازي بين
 * نسختين من الخادم (قفل الشركة يسلسلهما فلا تجد الثانية شيئاً). فشل شركةٍ يُسجَّل ولا يوقف البقيّة.
 * الاستعلام من الشركات بـEXISTS على الفهرس (tenantId, number) لا مسحٍ لجدول العملاء كله كل دورة.
 */
export async function sweepCustomerNumbers(db: PrismaClient = prisma): Promise<{ tenants: number; numbered: number }> {
  const rows = await db.$queryRaw<{ tenantId: string }[]>`SELECT t."id" AS "tenantId" FROM "tenants" t WHERE EXISTS (SELECT 1 FROM "customers" c WHERE c."tenantId" = t."id" AND c."number" IS NULL) LIMIT 500`;
  let tenants = 0;
  let numbered = 0;
  for (const { tenantId } of Array.isArray(rows) ? rows : []) {
    try {
      const k = await db.$transaction((tx) => numberUnnumberedCustomers(tx, tenantId), { maxWait: 10_000, timeout: 60_000 });
      if (k > 0) { tenants++; numbered += k; }
    } catch (e) {
      console.error('[customer-number] sweep tenant', tenantId, (e as Error).message);
    }
  }
  return { tenants, numbered };
}

/** الحلقة الدورية — تبدأ مع الخادم (index.ts) */
export function startCustomerNumberSweep(): void {
  if ((process.env.CUSTOMER_NUMBER_SWEEP_ENABLED || '').trim().toLowerCase() === 'false') return;
  let running = false;
  const tick = () => {
    if (running) return; // دورةٌ بطيئة لا تتداخل مع التالية
    running = true;
    sweepCustomerNumbers()
      .then((r) => { if (r.numbered > 0) console.log(`[customer-number] numbered ${r.numbered} customers in ${r.tenants} companies`); })
      .catch((e) => console.error('[customer-number] sweep:', (e as Error).message))
      .finally(() => { running = false; });
  };
  setTimeout(tick, 20 * 1000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}

// ————— البحث برقم العميل —————

/** الأرقام العربية-الهندية (٠-٩) والفارسية (۰-۹) إلى اللاتينية — خريطة محلية صغيرة (مطابقة لـweb-admin/src/lib/customerNumber.ts) */
const LOCAL_DIGITS: Record<string, string> = {};
for (let i = 0; i < 10; i++) {
  LOCAL_DIGITS[String.fromCharCode(0x0660 + i)] = String(i);
  LOCAL_DIGITS[String.fromCharCode(0x06f0 + i)] = String(i);
}

/**
 * نصّ البحث ⇒ رقم عميل أو null. القاعدة نفسها في الواجهة: يُقصّ، ثم تُنزع # (أو ＃) في أوّله والمسافات بعدها، وتُوحَّد الأرقام؛
 * ثم يجب أن يكون أرقاماً بلا صفرٍ بادئ (فبادئة الجوال «05» ليست رقم عميل — وإلا ثُبّت عميلٌ عشوائيّ أوّل القائمة مع كل جوالٍ يُكتب)
 * ولا يتجاوز CUSTOMER_NUMBER_MAX. غير النصّ ⇒ null.
 * إلا بعد #: «#007» و«#٠١٢» حشوٌ صريحٌ لرقم عميل لا جوال، فتُنزع أصفاره البادئة (7 و12)؛ و«#0» و«#000» صفرٌ لا رقم ⇒ null.
 */
export function customerNumberQuery(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  let s = t.replace(/^[#＃]\s*/, '').replace(/[٠-٩۰-۹]/g, (d) => LOCAL_DIGITS[d] ?? d);
  if (/^[#＃]/.test(t) && /^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
  if (!/^[1-9]\d{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= CUSTOMER_NUMBER_MAX ? n : null;
}

/** يُنشر في مصفوفة OR القائمة على العميل نفسه: [] أو [{ number: n }] — لا يمسّ الشروط الأخرى */
export function customerNumberOr(raw: unknown): Array<{ number: number }> {
  const n = customerNumberQuery(raw);
  return n == null ? [] : [{ number: n }];
}

/**
 * يُنشر في مصفوفة OR على كيانٍ يحمل علاقة customer (فاتورة، سند…): [] أو [{ customer: { tenantId, number: n } }].
 * tenantId إلزاميّ: Prisma 5 يحوّل شرط العلاقة إلى customerId IN (SELECT id FROM customers WHERE …) — ورقمٌ بلا شركة يمسح
 * عملاء كل الشركات (الفهرس (tenantId, number) لا يخدم الرقم وحده)، ومع الشركة يمرّ على الفهرس صفّاً واحداً.
 */
export function customerRelNumberOr(raw: unknown, tenantId: string): Array<{ customer: { tenantId: string; number: number } }> {
  const n = customerNumberQuery(raw);
  return n == null ? [] : [{ customer: { tenantId, number: n } }];
}

// ————— صاحب الرقم أوّلاً —————
// الأرقام تتبع ترتيب الإنشاء فالصغير للأقدم، و«12» تطابق كذلك كل جوالٍ (أو اسمٍ أو كود) يحويها — نحو ٨٪ من الجوالات. فبترتيب
// createdAt desc أو الاسم يسقط العميل #12 خارج الصفحة الأولى (١٥ في صفحة العملاء، ٢٠–١٠٠ في المنتقيات)، وترتيب الواجهة لا يُنقذه
// لأنه يرتّب ما أعاده الخادم وحده. فيُقرأ صاحب الرقم بالشرط نفسه (+ number) ويُقدَّم.

/**
 * بحثٌ مُقسَّم صفحات (skip/take): صاحب الرقم المطابق تماماً أوّل الصفحة الأولى، وبقيّة الصفحات مُزاحةٌ صفّاً واحداً بلاه — فلا يتكرّر
 * ولا يسقط صفّ. والمجموع (count بالشرط نفسه) لا يتغيّر: صاحب الرقم منه أصلاً.
 *  - findExact(n): صاحب الرقم **بالشرط نفسه** (الشركة والنطاق والحالة والبحث) مع number = n — أو null.
 *  - findPage(skip, take, notId): الصفحة بترتيبها المعتاد، بلا notId إن أُعطي.
 * نصٌّ ليس رقماً (أو skip/take غير صالحين) ⇒ findPage كما كان حرفياً بلا استعلامٍ زائد.
 */
export async function exactNumberFirstPage<T extends { id: string }>(o: {
  search: unknown;
  skip: number;
  take: number;
  findExact: (n: number) => Promise<T | null>;
  findPage: (skip: number, take: number, notId: string | null) => Promise<T[]>;
}): Promise<T[]> {
  const n = customerNumberQuery(o.search);
  const valid = Number.isSafeInteger(o.skip) && o.skip >= 0 && Number.isSafeInteger(o.take) && o.take > 0;
  if (n == null || !valid) return o.findPage(o.skip, o.take, null);
  const exact = await o.findExact(n);
  if (!exact) return o.findPage(o.skip, o.take, null);
  if (o.skip === 0) return o.take === 1 ? [exact] : [exact, ...(await o.findPage(0, o.take - 1, exact.id))];
  return o.findPage(o.skip - 1, o.take, exact.id);
}

/** نتائج محدودة بلا صفحات (المنتقيات): صاحب الرقم أوّلها ثم البقيّة بترتيبها بلا تكرار — بالحدّ نفسه (يُسقط الأخير إن زاد) */
export function hoistExactCustomer<T extends { id: unknown }>(rows: T[], exact: T | null | undefined, take: number): T[] {
  if (!exact) return rows;
  return [exact, ...rows.filter((r) => r.id !== exact.id)].slice(0, Math.max(1, take));
}
