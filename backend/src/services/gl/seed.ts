/**
 * زرع القالب متساوي الأثر (M2، DESIGN.md §4.5 «الزرع المتساوي الأثر»، §4.2–§4.4، §3.2، §6.1، §9.5 G2).
 *
 * «ابحث ثم أنشئ الناقص»: الحسابات بـ(tenantId, templateRef) ثم (tenantId, code)، والضرائب والربط بـ(tenantId, key)،
 * والدفاتر بـ(tenantId, code) ثم systemKey، والإعدادات بـtenantId — مع createMany({skipDuplicates: true}).
 * **الموجود لا يُعدَّل** في `seedTemplate` (لا update/upsert فيها)، والناقص يُنشأ، فلا P2002 على صفوف M2 المعدّلة أو اليدوية.
 * الاستثناء الوحيد `backfillAccountDescriptions` (م‑5): تملأ `description` **الفارغ وحده** لحسابات القالب، ولا تمسّ اسماً ولا وصفاً كتبه المستخدم.
 * رمز دفتر ناقص يتصادم مع رمز قائم أو بادئة مرتجعه ⇒ 409 LEDGER_JOURNAL_CODE_CONFLICT (journalCodeConflict).
 * يعمل داخل معاملة المُستدعي؛ والتدقيق (TEMPLATE_SEED/SETUP_COMMIT) على المُستدعي بتقرير الزرع.
 */
import type { Prisma } from '@prisma/client';
import { MAPPING_KEY_ALLOWED_TYPES, MAPPING_KEY_CONTROL_KIND, SA_6D_TEMPLATE, type ChartTemplate } from './coa/sa';
import { genericCountry, genericSettings, genericTemplate } from './coa/generic';
import { journalCodeConflict } from './sequence';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES, SA_ZERO_RATED_SALES_TAX_KEY, type TaxTemplate } from './taxes/sa';
import { LedgerError, type MappingKey, type TemplateKey } from './types';

/** المندوبات التي يلمسها الزرع — المعاملة الحقيقية تستوفيها، والاختبار يمرّر مخزناً مزيّفاً بالشكل نفسه. */
export type SeedDb = Pick<
  Prisma.TransactionClient,
  'glAccount' | 'glAccountTag' | 'glAccountTagLink' | 'glAccountMapping' | 'glJournal' | 'glTax' | 'glSettings'
>;

export interface SeedOptions {
  /** دولة القالب العام (إلزامية لـGENERIC_6D) */
  countryCode?: string;
  /** يتجاوز نسبة الدولة في القالب العام */
  vatPct?: number;
  /** قيم إضافية لصف GlSettings **عند إنشائه فقط** (المنطقة الزمنية، نهاية السنة، الدورية…) */
  settings?: Partial<Pick<Prisma.GlSettingsUncheckedCreateInput,
    'timezone' | 'fiscalYearEndMonth' | 'fiscalYearEndDay' | 'weekStartsOn' | 'taxPeriodicity' | 'taxDeadlineRule' | 'taxDeadlineDays'>>;
}

export interface SeedCounts {
  accounts: number;
  tags: number;
  tagLinks: number;
  journals: number;
  taxes: number;
  mappings: number;
  settings: number;
}

export interface SeedReport {
  templateKey: TemplateKey;
  created: SeedCounts;
  skipped: SeedCounts;
  /** مفاتيح ربط لم يُعثر على حسابها (نادر: حساب القالب محذوف ورمزه غير موجود) */
  unresolvedMappings: MappingKey[];
  /**
   * مفاتيح ربط لم تُنشأ لأن الحساب القائم برمز القالب لا يوافق نوع المفتاح أو حسابه الرئيسي
   * (القاعدة نفسها في PUT /mappings) — يُصلَح الحساب ثم يُعاد التحميل.
   */
  conflictingMappings: SeedMappingConflict[];
  /** مراجع حسابات الضرائب والدفاتر التي تُركت فارغة لأن الحساب القائم بالرمز يخالف نوع حساب القالب أو controlKind */
  conflictingAccountRefs: SeedAccountRefConflict[];
}

export interface SeedMappingConflict {
  key: MappingKey;
  accountId: string;
  code: string;
  type: string;
  controlKind: string | null;
  reason: 'MAPPING_TYPE_MISMATCH' | 'MAPPING_CONTROL_KIND';
}

export interface SeedAccountRefConflict {
  entity: 'TAX' | 'JOURNAL';
  /** مفتاح الضريبة أو رمز الدفتر */
  ref: string;
  field: 'accountId' | 'rcOutputAccountId' | 'defaultAccountId' | 'suspenseAccountId';
  accountId: string;
  code: string;
  type: string;
  controlKind: string | null;
  expectedType: string;
  expectedControlKind: string | null;
}

interface ResolvedTemplate {
  chart: ChartTemplate;
  taxes: readonly TaxTemplate[];
  settings: {
    templateKey: TemplateKey; countryCode: string; currency: string; currencyDecimals: number;
    taxDeadlineRule?: string; taxDeadlineDays?: number | null; zeroRatedSalesTaxKey: string | null;
  };
  defaultPurchaseTaxKey: string | null;
}

/** بيانات القالب الصرفة لمفتاحه (SA_6D، أو GENERIC_6D لدولة). */
export function resolveTemplate(templateKey: TemplateKey, opts: Pick<SeedOptions, 'countryCode' | 'vatPct'> = {}): ResolvedTemplate {
  if (templateKey === 'SA_6D') {
    const sa = genericCountry('SA');
    return {
      chart: SA_6D_TEMPLATE,
      taxes: SA_TAXES,
      settings: {
        templateKey: 'SA_6D', countryCode: 'SA', currency: sa.currency, currencyDecimals: sa.currencyDecimals,
        zeroRatedSalesTaxKey: SA_ZERO_RATED_SALES_TAX_KEY,
      },
      defaultPurchaseTaxKey: SA_DEFAULT_PURCHASE_TAX_KEY,
    };
  }
  if (templateKey === 'GENERIC_6D') {
    if (!opts.countryCode) throw new RangeError('GENERIC_6D يتطلب countryCode');
    const tpl = genericTemplate(opts.countryCode, { vatPct: opts.vatPct });
    const s = genericSettings(opts.countryCode, { vatPct: opts.vatPct });
    return {
      chart: tpl,
      taxes: tpl.taxes,
      settings: {
        templateKey: 'GENERIC_6D', countryCode: tpl.countryCode, currency: s.currency as string,
        currencyDecimals: s.currencyDecimals as number, taxDeadlineRule: s.taxDeadlineRule,
        taxDeadlineDays: s.taxDeadlineDays ?? null, zeroRatedSalesTaxKey: tpl.zeroRatedSalesTaxKey,
      },
      defaultPurchaseTaxKey: tpl.defaultPurchaseTaxKey,
    };
  }
  throw new RangeError(`قالب غير معروف: ${String(templateKey)}`);
}

const zero = (): SeedCounts => ({ accounts: 0, tags: 0, tagLinks: 0, journals: 0, taxes: 0, mappings: 0, settings: 0 });

type AccountKeyRow = { id: string; code: string; templateRef: string | null; type: string; controlKind: string | null };

const ACCOUNT_KEY_SELECT = { id: true, code: true, templateRef: true, type: true, controlKind: true } as const;

function accountIndex(rows: readonly AccountKeyRow[]) {
  const byRef = new Map<string, AccountKeyRow>();
  const byCode = new Map<string, AccountKeyRow>();
  for (const r of rows) {
    if (r.templateRef) byRef.set(r.templateRef, r);
    byCode.set(r.code, r);
  }
  /** الحساب لمرجع قالب: templateRef ثم الرمز */
  return (ref: string, code: string): AccountKeyRow | null => byRef.get(ref) ?? byCode.get(code) ?? null;
}

/**
 * يزرع القالب للشركة داخل db (معاملة Prisma أو مخزن مزيّف) متساوي الأثر.
 * الترتيب: الحسابات ⇒ الوسوم وروابطها ⇒ الدفاتر ⇒ الضرائب ⇒ مفاتيح الربط ⇒ الإعدادات.
 * الأخطاء: RangeError لقالب أو دولة غير معروفة، LedgerError LEDGER_JOURNAL_CODE_CONFLICT {code, conflictsWith}.
 */
export async function seedTemplate(db: SeedDb, tenantId: string, templateKey: TemplateKey, opts: SeedOptions = {}): Promise<SeedReport> {
  if (!tenantId) throw new RangeError('seedTemplate: tenantId مطلوب');
  const tpl = resolveTemplate(templateKey, opts);
  const created = zero();
  const skipped = zero();
  const where = { tenantId };

  // ── الحسابات ──
  const existingAccounts: AccountKeyRow[] = await db.glAccount.findMany({ where, select: ACCOUNT_KEY_SELECT });
  let findAccount = accountIndex(existingAccounts);
  const newAccountRefs = new Set<string>();
  const accountData: Prisma.GlAccountCreateManyInput[] = [];
  for (const a of tpl.chart.accounts) {
    if (findAccount(a.templateRef, a.code)) { skipped.accounts++; continue; }
    newAccountRefs.add(a.templateRef);
    accountData.push({
      tenantId, code: a.code, name: a.names.ar, nameEn: a.names.en, nameI18n: { ...a.names },
      description: a.description || null,
      type: a.type, reconcile: a.reconcile, isActive: a.isActive, isSystem: a.isSystem, controlKind: a.controlKind,
      cashFlowTag: a.cashFlowTag, templateRef: a.templateRef,
    });
  }
  if (accountData.length) {
    created.accounts = (await db.glAccount.createMany({ data: accountData, skipDuplicates: true })).count;
    findAccount = accountIndex(await db.glAccount.findMany({ where, select: ACCOUNT_KEY_SELECT }));
  }
  const accountOf = (code: string | null): AccountKeyRow | null => (code ? findAccount(code, code) : null);
  const accountIdOf = (code: string | null): string | null => accountOf(code)?.id ?? null;
  const tplAccountByCode = new Map(tpl.chart.accounts.map((a) => [a.code, a]));
  const conflictingAccountRefs: SeedAccountRefConflict[] = [];
  /**
   * مرجع حساب لضريبة أو دفتر: الحساب القائم بالرمز يوافق نوع حساب القالب وcontrolKind، وإلا يُترك null
   * ويُسجَّل التعارض (حساب يدوي برمز القالب قبل تحميله لا يُربط بصمت، I4/I5/I7).
   */
  const checkedAccountIdOf = (code: string | null, c: Pick<SeedAccountRefConflict, 'entity' | 'ref' | 'field'>): string | null => {
    const acc = accountOf(code);
    if (!acc || !code) return null;
    const t = tplAccountByCode.get(code);
    if (!t) return acc.id;
    const kind = acc.controlKind ?? null;
    if (acc.type === t.type && kind === (t.controlKind ?? null)) return acc.id;
    conflictingAccountRefs.push({
      ...c, accountId: acc.id, code: acc.code, type: acc.type, controlKind: kind, expectedType: t.type, expectedControlKind: t.controlKind ?? null,
    });
    return null;
  };

  // ── الوسوم (DRAWINGS…) وروابط الحسابات المنشأة الآن ──
  const tagNames = [...new Set(tpl.chart.accounts.flatMap((a) => a.tags))];
  if (tagNames.length) {
    const existingTags = await db.glAccountTag.findMany({ where, select: { id: true, name: true } });
    const have = new Set(existingTags.map((t) => t.name));
    const tagData = tagNames.filter((n) => !have.has(n)).map((name) => ({ tenantId, name, applicability: 'ACCOUNTS' }));
    skipped.tags = tagNames.length - tagData.length;
    let tags = existingTags;
    if (tagData.length) {
      created.tags = (await db.glAccountTag.createMany({ data: tagData, skipDuplicates: true })).count;
      tags = await db.glAccountTag.findMany({ where, select: { id: true, name: true } });
    }
    const tagId = new Map(tags.map((t) => [t.name, t.id]));
    const linkData: Prisma.GlAccountTagLinkCreateManyInput[] = [];
    for (const a of tpl.chart.accounts) {
      if (!a.tags.length || !newAccountRefs.has(a.templateRef)) continue;
      const accountId = accountIdOf(a.code);
      for (const t of a.tags) {
        const id = tagId.get(t);
        if (accountId && id) linkData.push({ tenantId, accountId, tagId: id });
      }
    }
    if (linkData.length) {
      created.tagLinks = (await db.glAccountTagLink.createMany({ data: linkData, skipDuplicates: true })).count;
    }
  }

  // ── الدفاتر ──
  const existingJournals = await db.glJournal.findMany({ where, select: { id: true, code: true, systemKey: true } });
  const codes = existingJournals.map((j) => j.code);
  const systemKeys = new Set(existingJournals.map((j) => j.systemKey).filter((k): k is string => !!k));
  const journalData: Prisma.GlJournalCreateManyInput[] = [];
  for (const j of tpl.chart.journals) {
    if (codes.includes(j.code) || systemKeys.has(j.systemKey)) { skipped.journals++; continue; }
    const conflict = journalCodeConflict(j.code, codes);
    if (conflict) throw new LedgerError('LEDGER_JOURNAL_CODE_CONFLICT', { code: j.code, conflictsWith: conflict, systemKey: j.systemKey });
    codes.push(j.code);
    journalData.push({
      tenantId, code: j.code, name: j.names.ar, nameEn: j.names.en, nameI18n: { ...j.names }, type: j.type,
      systemKey: j.systemKey,
      defaultAccountId: checkedAccountIdOf(j.defaultAccountCode, { entity: 'JOURNAL', ref: j.code, field: 'defaultAccountId' }),
      suspenseAccountId: checkedAccountIdOf(j.suspenseAccountCode, { entity: 'JOURNAL', ref: j.code, field: 'suspenseAccountId' }), useOutstandingAccounts: j.useOutstandingAccounts,
      sequenceReset: j.sequenceReset, showOnDashboard: j.showOnDashboard, isActive: true, isSystem: j.isSystem,
    });
  }
  if (journalData.length) {
    created.journals = (await db.glJournal.createMany({ data: journalData, skipDuplicates: true })).count;
  }

  // ── الضرائب ──
  const existingTaxes = await db.glTax.findMany({ where, select: { id: true, key: true } });
  const taxKeys = new Set(existingTaxes.map((t) => t.key).filter((k): k is string => !!k));
  const taxData: Prisma.GlTaxCreateManyInput[] = [];
  for (const t of tpl.taxes) {
    if (taxKeys.has(t.key)) { skipped.taxes++; continue; }
    taxData.push({
      tenantId, key: t.key, name: t.names.ar, nameEn: t.names.en, nameI18n: { ...t.names }, use: t.use, rate: t.rate,
      vatCategory: t.vatCategory, priceInclude: t.priceInclude,
      accountId: checkedAccountIdOf(t.accountCode, { entity: 'TAX', ref: t.key, field: 'accountId' }),
      rcOutputAccountId: checkedAccountIdOf(t.rcOutputAccountCode, { entity: 'TAX', ref: t.key, field: 'rcOutputAccountId' }), deductible: t.deductible, vatBox: t.vatBox,
      isActive: t.isActive, isSystem: true,
    });
  }
  let taxes = existingTaxes;
  if (taxData.length) {
    created.taxes = (await db.glTax.createMany({ data: taxData, skipDuplicates: true })).count;
    taxes = await db.glTax.findMany({ where, select: { id: true, key: true } });
  }

  // ── مفاتيح الربط ──
  const existingMappings = await db.glAccountMapping.findMany({ where, select: { key: true } });
  const mappedKeys = new Set(existingMappings.map((m) => m.key));
  const unresolvedMappings: MappingKey[] = [];
  const conflictingMappings: SeedMappingConflict[] = [];
  const mappingData: Prisma.GlAccountMappingCreateManyInput[] = [];
  for (const [key, code] of Object.entries(tpl.chart.mappings) as [MappingKey, string][]) {
    if (mappedKeys.has(key)) { skipped.mappings++; continue; }
    const acc = accountOf(code);
    if (!acc) { unresolvedMappings.push(key); continue; }
    // قواعد PUT /mappings نفسها: نوع مقبول للمفتاح، والحساب الرئيسي المتوقع
    const allowed = MAPPING_KEY_ALLOWED_TYPES[key] as readonly string[] | undefined;
    const kind = MAPPING_KEY_CONTROL_KIND[key];
    const reason: SeedMappingConflict['reason'] | null =
      allowed && !allowed.includes(acc.type) ? 'MAPPING_TYPE_MISMATCH'
        : kind && (acc.controlKind ?? null) !== kind ? 'MAPPING_CONTROL_KIND' : null;
    if (reason) {
      conflictingMappings.push({ key, accountId: acc.id, code: acc.code, type: acc.type, controlKind: acc.controlKind ?? null, reason });
      continue;
    }
    mappingData.push({ tenantId, key, accountId: acc.id });
  }
  if (mappingData.length) {
    created.mappings = (await db.glAccountMapping.createMany({ data: mappingData, skipDuplicates: true })).count;
  }

  // ── الإعدادات (تُنشأ فقط، لا تُعدَّل) ──
  const settings = await db.glSettings.findUnique({ where, select: { id: true } });
  if (settings) {
    skipped.settings = 1;
  } else {
    const purchaseTaxId = tpl.defaultPurchaseTaxKey ? taxes.find((t) => t.key === tpl.defaultPurchaseTaxKey)?.id ?? null : null;
    created.settings = (await db.glSettings.createMany({
      data: [{
        tenantId,
        templateKey: tpl.settings.templateKey,
        countryCode: tpl.settings.countryCode,
        currency: tpl.settings.currency,
        currencyDecimals: tpl.settings.currencyDecimals,
        zeroRatedSalesTaxKey: tpl.settings.zeroRatedSalesTaxKey,
        defaultPurchaseTaxId: purchaseTaxId,
        ...(tpl.settings.taxDeadlineRule ? { taxDeadlineRule: tpl.settings.taxDeadlineRule } : {}),
        ...(tpl.settings.taxDeadlineDays != null ? { taxDeadlineDays: tpl.settings.taxDeadlineDays } : {}),
        ...(opts.settings ?? {}),
      }],
      skipDuplicates: true,
    })).count;
  }

  return { templateKey, created, skipped, unresolvedMappings, conflictingMappings, conflictingAccountRefs };
}

// ═══ ملء أوصاف حسابات القالب للشركات المزروعة سلفاً (م‑5) ═══

export interface DescriptionBackfillReport {
  /** حسابات الشركة التي تحمل `templateRef` من القالب */
  scanned: number;
  /** حسابات كان وصفها فارغاً فمُلئ من القالب */
  filled: number;
  /** حسابات لها وصف (ربما كتبه المستخدم) فلم تُمسّ */
  kept: number;
}

/**
 * تملأ `GlAccount.description` **الفارغ وحده** من القالب لشركة مزروعة سلفاً (زرّ «إعادة تحميل القالب»).
 *
 * القواعد (اختبار gl-seed-idempotent يفرضها):
 *  1) المطابقة بـ`templateRef` وحده — الحساب اليدوي (templateRef=null) لا يُمسّ ولو وافق رمزه القالب.
 *  2) `description` غير الفارغ لا يُكتب فوقه أبداً (وصف المستخدم يعلو القالب، كما `name` في §8.7).
 *  3) لا يُكتب أيّ عمود آخر: لا الاسم ولا النوع ولا التفعيل — الوصف فقط.
 *  4) شرط التحديث يعيد قيمة الوصف كما قُرئت، فتعديلٌ متزامن يُبطل التحديث بدل أن يُدهَس.
 * متساوية الأثر: تشغيلها ثانيةً يملأ صفراً.
 */
export async function backfillAccountDescriptions(
  db: Pick<SeedDb, 'glAccount'>,
  tenantId: string,
  templateKey: TemplateKey,
  opts: Pick<SeedOptions, 'countryCode' | 'vatPct'> = {},
): Promise<DescriptionBackfillReport> {
  if (!tenantId) throw new RangeError('backfillAccountDescriptions: tenantId مطلوب');
  const tpl = resolveTemplate(templateKey, opts);
  const byRef = new Map(tpl.chart.accounts.map((a) => [a.templateRef, a.description]));
  const rows: { id: string; templateRef: string | null; description: string | null }[] = await db.glAccount.findMany({
    where: { tenantId, templateRef: { in: [...byRef.keys()] } },
    select: { id: true, templateRef: true, description: true },
  });
  const report: DescriptionBackfillReport = { scanned: rows.length, filled: 0, kept: 0 };
  for (const row of rows) {
    const description = row.templateRef ? byRef.get(row.templateRef) : undefined;
    if (!description || (row.description ?? '').trim() !== '') { report.kept++; continue; }
    // الشرط يضمّ القيمة المقروءة: لو كتب مستخدم وصفاً بين القراءة والكتابة فلا يُدهَس (count = 0)
    const res = await db.glAccount.updateMany({
      where: { tenantId, id: row.id, description: row.description },
      data: { description },
    });
    if (res.count > 0) report.filled++; else report.kept++;
  }
  return report;
}
