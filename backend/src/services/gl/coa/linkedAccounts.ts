/**
 * حسابات «ربط الدفاتر» الإضافية (L5، العقد §3.3، القرار D2) — خارج القالب الافتراضي عمداً.
 *
 * لماذا خارج SA_6D_ACCOUNTS وMAPPING_KEYS؟ لأن إضافتها هناك تغيّر شجرة كل شركة يدوية جديدة (وتكسر gl-coa-template)،
 * والقاعدة أن الدفاتر اليدوية (CLEAN) لا يتغيّر سلوكها بايتاً. فتُنشأ هذه الحسابات عند الحاجة وحدها
 * (ensureLinkedAccounts: المُرحِّل لشركة مربوطة، ومسار خريطة الطرق)، وتشير إليها الـbuilders برمزها `accountCode`
 * (سابقة EMPLOYEE_ADVANCES_CODE = '113003')، فلا مفتاح ربط ولا صف GlAccountMapping لها.
 *
 * - 111004 عهدة تحصيلات مستخدمي الشركة: asset_cash وcontrolKind CUSTODY، وبُعدها adminUserId لا salesRepId
 *   (ثابت D2 في validate: سطر CUSTODY يحمل أحدهما لا كليهما) — فيرى C4 مجموع المناديب وC4u مجموع المستخدمين.
 * - 112007 تحصيلات البطاقة تحت التسوية: asset_current قابل للمطابقة — البطاقة لا تدخل العهدة أبداً (C4)،
 *   وتُقفل بمستند التسوية الموجّهة (CARD_SETTLEMENT).
 * - 214002 مستردات العملاء وأرصدتهم الدائنة: liability_current قابل للمطابقة — ردّ سند إلكتروني أُلغي يدوياً (C9)،
 *   ووجهة إعادة تصنيف أرصدة العملاء الدائنة في الميزانية.
 *
 * الحسابات مشتركة بين القالبين (GENERIC_6D بنفس رموز SA_6D)، والرموز غير مستعملة في أيٍّ منهما.
 */
import type { Prisma } from '@prisma/client';
import type { GlDb } from '../resolve';
import type { AccountRef, AccountType, ControlKind } from '../types';
import type { AccountTemplate, TemplateNames } from './sa';

export const USER_CUSTODY_CODE = '111004';
export const CARD_CLEARING_CODE = '112007';
export const CUSTOMER_CREDITS_CODE = '214002';

/** رموز الحسابات الثلاثة بترتيب الشجرة */
export const LINKED_EXTRA_ACCOUNT_CODES = [USER_CUSTODY_CODE, CARD_CLEARING_CODE, CUSTOMER_CREDITS_CODE] as const;
export type LinkedExtraAccountCode = (typeof LINKED_EXTRA_ACCOUNT_CODES)[number];

const n = (ar: string, en: string, fr: string, tr: string, zh: string): TemplateNames => ({ ar, en, fr, tr, zh });

/**
 * أوصاف الحسابات (م‑5): ما الذي يُسجَّل فيها بلغة محاسب منشأة صغيرة — بلا اسم مزوّد دفع بعينه
 * (طريقة البطاقة لأي شركة وأي مزوّد).
 */
export const LINKED_EXTRA_ACCOUNT_DESCRIPTIONS: Readonly<Record<LinkedExtraAccountCode, string>> = {
  '111004': 'النقد والشيكات التي استلمها مستخدمو الشركة من المناديب أو العملاء ولم يورّدوها بعد إلى الصندوق أو البنك، بكشف لكل مستخدم',
  '112007': 'مبالغ حصّلها المندوب ببطاقات الدفع على جهازه ولم يودعها مزوّد الدفع في حساب البنك بعد، تُقفل بمستند تسوية البطاقات',
  '214002': 'مبالغ مستحقة للعملاء: أرصدتهم الدائنة من المرتجعات والدفعات الزائدة، ومبالغ سندات إلكترونية أُلغيت وتنتظر الردّ',
};

/** مرادفات البحث (م‑1) — للمنتقي حين تُضاف إلى فهرس البحث */
export const LINKED_EXTRA_ACCOUNT_SYNONYMS: Readonly<Record<LinkedExtraAccountCode, readonly string[]>> = {
  '111004': ['عهدة المستخدم', 'تحصيلات المستخدمين', 'عهدة أمين الصندوق', 'استلام من المناديب'],
  '112007': ['تحصيل البطاقة', 'دفع بالبطاقة', 'تسوية البطاقات', 'بطاقات الجوال'],
  '214002': ['رصيد دائن للعميل', 'مستحق للعميل', 'ردّ للعميل', 'دفعة زائدة من العميل'],
};

interface LinkedAccOpts {
  type: AccountType;
  controlKind: ControlKind | null;
  reconcile: boolean;
  cashEquivalent: boolean;
}

function linkedAcc(code: LinkedExtraAccountCode, names: TemplateNames, o: LinkedAccOpts): AccountTemplate {
  return {
    code,
    parentCode: code.slice(0, 1),
    type: o.type,
    reconcile: o.reconcile,
    controlKind: o.controlKind,
    // بلا مفتاح ربط (D2): الـbuilders تشير إليها بالرمز
    mappingKeys: [],
    tags: [],
    cashFlowTag: o.cashEquivalent ? 'CASH_EQUIVALENT' : null,
    // نظامي: الـbuilders تعتمد رمزه، فلا يُحذف ولا يتغيّر رمزه أو نوعه (templateRef يقفل الرمز في PATCH /accounts)
    isSystem: true,
    isActive: true,
    templateRef: code,
    names,
    description: LINKED_EXTRA_ACCOUNT_DESCRIPTIONS[code],
  };
}

/** الحسابات الثلاثة بأسماء خمس لغات وأوصافها (كشكل SA_6D_ACCOUNTS) */
export const LINKED_EXTRA_ACCOUNTS: readonly AccountTemplate[] = [
  linkedAcc(USER_CUSTODY_CODE, n(
    'عهدة تحصيلات مستخدمي الشركة', 'Company Users Collections Custody', 'Encaissements en dépôt des utilisateurs',
    'Şirket Kullanıcıları Tahsilat Emaneti', '公司用户收款保管',
  ), { type: 'asset_cash', controlKind: 'CUSTODY', reconcile: false, cashEquivalent: true }),
  linkedAcc(CARD_CLEARING_CODE, n(
    'تحصيلات البطاقة تحت التسوية', 'Card Payments Clearing', 'Paiements par carte en compensation',
    'Kart Tahsilatları Mutabakat Hesabı', '银行卡收款待清算',
  ), { type: 'asset_current', controlKind: null, reconcile: true, cashEquivalent: true }),
  linkedAcc(CUSTOMER_CREDITS_CODE, n(
    'مستردات العملاء وأرصدتهم الدائنة', 'Customer Refunds and Credit Balances', 'Remboursements et soldes créditeurs clients',
    'Müşteri İadeleri ve Alacak Bakiyeleri', '客户退款及贷方余额',
  ), { type: 'liability_current', controlKind: null, reconcile: true, cashEquivalent: false }),
];

export function linkedAccountTemplate(code: string): AccountTemplate | null {
  return LINKED_EXTRA_ACCOUNTS.find((a) => a.code === code) ?? null;
}

/**
 * صرفة: الحسابات الثلاثة بشكل AccountRef لسياق في الذاكرة — للاختبارات (saContext({extraAccounts})) وللمعاينة الجافة
 * قبل إنشائها فعلاً. idOf يحدّد المعرّف (مثل accountIdOf في testing/fixtures).
 */
export function linkedAccountRefs(idOf: (code: string) => string): AccountRef[] {
  return LINKED_EXTRA_ACCOUNTS.map((a) => ({
    id: idOf(a.code), code: a.code, name: a.names.ar, type: a.type, isActive: a.isActive, reconcile: a.reconcile,
    controlKind: a.controlKind,
  }));
}

// ═══ الإنشاء متساوي الأثر ═══

/** حساب قائم برمز حساب ربط لكنه يخالفه — لا يُعدَّل (كالزرع: الموجود لا يُمسّ)، ويُبلَّغ ليصلحه المحاسب */
export interface LinkedAccountConflict {
  code: LinkedExtraAccountCode;
  accountId: string;
  reason: 'TYPE_MISMATCH' | 'CONTROL_KIND_MISMATCH' | 'ARCHIVED';
  type: string;
  controlKind: string | null;
  expectedType: AccountType;
  expectedControlKind: ControlKind | null;
}

export interface ExistingLinkedAccountRow {
  id: string;
  code: string;
  type: string;
  controlKind: string | null;
  isActive: boolean;
}

/**
 * صرفة: ما يُنشأ وما يتعارض من صفوف الشركة القائمة بالرموز الثلاثة. الحساب القائم بالرمز نفسه يُعدّ موجوداً أياً كان
 * (لا تكرار للرمز: @@unique([tenantId, code]))، ويُبلَّغ تعارضه إن خالف النوع أو controlKind أو كان مؤرشفاً.
 */
export function planLinkedAccounts(existing: readonly ExistingLinkedAccountRow[]): {
  toCreate: AccountTemplate[];
  conflicts: LinkedAccountConflict[];
} {
  const byCode = new Map(existing.map((r) => [r.code, r]));
  const toCreate: AccountTemplate[] = [];
  const conflicts: LinkedAccountConflict[] = [];
  for (const t of LINKED_EXTRA_ACCOUNTS) {
    const row = byCode.get(t.code);
    if (!row) { toCreate.push(t); continue; }
    const kind = row.controlKind ?? null;
    const reason: LinkedAccountConflict['reason'] | null = row.type !== t.type
      ? 'TYPE_MISMATCH'
      : kind !== (t.controlKind ?? null) ? 'CONTROL_KIND_MISMATCH' : !row.isActive ? 'ARCHIVED' : null;
    if (reason) {
      conflicts.push({
        code: t.code as LinkedExtraAccountCode, accountId: row.id, reason, type: row.type, controlKind: kind,
        expectedType: t.type, expectedControlKind: t.controlKind ?? null,
      });
    }
  }
  return { toCreate, conflicts };
}

/** صرفة: صفوف الإنشاء بشكل seedTemplate (الاسم العربي، والإنجليزي، وnameI18n، والوصف) */
export function linkedAccountCreateRows(tenantId: string, accounts: readonly AccountTemplate[]): Prisma.GlAccountCreateManyInput[] {
  return accounts.map((a) => ({
    tenantId, code: a.code, name: a.names.ar, nameEn: a.names.en, nameI18n: { ...a.names },
    description: a.description || null,
    type: a.type, reconcile: a.reconcile, isActive: a.isActive, isSystem: a.isSystem, controlKind: a.controlKind,
    cashFlowTag: a.cashFlowTag, templateRef: a.templateRef,
  }));
}

/** المندوب الذي يلمسه الإنشاء — المعاملة الحقيقية تستوفيه، والاختبار يمرّر مخزناً مزيّفاً بالشكل نفسه */
export type LinkedAccountsDb = Pick<GlDb, 'glAccount'>;

export interface EnsureLinkedAccountsResult {
  /**
   * الرموز التي كانت ناقصة عند القراءة وأُنشئت (في هذه المعاملة، أو في معاملة متزامنة سبقتها فتخطّاها skipDuplicates)
   * — غير الفارغة تعني: سياق البناء المحمَّل قبلها لا يعرفها، فيُعاد تحميله (loadBuildContext).
   */
  created: string[];
  /** حسابات قائمة بالرموز نفسها تخالف القالب — لا تُعدَّل؛ المُستدعي يعرضها (والترحيل عليها يقع على حساب الشركة كما هو) */
  conflicts: LinkedAccountConflict[];
}

/**
 * يُنشئ الناقص من الحسابات الثلاثة (بالرمز) في شجرة الشركة — متساوي الأثر، داخل معاملة المُستدعي، ولا يعدّل قائماً.
 * الكلفة: استعلام واحد بفهرس (tenantId, code) في الحالة المستقرة، وcreateMany واحد حين ينقص شيء.
 * لا فحص لوضع الدفاتر هنا: المُستدعي (المُرحِّل للمربوطة، ومسار خريطة الطرق) هو من يقرّر — اليدوية لا تصل إليه.
 */
export async function ensureLinkedAccounts(tx: LinkedAccountsDb, tenantId: string): Promise<EnsureLinkedAccountsResult> {
  if (!tenantId) throw new RangeError('ensureLinkedAccounts: tenantId مطلوب');
  const existing: ExistingLinkedAccountRow[] = await tx.glAccount.findMany({
    where: { tenantId, code: { in: [...LINKED_EXTRA_ACCOUNT_CODES] } },
    select: { id: true, code: true, type: true, controlKind: true, isActive: true },
  });
  const { toCreate, conflicts } = planLinkedAccounts(existing);
  if (toCreate.length) {
    await tx.glAccount.createMany({ data: linkedAccountCreateRows(tenantId, toCreate), skipDuplicates: true });
  }
  return { created: toCreate.map((a) => a.code), conflicts };
}
