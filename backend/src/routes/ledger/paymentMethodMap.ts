import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { bookMode, isLinked, isManualBooks, postsFromOperations, type BookModeSettings } from '../../services/booksMode';
import {
  CUSTOM_METHOD_KEY_RE, DEFAULT_METHOD_LABELS, readPaymentMethodsConfig, type PaymentMethodsConfigV1,
} from '../../services/paymentMethodsCore';
import { appendAudit, ledgerActor, type GlActor } from '../../services/gl/audit';
import { POST_TX_OPTIONS } from '../../services/gl/autoPost';
import { ensureLinkedAccounts } from '../../services/gl/coa/linkedAccounts';
import { acquirePostLock } from '../../services/gl/post';
import { ACCOUNT_REF_SELECT, GlNotFoundError, accountRefFromRow, loadBuildContext, type GlDb } from '../../services/gl/resolve';
import { LINKED_METHOD_DEFAULTS, linkedMethodAccount } from '../../services/gl/builders/receipt';
import { resolveAccountTarget } from '../../services/gl/builders/customerAdjustment';
import {
  LedgerError, PAYMENT_METHOD_MAP_KEYS, isPaymentMethodMapKey,
  type AccountRef, type BuildContext, type MappingKey, type MethodAccountRef, type PaymentMethodMapKey,
} from '../../services/gl/types';

/**
 * «ربط الدفاتر» L5 — خريطة طرق الدفع والحسابات (العقد §5.9، D3، OD4/OD14، C2/C10؛ الواجهة: التهيئة ← المحاسبة ← «طرق الدفع والحسابات»).
 *
 * - `GET    /config/payment-methods`             الطرق الأساسية الست ثم المخصّصة (وصفوف يتيمة لطريقة لم تعد في الإعداد)، ولكلٍّ
 *                                                حسابها الافتراضي وصفّها المربوط والحساب الفعلي الذي يقيّد عليه السند للمربوطة.
 * - `PUT    /config/payment-methods/:methodKey`  {accountId, journalId?} — حساب نشط، نقد أو أصل متداول، غير رئيسي، وليس 911001 ولا 112005.
 * - `DELETE /config/payment-methods/:methodKey`  يعيد الافتراضي.
 * كلها canConfigureLedger، والكتابة تحت قفل الترحيل مع تدقيق MAPPING_CHANGE.
 *
 * الحساب الفعلي = linkedMethodAccount نفسه الذي يبني به السندُ قيدَه (مصدر واحد): صفّ المفتاح المخصّص ثم صفّ الأساس ثم الافتراضي
 * (النقد 111001، التحويل 111101 — OD14 لا 112001، نقطة البيع 112004، الشيك 112003، البطاقة 112007، توريد الأمانات 111101).
 * ONLINE غير قابل للربط (112005 بالرابط و911001 بدونه) فلا يظهر هنا.
 *
 * الدفاتر اليدوية: القراءة تعرض الطرق بلا إنشاء أي حساب، والكتابة 409 LEDGER_BOOKS_NOT_LINKED — الخريطة لا يقرؤها إلا الترحيل
 * الآلي، والشجرة اليدوية لا تُضاف إليها حسابات الربط (ensureLinkedAccounts للمربوطة المفعّلة وحدها).
 *
 * ويصدّر هذا الملف حارس OD4 (D4) الصرف الذي يستعمله ضبط الإعدادات (config.ts) والمعالج (setup.ts): التحويل ونقطة البيع لا
 * يمرّان بيد المندوب فلا يُوجَّهان إلى عهدته في الدفاتر التي يُرحِّل تشغيلُها قيوده.
 */
const router = Router();
const CONFIGURE = requireLedgerPermission('canConfigureLedger');

const locals = (res: Response) => res.locals.ledger as LedgerLocals;
const actorOf = (req: AuthRequest, res: Response): GlActor =>
  ledgerActor(locals(res), { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });

// ═══ OD4: لا عهدة لطريقة غير نقدية (صرف) ═══

/** طرق السند التي لا تمرّ بيد المندوب: المال في البنك أو عند مزوّد الجهاز (D4) */
export const NONCASH_ROUTING_METHODS = ['BANK_TRANSFER', 'POS'] as const;

export const ROUTING_CUSTODY_NONCASH_MESSAGE = 'لا تُوجَّه التحويلات البنكية ونقاط البيع إلى عهدة المندوب';

/** الطرق غير النقدية الموجَّهة إلى العهدة في receiptRouting (بالترتيب الثابت) */
export function custodyNonCashMethods(routing: unknown): string[] {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return [];
  const r = routing as Record<string, unknown>;
  return NONCASH_ROUTING_METHODS.filter((m) => r[m] === 'CUSTODY');
}

/** الحارس يعمل للدفاتر التي يُرحِّل تشغيلُها قيوده (مربوطة أو قديمة مفعّلة) — اليدوية وغير المفعّلة كما كانت حرفاً */
export function routingGuardApplies(s: BookModeSettings | null | undefined): boolean {
  return postsFromOperations(s);
}

/**
 * طريقة المعالج ستجعل الدفاتر مربوطة؟ تُقرأ كأنها مفعّلة (المعالج يسأل عمّا ستكون عليه بعد الاعتماد) عبر bookMode نفسه، فلا مقارنة
 * حرفية بطريقة الإعداد خارج services/booksMode.
 */
export function wizardLinksBooks(method: string | null | undefined): boolean {
  return isLinked({ setupMethod: method ?? null, activatedAt: WIZARD_ACTIVE_PROBE });
}
const WIZARD_ACTIVE_PROBE = new Date(0);

/** OD4: 422 LEDGER_ROUTING_CUSTODY_NONCASH {reason:'CUSTODY_NONCASH', methods} حين يعمل الحارس وفي التوجيه عهدة لطريقة غير نقدية */
export function assertRoutingCustodyCashOnly(routing: unknown, applies: boolean): void {
  if (!applies) return;
  const methods = custodyNonCashMethods(routing);
  if (methods.length) {
    throw new LedgerHttpError(422, ROUTING_CUSTODY_NONCASH_MESSAGE, { reason: 'CUSTODY_NONCASH', methods }, 'LEDGER_ROUTING_CUSTODY_NONCASH');
  }
}

// ═══ الطرق ═══

/** أسماء المفتاحين خارج طرق السند (البطاقة وتوريد الأمانات) — بلا اسم مزوّد بعينه */
export const MAP_ONLY_LABELS: Readonly<Record<'CARD' | 'PAYOUT', string>> = {
  CARD: 'الدفع بالبطاقة',
  PAYOUT: 'توريد أمانات الدفع الإلكتروني',
};

export interface MethodRow {
  methodKey: string;
  label: string;
  /** الأساس الذي يُكتب في Receipt.paymentMethod (المفتاح نفسه للأساسية) */
  base: string;
  custom: boolean;
  /** طريقة معطّلة في الإعداد، أو صفّ خريطة لطريقة لم تعد فيه */
  archived: boolean;
}

/** الطرق الأساسية الست بترتيب الخريطة ثم المخصّصة بترتيب الشركة (صرفة) */
export function methodRowsOf(config: PaymentMethodsConfigV1 | null): MethodRow[] {
  const out: MethodRow[] = PAYMENT_METHOD_MAP_KEYS.map((k) => {
    if (k === 'CARD' || k === 'PAYOUT') return { methodKey: k, label: MAP_ONLY_LABELS[k], base: k, custom: false, archived: false };
    const b = config?.builtins[k];
    return { methodKey: k, label: b?.label || DEFAULT_METHOD_LABELS[k], base: k, custom: false, archived: b ? !b.active : false };
  });
  for (const c of config?.custom ?? []) out.push({ methodKey: c.key, label: c.label, base: c.base, custom: true, archived: !c.active });
  return out;
}

export interface MapRow { methodKey: string; accountId: string; journalId: string | null }

export interface AccountBrief { id: string; code: string; name: string }

export interface MethodView extends MethodRow {
  defaultAccount: AccountBrief | null;
  accountId: string | null;
  account: AccountBrief | null;
  journalId: string | null;
  effective: AccountBrief | null;
}

const brief = (a: AccountRef | null | undefined): AccountBrief | null => (a ? { id: a.id, code: a.code, name: a.name } : null);

/** السياق مع صفوف الخريطة (للقراءة لكل وضع: سياق غير المربوطة لا يحمّل الخريطة) */
export function withMethodMaps(ctx: BuildContext, rows: readonly MapRow[]): BuildContext {
  const maps = new Map<string, MethodAccountRef>(rows.map((r) => [r.methodKey, { accountId: r.accountId, journalId: r.journalId ?? null }]));
  return { ...ctx, paymentMethodAccount: (k: string) => maps.get(k) ?? null };
}

/**
 * العرض (صرف): الافتراضي للأساسية هو حساب D3 الافتراضي، وللمخصّصة الحساب الفعلي لأساسها (صفّه أو افتراضيه)؛ والفعلي هو
 * linkedMethodAccount بعينه. صفّ خريطة لمفتاح لا يعرفه الإعداد يُلحق «مؤرشفاً» ليُحذف.
 */
export function methodViews(config: PaymentMethodsConfigV1 | null, rows: readonly MapRow[], ctx: BuildContext): MethodView[] {
  const mctx = withMethodMaps(ctx, rows);
  const rowOf = new Map(rows.map((r) => [r.methodKey, r]));
  const methods = methodRowsOf(config);
  const known = new Set(methods.map((m) => m.methodKey));
  for (const r of rows) {
    if (!known.has(r.methodKey)) methods.push({ methodKey: r.methodKey, label: r.methodKey, base: '', custom: true, archived: true });
  }
  return methods.map((m) => {
    const row = rowOf.get(m.methodKey) ?? null;
    let def: AccountRef | null = null;
    let eff: AccountRef | null = null;
    if (!m.custom) {
      const key = m.methodKey as PaymentMethodMapKey;
      def = resolveAccountTarget(LINKED_METHOD_DEFAULTS[key], ctx);
      const t = linkedMethodAccount({ method: key, card: key === 'CARD' }, mctx);
      eff = t ? resolveAccountTarget(t, ctx) : null;
    } else if (m.base) {
      const baseT = linkedMethodAccount({ method: m.base }, mctx);
      def = baseT ? resolveAccountTarget(baseT, ctx) : null;
      const t = linkedMethodAccount({ method: m.base, methodKey: m.methodKey }, mctx);
      eff = t ? resolveAccountTarget(t, ctx) : null;
    }
    return {
      ...m,
      defaultAccount: brief(def),
      accountId: row?.accountId ?? null,
      account: row ? brief(ctx.accounts.byId(row.accountId)) : null,
      journalId: row?.journalId ?? null,
      effective: brief(eff),
    };
  });
}

// ═══ التحقق ═══

/** حسابات لا تقبلها الخريطة بالربط مهما كان نوعها: المعلّق 911001 وأمانات الدفع الإلكتروني 112005 */
const FORBIDDEN_MAPPING_KEYS: readonly MappingKey[] = ['POSTING_SUSPENSE', 'PAYLINK_CLEARING'];
const FORBIDDEN_CODES = ['911001', '112005'] as const;
const METHOD_ACCOUNT_TYPES = ['asset_cash', 'asset_current'] as const;

export type MethodAccountProblem = 'ARCHIVED' | 'TYPE' | 'CONTROL' | 'FORBIDDEN';

const METHOD_ACCOUNT_MESSAGES: Readonly<Record<MethodAccountProblem, string>> = {
  ARCHIVED: 'الحساب مؤرشف',
  TYPE: 'حساب الطريقة يجب أن يكون حساب نقد أو بنك أو أصلاً متداولاً',
  CONTROL: 'لا يُربط بطريقة دفع حسابٌ رئيسي كذمم العملاء أو عهدة المندوب أو المستخدم',
  FORBIDDEN: 'لا تُربط طريقة دفع بالحساب المعلّق ولا بأمانات الدفع الإلكتروني',
};

/** سبب رفض حساب الطريقة (null = مقبول) — صرفة */
export function methodAccountProblem(a: AccountRef, forbiddenIds: ReadonlySet<string>): MethodAccountProblem | null {
  if (!a.isActive) return 'ARCHIVED';
  // الرقابي أولاً: السبب الأدقّ لذمم العملاء (asset_receivable) ولعهدة المندوب والمستخدم (asset_cash)
  if (a.controlKind !== null) return 'CONTROL';
  if (forbiddenIds.has(a.id) || (FORBIDDEN_CODES as readonly string[]).includes(a.code)) return 'FORBIDDEN';
  if (!(METHOD_ACCOUNT_TYPES as readonly string[]).includes(a.type)) return 'TYPE';
  return null;
}

export function methodAccountInvalid(problem: MethodAccountProblem, details: Record<string, unknown> = {}): LedgerHttpError {
  return new LedgerHttpError(422, METHOD_ACCOUNT_MESSAGES[problem], { reason: problem, ...details }, 'LEDGER_METHOD_ACCOUNT_INVALID');
}

/** مفتاح المسار: أساسي من الست أو مخصّص c_… (CUSTOM_METHOD_KEY_RE من نواة طرق الدفع — لا يُعرَّف ثانيةً) */
export function methodKeyOf(v: unknown): string {
  const k = typeof v === 'string' ? v.trim() : '';
  if (isPaymentMethodMapKey(k) || CUSTOM_METHOD_KEY_RE.test(k)) return k;
  throw new LedgerHttpError(400, 'مفتاح طريقة الدفع غير معروف', { reason: 'INVALID_METHOD_KEY', allowed: PAYMENT_METHOD_MAP_KEYS }, 'LEDGER_METHOD_KEY_INVALID');
}

export const methodMapBodySchema = z.object({
  accountId: z.string().trim().min(1).max(64),
  journalId: z.string().trim().min(1).max(64).nullish(),
}).strict();

function booksNotLinked(s: BookModeSettings | null): LedgerHttpError {
  return new LedgerHttpError(409, 'خريطة طرق الدفع للدفاتر المربوطة بالنظام', { reason: 'MANUAL_BOOKS', mode: bookMode(s) }, 'LEDGER_BOOKS_NOT_LINKED');
}

// ═══ القراءة ═══

type MapDb = GlDb;

async function companyMethodsConfig(db: Pick<MapDb, 'companySettings'>, tenantId: string): Promise<PaymentMethodsConfigV1 | null> {
  const cs = await db.companySettings.findUnique({ where: { tenantId }, select: { paymentMethodsConfig: true } });
  return readPaymentMethodsConfig(cs?.paymentMethodsConfig ?? null);
}

/** الردّ الكامل: قراءة الإعداد والسياق وصفوف الخريطة معاً (ثلاث قراءات متوازية بعد الإعدادات) */
export async function paymentMethodsPayload(db: MapDb, tenantId: string): Promise<{ linked: boolean; methods: MethodView[] }> {
  const s = await db.glSettings.findUnique({ where: { tenantId }, select: { setupMethod: true, activatedAt: true } });
  const linked = isLinked(s);
  // المربوطة: حسابات الربط (112007 …) تُنشأ عند الحاجة فيظهر افتراضي البطاقة — متساوي الأثر، استعلام واحد في الحالة المستقرة
  if (linked) await ensureLinkedAccounts(db, tenantId);
  const [lc, rows, config] = await Promise.all([
    loadBuildContext(db, tenantId),
    db.glPaymentMethodMap.findMany({ where: { tenantId }, select: { methodKey: true, accountId: true, journalId: true }, orderBy: { methodKey: 'asc' } }),
    companyMethodsConfig(db, tenantId),
  ]);
  return { linked, methods: methodViews(config, rows, lc.ctx) };
}

// ═══ المسارات ═══

router.get('/config/payment-methods', CONFIGURE, ledgerHandler(async (_req, res) => {
  const { tenantId } = locals(res);
  res.json({ success: true, data: await paymentMethodsPayload(prisma as unknown as MapDb, tenantId) });
}));

router.put('/config/payment-methods/:methodKey', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const methodKey = methodKeyOf(req.params.methodKey);
  const body = methodMapBodySchema.parse(req.body ?? {});
  const actor = actorOf(req, res);
  await prisma.$transaction(async (tx) => {
    await acquirePostLock(tx, tenantId);
    const s = await tx.glSettings.findUnique({ where: { tenantId }, select: { setupMethod: true, activatedAt: true } });
    if (!s) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'SETTINGS_MISSING' });
    if (isManualBooks(s)) throw booksNotLinked(s);
    if (!isPaymentMethodMapKey(methodKey)) {
      const config = await companyMethodsConfig(tx, tenantId);
      if (!config?.custom.some((c) => c.key === methodKey)) {
        throw new LedgerHttpError(404, 'طريقة الدفع غير موجودة', { reason: 'METHOD_NOT_FOUND', methodKey });
      }
    }
    if (isLinked(s)) await ensureLinkedAccounts(tx, tenantId);
    const [row, forbidden, current] = await Promise.all([
      tx.glAccount.findFirst({ where: { id: body.accountId, tenantId }, select: ACCOUNT_REF_SELECT }),
      tx.glAccountMapping.findMany({ where: { tenantId, key: { in: [...FORBIDDEN_MAPPING_KEYS] } }, select: { accountId: true } }),
      tx.glPaymentMethodMap.findUnique({ where: { tenantId_methodKey: { tenantId, methodKey } } }),
    ]);
    if (!row) throw new GlNotFoundError('GlAccount', body.accountId);
    const account = accountRefFromRow(row);
    const problem = methodAccountProblem(account, new Set(forbidden.map((f) => f.accountId)));
    if (problem) throw methodAccountInvalid(problem, { accountId: account.id, accountCode: account.code, methodKey });
    const journalId = body.journalId ?? null;
    if (journalId) {
      const j = await tx.glJournal.findFirst({ where: { id: journalId, tenantId }, select: { id: true, isActive: true, type: true } });
      if (!j) throw new GlNotFoundError('GlJournal', journalId);
      if (!j.isActive) throw new LedgerHttpError(422, 'الدفتر مؤرشف', { reason: 'JOURNAL_ARCHIVED', journalId }, 'LEDGER_METHOD_ACCOUNT_INVALID');
      if (j.type === 'SALE' || j.type === 'PURCHASE') {
        throw new LedgerHttpError(422, 'دفتر الطريقة يجب أن يكون دفتر نقد أو بنك أو عمليات عامة', { reason: 'JOURNAL_TYPE', journalId }, 'LEDGER_METHOD_ACCOUNT_INVALID');
      }
    }
    const data = { accountId: account.id, journalId, updatedBy: actor.actorId };
    const saved = await tx.glPaymentMethodMap.upsert({
      where: { tenantId_methodKey: { tenantId, methodKey } },
      create: { tenantId, methodKey, ...data },
      update: data,
    });
    if (current?.accountId !== saved.accountId || (current?.journalId ?? null) !== saved.journalId) {
      await appendAudit(tx, {
        tenantId, actor, action: 'MAPPING_CHANGE', entityType: 'MAPPING', entityId: saved.id,
        summary: `ربط طريقة الدفع ${methodKey} بالحساب ${account.code} ${account.name}`,
        before: current ? { methodKey, accountId: current.accountId, journalId: current.journalId } : null,
        after: { methodKey, accountId: saved.accountId, accountCode: account.code, journalId: saved.journalId },
      });
    }
  }, POST_TX_OPTIONS);
  res.json({ success: true, data: await paymentMethodsPayload(prisma as unknown as MapDb, tenantId) });
}));

router.delete('/config/payment-methods/:methodKey', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const methodKey = methodKeyOf(req.params.methodKey);
  const actor = actorOf(req, res);
  await prisma.$transaction(async (tx) => {
    await acquirePostLock(tx, tenantId);
    const s = await tx.glSettings.findUnique({ where: { tenantId }, select: { setupMethod: true, activatedAt: true } });
    if (!s) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'SETTINGS_MISSING' });
    if (isManualBooks(s)) throw booksNotLinked(s);
    const current = await tx.glPaymentMethodMap.findUnique({ where: { tenantId_methodKey: { tenantId, methodKey } } });
    if (!current) return; // الافتراضي قائم أصلاً — متساوي الأثر بلا تدقيق
    await tx.glPaymentMethodMap.delete({ where: { id: current.id } });
    await appendAudit(tx, {
      tenantId, actor, action: 'MAPPING_CHANGE', entityType: 'MAPPING', entityId: current.id,
      summary: `إعادة طريقة الدفع ${methodKey} إلى حسابها الافتراضي`,
      before: { methodKey, accountId: current.accountId, journalId: current.journalId }, after: null,
    });
  }, POST_TX_OPTIONS);
  res.json({ success: true, data: await paymentMethodsPayload(prisma as unknown as MapDb, tenantId) });
}));

export default router;
