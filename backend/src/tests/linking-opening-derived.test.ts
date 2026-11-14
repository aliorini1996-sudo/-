// «ربط الدفاتر» L2 — الافتتاح المشتقّ للدفاتر المربوطة (العقد scratchpad/l23_contract.md §11 و§17 P2، الخطة §2 القاعدة 7).
// بلا قاعدة: اختبار ذهبي يثبت أن كل استدعاء قائم بلا `derived` (الدفاتر اليدوية) يعطي النتيجة نفسها حرفياً قبل التعديل
// وبعده؛ وسطور المشتقّ بترتيبها وشركائها واستحقاقها و319002 = −(Σ المشتقّ + Σ اليدوي) وقيد يجتاز validateMove(SYSTEM)؛
// وDERIVED_ACCOUNT مع derivedAccounts وحده؛ وloadLinkedOpening على قاعدة مزيّفة للقراءة وحدها تحرس gl* والكتابة؛
// وعودة فحص C3 الفرعي للدفاتر المربوطة وحدها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import {
  LINKED_DERIVED_CONTROL_KINDS, LINKED_DERIVED_OPENING_KEYS, LINKED_MANUAL_BALANCE_ISSUES, MANUAL_BALANCE_ISSUES,
  buildOpeningMove, computeDerivedOpening, linkedOpeningLines, loadOpeningSources, openingCutoff, openingSnapshotFromDbNow,
  templatePreviewContext, validateManualBalanceRows,
  type DerivedOpening, type ManualBalanceRowInput, type OpeningMoveInput, type OpeningRouting,
} from '../services/gl/opening';
import { LINKED_OPENING_ID_CHUNK, inventoryRepIds, loadLinkedOpening } from '../services/gl/linking/openingLinked';
import { LINKED_DEFAULT_RECEIPT_ROUTING, type DerivedOpeningLinesInput } from '../services/gl/linking/types';
import type { LocationTotals } from '../services/costing/types';
import { c3OpeningEntriesEnabled, loadC3Input, runChecks, type CheckSettingsFacts, type CheckStore, type PendingPartners } from '../services/gl/checks/run';
import { OPENING_DELETED_WITHOUT_EVENT } from '../services/gl/checks/rules';
import type { CustodyComponentsInput } from '../services/gl/custody';
import { zonedStartOfDay } from '../services/gl/dates';
import { validateMove } from '../services/gl/validate';
import { accountIdOf, genericContext, saContext } from '../services/gl/testing/fixtures';
import type { BuildContext, LineDraft, Milli } from '../services/gl/types';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

// ═══ 1) الاختبار الذهبي: بلا `derived` النتيجة حرفياً كما قبل التعديل ═══

const GOLDEN_OPENING_DATE = '2026-12-31';

/** صفوف الأرصدة اليدوية للحالات الذهبية — بلا derived (السلوك القائم وحده) */
function goldenManualCases(): { name: string; ctx: () => BuildContext; rows: ManualBalanceRowInput[]; midVatPeriod: boolean }[] {
  return [
    {
      name: 'M1 مخالفات الأرصدة اليدوية (gl-opening)', ctx: () => saContext(), midVatPeriod: false,
      rows: [
        { accountCode: '113001', debit: 100 },
        { accountCode: '111003', debit: 100 },
        { accountCode: '112005', debit: 100 },
        { accountCode: '114001', debit: 100 },
        { accountCode: '113001', debit: 100, customerRef: 'مؤسسة النور' },
        { accountCode: '111003', debit: 100, salesRepName: 'حسام' },
        { accountCode: '319002', credit: 100 },
        { accountCode: '211001', credit: 100 },
        { accountCode: '212001', credit: 100 },
        { accountCode: '111101', debit: 100, credit: 5 },
        { accountCode: '999999', debit: 1 },
        { accountCode: '111101', debit: 0 },
      ],
    },
    {
      name: 'M2 داخل فترة مؤكَّدة', ctx: () => saContext(), midVatPeriod: true,
      rows: [{ accountCode: '212001', credit: '1,500.00' }, { accountCode: '114002', debit: 80, salesRepId: 'rep1' }],
    },
    {
      name: 'M3 كل الحسابات المشتقة وغيرها (لا DERIVED_ACCOUNT بلا الخيار)', ctx: () => saContext(), midVatPeriod: false,
      rows: [
        { accountCode: '113001', debit: 10, customerId: 'c1' },
        { accountCode: '111003', credit: 5, salesRepId: 'r1' },
        { accountCode: '112005', debit: '7.25' },
        { accountCode: '114001', debit: 12 },
        { accountCode: '114002', debit: 3, salesRepId: 'r2' },
        { accountCode: '116001', debit: 1 },
        { accountCode: '211001', credit: 9, vendorName: ' مصنع ', dueDate: '2027-03-01' },
        { accountCode: '211001', credit: 9, vendorId: 'v9', dueDate: '2027-13-01' },
        { accountCode: '111101', debit: -4 },
        { accountCode: '111101', debit: 'abc' },
        { accountCode: ' 311001 ', credit: 50, label: '  رأس المال  ' },
      ],
    },
    {
      name: 'M4 قالب عام بثلاث منازل (KW)', ctx: () => genericContext('KW'), midVatPeriod: false,
      rows: [{ accountCode: '111101', debit: '1.0005' }, { accountCode: '311001', credit: 1.0004 }, { accountCode: '212001', credit: 2 }],
    },
  ];
}

function goldenOpeningCases(): { name: string; input: () => OpeningMoveInput }[] {
  const ctxSa = () => saContext();
  const main = () => {
    const ctx = saContext();
    const manual = validateManualBalanceRows([
      { accountCode: '111101', debit: 20_000 },
      { accountCode: '311001', credit: 50_000 },
      { accountCode: '211001', credit: 3_000, vendorName: 'مصنع الخليج', dueDate: '2027-02-15' },
      { accountCode: '212002', credit: 1_200 },
      { accountCode: '113001', debit: 1_450, customerRef: 'مؤسسة النور' },
      { accountCode: '111003', debit: 750, salesRepId: 'rep1' },
      { accountCode: '112005', credit: 250 },
      { accountCode: '114001', debit: 90 },
    ], ctx, { midVatPeriod: false });
    manual.lines[2].vendorId = 'v1';
    manual.lines[4].customerId = 'c1';
    manual.lines[4].customerName = 'مؤسسة النور';
    return { ctx, lines: manual.lines };
  };
  return [
    { name: 'G1 القيد اليدوي الكامل (gl-opening)', input: () => { const m = main(); return { openingDate: GOLDEN_OPENING_DATE, manual: m.lines, ctx: m.ctx, salesRepNames: { rep1: 'حسام' } }; } },
    { name: 'G2 بلا مورّد', input: () => { const m = main(); return { openingDate: GOLDEN_OPENING_DATE, manual: m.lines.map((l) => ({ ...l, vendorId: null })), ctx: m.ctx }; } },
    { name: 'G3 ذمم بلا عميل محلول', input: () => { const m = main(); return { openingDate: GOLDEN_OPENING_DATE, manual: m.lines.map((l, i) => (i === 4 ? { ...l, customerId: null } : l)), ctx: m.ctx }; } },
    { name: 'G4 لا أرصدة (سياق القالب قبل الزرع)', input: () => ({ openingDate: GOLDEN_OPENING_DATE, manual: [], ctx: templatePreviewContext('SA_6D', 'SA') }) },
    { name: 'G5 لا أرصدة (saContext)', input: () => ({ openingDate: GOLDEN_OPENING_DATE, manual: [], ctx: ctxSa() }) },
    {
      name: 'G6 مخزون 114001 يدوي 220', input: () => {
        const ctx = ctxSa();
        return { openingDate: GOLDEN_OPENING_DATE, manual: validateManualBalanceRows([{ accountCode: '114001', debit: 220 }], ctx, { midVatPeriod: false }).lines, ctx };
      },
    },
    {
      name: 'G7 فرق مدين على 319002 (الدائن أكبر)', input: () => {
        const ctx = ctxSa();
        return { openingDate: '2027-06-30', manual: validateManualBalanceRows([{ accountCode: '311001', credit: '500.55' }, { accountCode: '111101', debit: 0.45 }], ctx, { midVatPeriod: false }).lines, ctx };
      },
    },
    {
      name: 'G8 متوازن بلا سطر 319002', input: () => {
        const ctx = ctxSa();
        return { openingDate: GOLDEN_OPENING_DATE, manual: validateManualBalanceRows([{ accountCode: '111101', debit: 100 }, { accountCode: '311001', credit: 100 }], ctx, { midVatPeriod: false }).lines, ctx };
      },
    },
    {
      name: 'G9 قالب عام بثلاث منازل (KW)', input: () => {
        const ctx = genericContext('KW');
        return { openingDate: '2026-03-31', manual: validateManualBalanceRows([{ accountCode: '111101', debit: '12.345' }, { accountCode: '311001', credit: '10.001' }], ctx, { midVatPeriod: false }).lines, ctx };
      },
    },
    {
      name: 'G10 تسميات وأسماء بديلة واستحقاق افتراضي', input: () => {
        const ctx = ctxSa();
        const v = validateManualBalanceRows([
          { accountCode: '211001', credit: 40, vendorName: 'مورّد بلا استحقاق' },
          { accountCode: '113001', debit: 25, customerId: 'c2' },
          { accountCode: '114002', debit: 30, salesRepId: 'rep9' },
          { accountCode: '111003', debit: 15, salesRepId: 'rep1', label: 'عهدة مدوّرة' },
          { accountCode: '121001', debit: 1000 },
        ], ctx, { midVatPeriod: false });
        v.lines[0].vendorId = 'v2';
        return { openingDate: GOLDEN_OPENING_DATE, manual: v.lines, ctx, salesRepNames: { rep1: '  ' } };
      },
    },
    {
      name: 'G11 قالب عام قبل الزرع (EG) بتاريخ آخر', input: () => {
        const ctx = templatePreviewContext('GENERIC_6D', 'EG');
        return { openingDate: '2025-12-31', manual: validateManualBalanceRows([{ accountCode: '111101', debit: '99.99' }, { accountCode: '311001', credit: '99.98' }], ctx, { midVatPeriod: false }).lines, ctx };
      },
    },
    {
      name: 'G12 ضريبة داخل فترة مؤكَّدة', input: () => {
        const ctx = ctxSa();
        return { openingDate: GOLDEN_OPENING_DATE, manual: validateManualBalanceRows([{ accountCode: '212001', credit: '1,500.00' }, { accountCode: '116001', debit: 300 }, { accountCode: '111101', debit: 1200 }], ctx, { midVatPeriod: true }).lines, ctx };
      },
    },
  ];
}

/** JSON قانوني: bigint نصّاً بلاحقة n، والتاريخ ISO، والمفاتيح مرتّبة، وundefined معلَّم — فلا يختفي مفتاح زائد */
function canonical(v: unknown): unknown {
  if (typeof v === 'bigint') return `${v.toString()}n`;
  if (v instanceof Date) return `date:${v.toISOString()}`;
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      out[k] = x === undefined ? '__undefined__' : canonical(x);
    }
    return out;
  }
  return v;
}

/** الحساب في سطر يدوي يُختصر إلى معرّفه ورمزه: الحالة الذهبية لسلوك التحقق لا لشكل AccountRef المشترك */
function manualView(r: { lines: { account: { id: string; code: string } }[]; issues: unknown[] }): unknown {
  return { issues: r.issues, lines: r.lines.map((l) => ({ ...l, account: { id: l.account.id, code: l.account.code } })) };
}

function fingerprint(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
}

/**
 * بصمات النتائج من opening.ts **قبل** إضافات L2 (الشجرة eea1e69 بلا تعديل) — مولَّدة بالحالات أعلاه حرفياً ومتحقَّق منها
 * بعد التعديل. تغيّرها = تغيّر سلوك الدفاتر اليدوية: ممنوع إلا بقرار صريح (والقيم المقروءة جوارها للتشخيص).
 */
const GOLDEN_OPENING: Record<string, { hash: string; lineCount: number; equity: string; totalDebit: string }> = {
  G1: { hash: 'bf29c21794d4b997abcf624a68fab8da67cc8729a2665265c9b352c6a8a59ec0', lineCount: 9, equity: '-32160000', totalDebit: '54450000' },
  G2: { hash: '1332d9e11dd7b0f88cf373dda433bd848dc105ac3691fb3693d7d5c1f613790e', lineCount: 9, equity: '-32160000', totalDebit: '54450000' },
  G3: { hash: '5706fe548cdbd189ef716ac402eb3b68da8ce6cb00d197455e81d347e0d2e55e', lineCount: 9, equity: '-32160000', totalDebit: '54450000' },
  G4: { hash: '07c329672d5911b287e74b7943757d8a791fa589c281691ec16e2245ad753004', lineCount: 0, equity: '0', totalDebit: '0' },
  G5: { hash: '07c329672d5911b287e74b7943757d8a791fa589c281691ec16e2245ad753004', lineCount: 0, equity: '0', totalDebit: '0' },
  G6: { hash: '14bbebc8e4c63fb63c1f6c78b35ee6000e2dce70a366d5b469c1beec3d89d5bb', lineCount: 2, equity: '220000', totalDebit: '220000' },
  G7: { hash: '3374845d5163ebb67113c82ca3b938658dbbb8859f14c6b682e8f0c3e86d1a90', lineCount: 3, equity: '-500100', totalDebit: '500550' },
  G8: { hash: '414c0e92e49659843ab92627c2c4b93639ea5e8fb3e3e7fa8d13b9a60fdc307b', lineCount: 2, equity: '0', totalDebit: '100000' },
  G9: { hash: '4351e3f8507c9a5fe7c4407d49687852b9395cfe6693466ca8a8d9897f5789f0', lineCount: 3, equity: '2344', totalDebit: '12345' },
  G10: { hash: '6a56849c02b94f1e4c5602db71cb691e8d37d09a854a01c50ff44bee190947da', lineCount: 6, equity: '1030000', totalDebit: '1070000' },
  G11: { hash: '7584ca36cd0da69922d9d21140191cb19994d0de8d2fd68e7f9d3e5da2301611', lineCount: 3, equity: '10', totalDebit: '99990' },
  G12: { hash: '37007b42cafba05dd5adfd141fe51eafa094aa0cc5fdfb175238ec3b28f9344e', lineCount: 3, equity: '0', totalDebit: '1500000' },
};

const GOLDEN_MANUAL: Record<string, { hash: string; reasons: string[]; lines: number }> = {
  M1: {
    hash: '09e91adf7099a4ce3c29e5f14c8b600a0b0c0535ef8fafc263bb266f2aa10252', lines: 4,
    reasons: ['CUSTOMER_REQUIRED', 'SALES_REP_REQUIRED', 'OPENING_EQUITY', 'VENDOR_REQUIRED', 'VAT_REQUIRES_MID_PERIOD', 'DEBIT_AND_CREDIT', 'ACCOUNT_NOT_FOUND', 'ZERO_AMOUNT'],
  },
  M2: { hash: 'db8b6021d3a3ea3326c8a6b8726b773b8f1ddf347996cdc4ba044b3ff38463a0', lines: 2, reasons: [] },
  M3: { hash: '5394f32726bf561f883a77ed8002d138535af2d64e391b78716adc4511a5aa3b', lines: 7, reasons: ['VAT_REQUIRES_MID_PERIOD', 'INVALID_DUE_DATE', 'NEGATIVE_AMOUNT', 'INVALID_AMOUNT'] },
  M4: { hash: '94b39ce2e2f2cbf550567386372a07b6b8aa0f7579581ac08db50e94fdf13fe4', lines: 2, reasons: ['ACCOUNT_ARCHIVED'] },
};

const caseKey = (name: string) => name.split(' ')[0];

test('ذهبي: buildOpeningMove بلا derived على 12 مدخلاً (منها كل حالات gl-opening) ⇒ النتيجة حرفياً كما قبل التعديل، ولا مفتاح مشتقّ', () => {
  const cases = goldenOpeningCases();
  assert.equal(cases.length, Object.keys(GOLDEN_OPENING).length);
  for (const c of cases) {
    const want = GOLDEN_OPENING[caseKey(c.name)];
    assert.ok(want, c.name);
    const r = buildOpeningMove(c.input());
    assert.deepEqual(
      { lineCount: r.lineCount, equity: String(r.equityDiffMilli), totalDebit: String(r.totalDebitMilli) },
      { lineCount: want.lineCount, equity: want.equity, totalDebit: want.totalDebit }, c.name,
    );
    assert.equal(fingerprint(r), want.hash, `${c.name}: ${JSON.stringify(canonical(r))}`);
    for (const k of ['derivedDebitMilli', 'derivedCreditMilli', 'derivedLineCount']) assert.ok(!(k in r), `${c.name}: ${k}`);
    // derived: null = الغياب حرفياً
    assert.equal(fingerprint(buildOpeningMove({ ...c.input(), derived: null })), want.hash, `${c.name} (derived: null)`);
  }
});

test('ذهبي: validateManualBalanceRows بلا derivedAccounts (وبـfalse) ⇒ المخالفات والسطور حرفياً كما قبل التعديل', () => {
  const cases = goldenManualCases();
  assert.equal(cases.length, Object.keys(GOLDEN_MANUAL).length);
  for (const c of cases) {
    const want = GOLDEN_MANUAL[caseKey(c.name)];
    for (const opts of [{ midVatPeriod: c.midVatPeriod }, { midVatPeriod: c.midVatPeriod, derivedAccounts: false }]) {
      const r = validateManualBalanceRows(c.rows, c.ctx(), opts);
      assert.deepEqual(r.issues.map((i) => i.reason), want.reasons, c.name);
      assert.equal(r.lines.length, want.lines, c.name);
      assert.equal(fingerprint(manualView(r)), want.hash, `${c.name}: ${JSON.stringify(canonical(manualView(r)))}`);
    }
  }
});

test('MANUAL_BALANCE_ISSUES لم تتغيّر (مرآة الويب) وDERIVED_ACCOUNT في ثابت منفصل بعدها (D12)', () => {
  assert.deepEqual([...MANUAL_BALANCE_ISSUES], [
    'ACCOUNT_NOT_FOUND', 'ACCOUNT_ARCHIVED', 'OPENING_EQUITY', 'EQUITY_UNAFFECTED', 'OFF_BALANCE',
    'VAT_REQUIRES_MID_PERIOD', 'VENDOR_REQUIRED', 'INVALID_AMOUNT', 'NEGATIVE_AMOUNT', 'DEBIT_AND_CREDIT', 'ZERO_AMOUNT',
    'INVALID_DUE_DATE', 'CUSTOMER_REQUIRED', 'CUSTOMER_NOT_FOUND', 'CUSTOMER_AMBIGUOUS', 'SALES_REP_REQUIRED', 'SALES_REP_NOT_FOUND',
    'SALES_REP_AMBIGUOUS',
  ]);
  assert.deepEqual([...LINKED_MANUAL_BALANCE_ISSUES], ['DERIVED_ACCOUNT']);
  // اختبار الويب setupLogic.test.ts يقرأ **أول** تطابق للنمط في opening.ts — يجب أن يبقى القائمة القديمة
  const src = read('services', 'gl', 'opening.ts');
  const first = /MANUAL_BALANCE_ISSUES\s*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? '';
  assert.deepEqual([...first.matchAll(/'(\w+)'/g)].map((m) => m[1]), [...MANUAL_BALANCE_ISSUES]);
  assert.ok(src.indexOf('export const MANUAL_BALANCE_ISSUES') < src.indexOf('export const LINKED_MANUAL_BALANCE_ISSUES'));
});

// ═══ 2) DERIVED_ACCOUNT ═══

test('DERIVED_ACCOUNT مع derivedAccounts وحده: الذمم والعهدة والأمانات والمخزون (بالنوع أو بالمفتاح) مرفوضة يدوياً، والبقية كما كانت', () => {
  const rows: ManualBalanceRowInput[] = [
    { accountCode: '113001', debit: 100, customerId: 'c1' },
    { accountCode: '111003', debit: 100, salesRepId: 'r1' },
    { accountCode: '112005', credit: 100 },
    { accountCode: '114001', debit: 100 },
    { accountCode: '114002', debit: 100, salesRepId: 'r1' },
    { accountCode: '114003', debit: 100 },
    { accountCode: '111101', debit: 100 },
    { accountCode: '211001', credit: 40, vendorName: 'مصنع الخليج' },
    { accountCode: '319002', credit: 1 },
    { accountCode: '113001', debit: 0 },
  ];
  const linked = validateManualBalanceRows(rows, saContext(), { midVatPeriod: false, derivedAccounts: true });
  assert.deepEqual(linked.issues.map((i) => [i.index, i.accountCode, i.reason]), [
    [0, '113001', 'DERIVED_ACCOUNT'], [1, '111003', 'DERIVED_ACCOUNT'], [2, '112005', 'DERIVED_ACCOUNT'],
    [3, '114001', 'DERIVED_ACCOUNT'], [4, '114002', 'DERIVED_ACCOUNT'],
    [8, '319002', 'OPENING_EQUITY'],
    // الحسابات المشتقة تُرفض قبل فحص المبلغ (ترتيب نسخة 0372543^)
    [9, '113001', 'DERIVED_ACCOUNT'],
  ]);
  assert.deepEqual(linked.lines.map((l) => l.account.code), ['114003', '111101', '211001']);
  // بلا الخيار: القبول القائم (الذمم بعميل، العهدة بمندوب، الأمانات والمخزون كحسابات عادية)
  const manual = validateManualBalanceRows(rows, saContext(), { midVatPeriod: false });
  assert.deepEqual(manual.issues.map((i) => i.reason), ['OPENING_EQUITY', 'ZERO_AMOUNT']);
  assert.ok(manual.issues.every((i) => i.reason !== 'DERIVED_ACCOUNT'));

  // بالمفتاح: حساب بلا نوع رئيسي أُعيد ربط INVENTORY_VAN إليه (114003) يُرفض، و114002 يبقى مرفوضاً بنوعه INVENTORY
  const remapped = validateManualBalanceRows(
    [{ accountCode: '114003', debit: 5 }, { accountCode: '114002', debit: 5 }],
    saContext({ mappings: { INVENTORY_VAN: '114003' } }), { midVatPeriod: false, derivedAccounts: true },
  );
  assert.deepEqual(remapped.issues.map((i) => [i.accountCode, i.reason]), [['114003', 'DERIVED_ACCOUNT'], ['114002', 'DERIVED_ACCOUNT']]);
  // بالنوع: حساب إضافي بنوع INVENTORY غير مربوط بمفتاح يُرفض كذلك
  const extra = validateManualBalanceRows([{ accountCode: '114009', debit: 5 }], saContext({
    extraAccounts: [{ id: 'acc_114009', code: '114009', name: 'مخزون فرعي', type: 'asset_current', isActive: true, reconcile: false, controlKind: 'INVENTORY' }],
  }), { midVatPeriod: false, derivedAccounts: true });
  assert.deepEqual(extra.issues.map((i) => i.reason), ['DERIVED_ACCOUNT']);
  assert.deepEqual([...LINKED_DERIVED_OPENING_KEYS], ['AR_CONTROL', 'REP_CUSTODY', 'PAYLINK_CLEARING', 'INVENTORY_WAREHOUSE', 'INVENTORY_VAN']);
  assert.deepEqual([...LINKED_DERIVED_CONTROL_KINDS], ['AR', 'CUSTODY', 'PAYLINK', 'INVENTORY']);
  // سياق القالب قبل الزرع (المعاينة) والقالب العام كذلك
  for (const ctx of [templatePreviewContext('SA_6D', 'SA'), genericContext('EG')]) {
    const v = validateManualBalanceRows([{ accountCode: '113001', debit: 1, customerId: 'c1' }, { accountCode: '114002', debit: 1 }, { accountCode: '111101', debit: 1 }], ctx, { midVatPeriod: false, derivedAccounts: true });
    assert.deepEqual(v.issues.map((i) => i.reason), ['DERIVED_ACCOUNT', 'DERIVED_ACCOUNT']);
  }

  // الجرد الدوري (derivedInventory: false): المخزون لا يُشتقّ فيُقبل يدوياً — بالمفتاح وبالنوع — والبقية مشتقّة كما هي
  const periodic = validateManualBalanceRows(rows, saContext(), { midVatPeriod: false, derivedAccounts: true, derivedInventory: false });
  assert.deepEqual(periodic.issues.map((i) => [i.index, i.accountCode, i.reason]), [
    [0, '113001', 'DERIVED_ACCOUNT'], [1, '111003', 'DERIVED_ACCOUNT'], [2, '112005', 'DERIVED_ACCOUNT'],
    [8, '319002', 'OPENING_EQUITY'], [9, '113001', 'DERIVED_ACCOUNT'],
  ]);
  assert.deepEqual(periodic.lines.map((l) => l.account.code), ['114001', '114002', '114003', '111101', '211001']);
  const periodicExtra = validateManualBalanceRows([{ accountCode: '114009', debit: 5 }, { accountCode: '114003', debit: 5 }], saContext({
    mappings: { INVENTORY_VAN: '114003' },
    extraAccounts: [{ id: 'acc_114009', code: '114009', name: 'مخزون فرعي', type: 'asset_current', isActive: true, reconcile: false, controlKind: 'INVENTORY' }],
  }), { midVatPeriod: false, derivedAccounts: true, derivedInventory: false });
  assert.deepEqual(periodicExtra.issues, []);
  // الافتراضي (بلا derivedInventory) = المخزون مشتقّ: لا تغيّر لأي مستدعٍ قائم
  assert.deepEqual(
    validateManualBalanceRows(rows, saContext(), { midVatPeriod: false, derivedAccounts: true, derivedInventory: true }).issues,
    linked.issues,
  );
});

// ═══ 3) السطور المشتقّة ═══

const OPENING_DATE = '2026-12-31';
const TZ = 'Asia/Riyadh';
const LINKED_FROM = '2027-01-01';
const DB_NOW = new Date('2027-01-15T09:00:00.000Z');
const T0 = openingSnapshotFromDbNow(DB_NOW);
const CUT = openingCutoff(LINKED_FROM, TZ, T0);

function derivedOpening(p: Partial<Pick<DerivedOpening, 'receivables' | 'custody' | 'paylinkHeldMilli'>>): DerivedOpening {
  const receivables = p.receivables ?? [];
  const custody = p.custody ?? [];
  return {
    cutoff: CUT,
    receivables, receivablesTotalMilli: receivables.reduce((s, r) => s + r.balanceMilli, 0n),
    custody, custodyTotalMilli: custody.reduce((s, c) => s + c.ledgerCustodyMilli, 0n),
    paylinkHeldMilli: p.paylinkHeldMilli ?? 0n,
    // حقل المستودع القديم مُهمَل في الربط: قيمة غير صفرية هنا يجب ألّا تظهر في القيد
    warehouse: { valueMilli: 999_990n, uncostedQty: 0, uncostedProducts: 0 },
    settlementSplits: {},
    counts: { accountEntriesIncluded: 0, accountEntriesExcluded: 0, settlementsIncluded: 0, settlementEntriesIncluded: 0, warehouseMovesIncluded: 0 },
  };
}

function custodyRow(salesRepId: string, salesRepName: string, ledgerCustodyMilli: Milli) {
  return {
    salesRepId, salesRepName, ledgerCustodyMilli, onlineUnclearedMilli: 0n, nonCustodyClearedMilli: 0n, suspenseClearedMilli: 0n,
    cashSalesOutsideCustodyMilli: 0n, opsOutstandingMilli: ledgerCustodyMilli,
  };
}

const loc = (location: LocationTotals['location'], qtyBase: number, valueMilli: Milli, uncostedQty = 0): LocationTotals => ({ location, qtyBase, uncostedQty, valueMilli });

/** المواقع من أمثلة العقد المحلولة §5 (ريال، منزلتان): و — المستودع 20 @ 115,000 والسيارة 10 @ 50,000؛ ب — سيارة R2
 *  6 @ 57,000 وقبلها الحفرة −4 @ −32,000؛ د — سيارة 2 مقيَّم @ 10,000 + 2 خارج التقييم */
const EXAMPLE_INVENTORY: LocationTotals[] = [
  loc('VAN:r3', 10, 50_000n),
  loc('VAN:_', 4, 10_000n, 2),
  loc('WH', 20, 115_000n),
  loc('VAN:rDel', -4, -32_000n),
  loc('VAN:r2', 6, 57_000n),
  loc('VAN:r1', 0, 0n),
];

test('linkedOpeningLines: الترتيب ذمم ⇐ عهدة ⇐ أمانات ⇐ المستودع ⇐ السيارات بمفتاح موقعها، بالشركاء والاستحقاق والتسميات، والأصفار تُتخطّى', () => {
  const d: DerivedOpeningLinesInput = {
    opening: derivedOpening({
      receivables: [
        { customerId: 'c2', customerName: 'بقالة الأمل', balanceMilli: 6_150n, rows: 3 },
        { customerId: 'c3', customerName: 'عميل دائن', balanceMilli: -50_000n, rows: 1 },
        { customerId: 'c0', customerName: 'عميل صفري', balanceMilli: 0n, rows: 2 },
      ],
      custody: [custodyRow('r1', 'حسام', 100_000n), custodyRow('r2', 'علي', 0n), custodyRow('r4', 'سالم', -20_000n)],
      paylinkHeldMilli: 379_500n,
    }),
    inventory: EXAMPLE_INVENTORY,
    salesRepNames: { r2: 'علي', r3: ' سعيد ' },
  };
  const r = linkedOpeningLines(d, OPENING_DATE);
  const view = (l: LineDraft) => [l.accountKey, l.label, String(l.debitMilli), String(l.creditMilli), l.customerId ?? null, l.salesRepId ?? null, l.partnerName ?? null, l.dueDate ?? null];
  assert.deepEqual(r.lines.map(view), [
    ['AR_CONTROL', 'رصيد افتتاحي — بقالة الأمل', '6150', '0', 'c2', null, 'بقالة الأمل', OPENING_DATE],
    ['AR_CONTROL', 'رصيد افتتاحي — عميل دائن', '0', '50000', 'c3', null, 'عميل دائن', OPENING_DATE],
    ['REP_CUSTODY', 'عهدة افتتاحية — حسام', '100000', '0', null, 'r1', 'حسام', null],
    ['REP_CUSTODY', 'عهدة افتتاحية — سالم', '0', '20000', null, 'r4', 'سالم', null],
    ['PAYLINK_CLEARING', 'أمانات الدفع الإلكتروني الافتتاحية', '379500', '0', null, null, null, null],
    ['INVENTORY_WAREHOUSE', 'مخزون المستودع الافتتاحي', '115000', '0', null, null, null, null],
    // VAN:_ بمعرّفه «_» (0x5F) قبل معرّفات الحروف الصغيرة — ترتيب compareLocations في المحرّك نفسه
    ['INVENTORY_VAN', 'بضاعة سيارات غير معروفة', '10000', '0', null, null, null, null],
    ['INVENTORY_VAN', 'بضاعة سيارة — علي', '57000', '0', null, 'r2', 'علي', null],
    ['INVENTORY_VAN', 'بضاعة سيارة — سعيد', '50000', '0', null, 'r3', 'سعيد', null],
    ['INVENTORY_VAN', 'بضاعة سيارة — مندوب rDel', '0', '32000', null, 'rDel', 'مندوب rDel', null],
  ]);
  // سطور الذمم بلا مفتاح vendorId؛ والحساب بالمفتاح وحده (يُحلّ من السياق، فيعمل على القالب قبل الزرع)
  assert.ok(r.lines.every((l) => !l.accountId && !l.accountCode && !('vendorId' in l)));
  assert.equal(r.debitMilli, 6_150n + 100_000n + 379_500n + 115_000n + 57_000n + 50_000n + 10_000n);
  assert.equal(r.creditMilli, 50_000n + 20_000n + 32_000n);
  // opening.warehouse (composeWarehouse القديم) لا يُستعمل أبداً
  assert.ok(!r.lines.some((l) => l.debitMilli === 999_990n));
  // PERIODIC: inventory = null ⇒ لا سطور مخزون؛ ولا شيء مشتقّ ⇒ لا سطور
  const periodic = linkedOpeningLines({ ...d, inventory: null }, OPENING_DATE);
  assert.equal(periodic.lines.filter((l) => l.accountKey === 'INVENTORY_WAREHOUSE' || l.accountKey === 'INVENTORY_VAN').length, 0);
  assert.deepEqual(linkedOpeningLines({ opening: derivedOpening({}), inventory: [] }, OPENING_DATE), { lines: [], debitMilli: 0n, creditMilli: 0n });
});

test('linkedOpeningLines: ترتيب نقاط الرموز لا اللغة، وتجميع الموقع المكرّر، والموقع المجهول الترميز يرمي (لا إسقاط صامت إلى 319002)', () => {
  const r = linkedOpeningLines({
    opening: derivedOpening({}),
    inventory: [loc('VAN:r2', 1, 30_000n), loc('VAN:_', 1, 5_000n), loc('VAN:r10', 1, 7_000n), loc('WH', 1, -100_000n),
      loc('VAN:r2', 1, 20_000n), loc('VAN:r9', 0, 0n), loc('VAN:r5', 1, 10_000n), loc('VAN:r5', -1, -10_000n), loc('VAN:R7', 1, 1_000n)],
  }, OPENING_DATE);
  assert.deepEqual(r.lines.map((l) => [l.salesRepId ?? l.accountKey, String(l.debitMilli - l.creditMilli)]), [
    ['INVENTORY_WAREHOUSE', '-100000'], ['R7', '1000'], ['INVENTORY_VAN', '5000'], ['r10', '7000'], ['r2', '50000'],
  ]);
  assert.equal(r.lines[0].creditMilli, 100_000n, 'مستودع بقيمة سالبة (حفرة) ⇒ دائن');
  for (const bad of ['X', 'VAN:', 'wh']) {
    assert.throws(() => linkedOpeningLines({ opening: derivedOpening({}), inventory: [loc(bad as LocationTotals['location'], 1, 1_000n)] }, OPENING_DATE), RangeError, bad);
  }
});

test('buildOpeningMove مع derived: المشتقّ أولاً ثم اليدوي ثم 319002 = −(Σ المشتقّ + Σ اليدوي)، متوازن ويجتاز validateMove(SYSTEM) على كل سياق', () => {
  const d: DerivedOpeningLinesInput = {
    opening: derivedOpening({
      receivables: [{ customerId: 'c1', customerName: 'مؤسسة النور', balanceMilli: 750_000n, rows: 2 }, { customerId: 'c3', customerName: 'عميل دائن', balanceMilli: -50_000n, rows: 1 }],
      custody: [custodyRow('r1', 'حسام', 100_000n)],
      paylinkHeldMilli: 379_500n,
    }),
    inventory: EXAMPLE_INVENTORY,
    salesRepNames: { r2: 'علي', r3: 'سعيد' },
  };
  for (const ctx of [saContext(), templatePreviewContext('SA_6D', 'SA'), genericContext('EG')]) {
    const manual = validateManualBalanceRows([
      { accountCode: '111101', debit: 20_000 },
      { accountCode: '311001', credit: 15_000 },
      { accountCode: '211001', credit: 3_000, vendorName: 'مصنع الخليج', dueDate: '2027-02-15' },
    ], ctx, { midVatPeriod: false, derivedAccounts: true });
    assert.equal(manual.issues.length, 0);
    manual.lines[2].vendorId = 'v1';
    const res = buildOpeningMove({ openingDate: OPENING_DATE, manual: manual.lines, ctx, salesRepNames: {}, derived: d });
    const draft = res.draft!;
    const derivedCount = 2 + 1 + 1 + 5;
    assert.equal(res.derivedLineCount, derivedCount);
    assert.equal(res.lineCount, derivedCount + 3 + 1);
    assert.equal(draft.lines.length, res.lineCount);
    // الترتيب: المشتقّ (بمفاتيحه) ثم اليدوي (بمعرّفاته) ثم 319002
    assert.deepEqual(draft.lines.slice(0, derivedCount).map((l) => l.accountKey), [
      'AR_CONTROL', 'AR_CONTROL', 'REP_CUSTODY', 'PAYLINK_CLEARING', 'INVENTORY_WAREHOUSE', 'INVENTORY_VAN', 'INVENTORY_VAN', 'INVENTORY_VAN', 'INVENTORY_VAN',
    ]);
    assert.deepEqual(draft.lines.slice(derivedCount, derivedCount + 3).map((l) => l.accountId), manual.lines.map((l) => l.account.id));
    const eq = draft.lines[draft.lines.length - 1];
    assert.equal(eq.accountKey, 'OPENING_EQUITY');
    // Σ المشتقّ = 750 − 50 + 100 + 379.50 + 115 + 57 + 50 − 32 + 10 = 1,379.50؛ Σ اليدوي = 20,000 − 15,000 − 3,000 = 2,000
    assert.equal(res.derivedDebitMilli, 750_000n + 100_000n + 379_500n + 115_000n + 57_000n + 50_000n + 10_000n);
    assert.equal(res.derivedCreditMilli, 50_000n + 32_000n);
    assert.equal(res.derivedDebitMilli! - res.derivedCreditMilli!, 1_379_500n);
    assert.equal(res.equityDiffMilli, 1_379_500n + 2_000_000n);
    assert.deepEqual([eq.debitMilli, eq.creditMilli], [0n, 3_379_500n]);
    assert.equal(res.manualDebitMilli, 20_000_000n);
    assert.equal(res.manualCreditMilli, 18_000_000n);
    const dr = draft.lines.reduce((s, l) => s + l.debitMilli, 0n);
    const cr = draft.lines.reduce((s, l) => s + l.creditMilli, 0n);
    assert.equal(dr, cr);
    assert.equal(res.totalDebitMilli, dr);
    assert.equal(draft.date, OPENING_DATE);
    assert.deepEqual([draft.moveType, draft.journalSystemKey, draft.origin, draft.sourceKey], ['OPENING', 'OPENING', 'AUTO', null]);
    const v = validateMove(draft, ctx, { mode: 'SYSTEM' });
    assert.equal(v.totalDebitMilli, v.totalCreditMilli);
    // الحسابات المحلولة: 113001 بعميله، 111003 بمندوبه، 114002 بمندوبه (والمجهولة بلا مندوب)
    const codes = v.lines.map((l) => l.account.code);
    assert.deepEqual(codes.slice(0, derivedCount), ['113001', '113001', '111003', '112005', '114001', '114002', '114002', '114002', '114002']);
    assert.equal(codes[codes.length - 1], '319002');
  }
});

test('buildOpeningMove مع derived: الفرق المدين على 319002، والمشتقّ وحده بلا يدوي، والمشتقّ الفارغ = القيد اليدوي نفسه بحقول صفرية', () => {
  const ctx = saContext();
  // دائن مشتقّ أكبر (حفرة مستودع) ⇒ 319002 مدين ويُضاف إلى totalDebit
  const credit = buildOpeningMove({
    openingDate: OPENING_DATE, manual: [], ctx,
    derived: { opening: derivedOpening({ receivables: [{ customerId: 'c3', customerName: 'عميل دائن', balanceMilli: -50_000n, rows: 1 }] }), inventory: [loc('WH', -4, -32_000n)] },
  });
  assert.equal(credit.lineCount, 3);
  assert.equal(credit.equityDiffMilli, -82_000n);
  const eq = credit.draft!.lines[2];
  assert.deepEqual([eq.accountKey, eq.debitMilli, eq.creditMilli], ['OPENING_EQUITY', 82_000n, 0n]);
  assert.equal(credit.totalDebitMilli, 82_000n);
  assert.deepEqual([credit.derivedDebitMilli, credit.derivedCreditMilli, credit.derivedLineCount, credit.manualDebitMilli, credit.manualCreditMilli], [0n, 82_000n, 2, 0n, 0n]);
  assert.doesNotThrow(() => validateMove(credit.draft!, ctx, { mode: 'SYSTEM' }));

  // المشتقّ الفارغ: لا قيد إن لم يكن يدوي، والحقول حاضرة صفرية
  const empty = buildOpeningMove({ openingDate: OPENING_DATE, manual: [], ctx, derived: { opening: derivedOpening({}), inventory: null } });
  assert.deepEqual(
    [empty.draft, empty.lineCount, empty.equityDiffMilli, empty.totalDebitMilli, empty.derivedDebitMilli, empty.derivedCreditMilli, empty.derivedLineCount],
    [null, 0, 0n, 0n, 0n, 0n, 0],
  );
  // مع يدوي: القيد حرفياً كقيد اليدوي وحده
  for (const c of goldenOpeningCases()) {
    const base = buildOpeningMove(c.input());
    const withEmpty = buildOpeningMove({ ...c.input(), derived: { opening: derivedOpening({}), inventory: [loc('WH', 0, 0n)] } });
    assert.equal(fingerprint(withEmpty.draft), fingerprint(base.draft), c.name);
    assert.deepEqual([withEmpty.derivedLineCount, withEmpty.derivedDebitMilli, withEmpty.derivedCreditMilli], [0, 0n, 0n]);
  }
});

// ═══ 4) loadLinkedOpening على قاعدة مزيّفة للقراءة وحدها ═══

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const timeOf = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' ? new Date(v).getTime() : Number(v));

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      for (const op of Object.keys(c)) {
        if (!['in', 'not', 'lt', 'lte', 'gt', 'gte'].includes(op)) throw new Error(`مرشّح غير مدعوم في الفايك: ${k}.${op}`);
      }
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      if ('not' in c && (c.not === null ? v === null || v === undefined : v === c.not)) return false;
      if ('lt' in c && !(timeOf(v) < timeOf(c.lt))) return false;
      if ('lte' in c && !(timeOf(v) <= timeOf(c.lte))) return false;
      if ('gt' in c && !(timeOf(v) > timeOf(c.gt))) return false;
      if ('gte' in c && !(timeOf(v) >= timeOf(c.gte))) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

function pick(row: Row, select: Record<string, unknown> | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) if (on === true) out[k] = row[k];
  return out;
}

interface FakeTables {
  accountEntry: Row[]; invoice: Row[]; receipt: Row[]; repSettlement: Row[]; settlementEntry: Row[]; customer: Row[]; salesRep: Row[];
}

interface FakeCall { model: string; args: { where?: Where; select?: Record<string, unknown> } }

/**
 * قاعدة تشغيلية مزيّفة للقراءة وحدها: findMany بمرشّحات Prisma المستعملة، وأي كتابة أو وصول gl* أو $raw أو مندوب
 * غير معروف يرمي ويُحصى (كالعميل الحارس في المعاينة: SHADOW_GL_ACCESS) — فالنجاح نفسه دليل «لا كتابة ولا gl*».
 */
function fakeDb(t: FakeTables) {
  const calls: FakeCall[] = [];
  const violations: string[] = [];
  const delegate = (model: keyof FakeTables) => new Proxy({}, {
    get(_o, method: string) {
      if (method !== 'findMany') {
        violations.push(`${model}.${method}`);
        throw new Error(`كتابة/طريقة ممنوعة في الفايك: ${model}.${method}`);
      }
      return async (args: FakeCall['args']) => {
        calls.push({ model, args });
        const rows = t[model].filter((r) => matches(r, args.where));
        if (model === 'accountEntry') {
          // select { invoice: { select: { type: true } } } — العلاقة من جدول الفواتير
          return rows.map((r) => {
            const out = pick(r, Object.fromEntries(Object.entries(args.select ?? {}).filter(([, v]) => v === true)));
            if (args.select && 'invoice' in args.select) {
              const inv = r.invoiceId ? t.invoice.find((i) => i.id === r.invoiceId && i.tenantId === r.tenantId) : null;
              out.invoice = inv ? { type: inv.type } : null;
            }
            return out;
          });
        }
        return rows.map((r) => pick(r, args.select));
      };
    },
  });
  const db = new Proxy({}, {
    get(_o, prop: string) {
      if (prop === 'then') return undefined;
      if (prop in t) return delegate(prop as keyof FakeTables);
      violations.push(prop);
      throw new Error(prop.startsWith('gl') ? `SHADOW_GL_ACCESS: ${prop}` : `وصول غير متوقَّع في الفايك: ${prop}`);
    },
  }) as unknown as Prisma.TransactionClient;
  return { db, calls, violations };
}

const at = (iso: string) => new Date(iso);
let aeSeq = 0;
function ae(tenantId: string, customerId: string, type: string, amount: { debit?: number; credit?: number }, entryDate: string, createdAt = entryDate, links: { invoiceId?: string; receiptId?: string } = {}): Row {
  return {
    id: `ae${++aeSeq}`, tenantId, customerId, invoiceId: links.invoiceId ?? null, receiptId: links.receiptId ?? null, type,
    debit: amount.debit ?? 0, credit: amount.credit ?? 0, entryDate: at(entryDate), createdAt: at(createdAt),
  };
}

/** شركة t1 قبل الربط (linkedFrom 2027-01-01 بتوقيت الرياض، T0 = dbNow − 10 دقائق) + ضجيج شركة t2 */
function linkedTables(): FakeTables {
  return {
    customer: [
      { id: 'c1', tenantId: 't1', name: 'مؤسسة النور' }, { id: 'c2', tenantId: 't1', name: 'بقالة الأمل' }, { id: 'c3', tenantId: 't1', name: 'عميل دائن' },
      { id: 'cx', tenantId: 't2', name: 'شركة أخرى' },
    ],
    salesRep: [
      { id: 'r1', tenantId: 't1', name: 'حسام' }, { id: 'r2', tenantId: 't1', name: 'علي' }, { id: 'r3', tenantId: 't1', name: 'سعيد' },
      { id: 'r2', tenantId: 't2', name: 'مندوب شركة أخرى' },
    ],
    invoice: [
      { id: 'inv1', tenantId: 't1', type: 'CREDIT', salesRepId: 'r2', total: 1150 },
      { id: 'inv9', tenantId: 't1', type: 'CREDIT', salesRepId: 'r1', total: 999 },
      { id: 'invX', tenantId: 't2', type: 'CREDIT', salesRepId: 'r2', total: 1 },
    ],
    receipt: [
      { id: 'rc1', tenantId: 't1', salesRepId: 'r1', paymentMethod: 'CASH', amount: 400 },
    ],
    accountEntry: [
      // c1: فاتورة آجل 1150 ثم سند نقدي 400 مع المندوب r1 ⇒ 750
      ae('t1', 'c1', 'INVOICE_DEBIT', { debit: 1150 }, '2026-11-10T08:00:00Z', undefined, { invoiceId: 'inv1' }),
      ae('t1', 'c1', 'RECEIPT_CREDIT', { credit: 400 }, '2026-11-20T08:00:00Z', undefined, { receiptId: 'rc1' }),
      // مؤرخة مستقبلاً (أثر بعد البدء) ثم أُلغيت قبل البدء: الإلغاء يتبع أصله فيخرج كلاهما من الافتتاح
      ae('t1', 'c1', 'INVOICE_DEBIT', { debit: 999 }, '2027-02-10T08:00:00Z', '2026-12-15T08:00:00Z', { invoiceId: 'inv9' }),
      ae('t1', 'c1', 'INVOICE_CREDIT', { credit: 999 }, '2026-12-20T08:00:00Z', undefined, { invoiceId: 'inv9' }),
      // وصول متأخر (أثر قبل البدء، إنشاء بعد T0) وحدّ البدء نفسه ⇒ خارج الافتتاح (يُرحَّلان بتاريخهما)
      ae('t1', 'c1', 'ADJUSTMENT_DEBIT', { debit: 77 }, '2026-12-30T08:00:00Z', '2027-01-15T08:55:00Z'),
      ae('t1', 'c1', 'ADJUSTMENT_DEBIT', { debit: 88 }, '2026-12-31T21:00:00Z', '2026-12-31T21:00:00Z'),
      // c2: تقريب لكل صف (القاعدة) 1.005 + 2.005 + 3.125 ⇒ 1.01 + 2.01 + 3.13 = 6.15 (لا 6.14 لمجموع Float)
      ae('t1', 'c2', 'ADJUSTMENT_DEBIT', { debit: 1.005 }, '2026-10-01T08:00:00Z'),
      ae('t1', 'c2', 'ADJUSTMENT_DEBIT', { debit: 2.005 }, '2026-10-02T08:00:00Z'),
      ae('t1', 'c2', 'ADJUSTMENT_DEBIT', { debit: 3.125 }, '2026-10-03T08:00:00Z'),
      // c3: رصيد دائن
      ae('t1', 'c3', 'ADJUSTMENT_CREDIT', { credit: 50 }, '2026-09-01T08:00:00Z'),
      // شركة أخرى
      ae('t2', 'cx', 'INVOICE_DEBIT', { debit: 5000 }, '2026-11-10T08:00:00Z', undefined, { invoiceId: 'invX' }),
    ],
    repSettlement: [
      { id: 'st1', tenantId: 't1', salesRepId: 'r1', amount: 300, settledAt: at('2026-12-01T08:00:00Z'), createdAt: at('2026-12-01T08:00:00Z') },
      // استلام مندوب محذوف (salesRepId = null) لا يدخل الدفاتر
      { id: 'st2', tenantId: 't1', salesRepId: null, amount: 70, settledAt: at('2026-12-02T08:00:00Z'), createdAt: at('2026-12-02T08:00:00Z') },
      // بعد البدء
      { id: 'st3', tenantId: 't1', salesRepId: 'r1', amount: 40, settledAt: at('2027-01-05T08:00:00Z'), createdAt: at('2027-01-05T08:00:00Z') },
      { id: 'stX', tenantId: 't2', salesRepId: 'r2', amount: 10, settledAt: at('2026-12-01T08:00:00Z'), createdAt: at('2026-12-01T08:00:00Z') },
    ],
    settlementEntry: [
      { id: 'se1', tenantId: 't1', amount: 500, createdAt: at('2026-12-05T08:00:00Z') },
      { id: 'se2', tenantId: 't1', amount: -120.5, createdAt: at('2026-12-10T08:00:00Z') },
      { id: 'se3', tenantId: 't1', amount: 9, createdAt: at('2027-01-03T08:00:00Z') },
      { id: 'seX', tenantId: 't2', amount: 1000, createdAt: at('2026-12-05T08:00:00Z') },
    ],
  };
}

const ROUTING: OpeningRouting = { receiptRouting: { ...LINKED_DEFAULT_RECEIPT_ROUTING }, cashInvoiceRouting: 'MAIN_CASH' };

test('loadLinkedOpening: الذمم والعهدة والأمانات بمسند الافتتاح، والمخزون من محرّك التكلفة، وقيد كامل متوازن يجتاز validateMove(SYSTEM)', async () => {
  const { db, calls, violations } = fakeDb(linkedTables());
  const res = await loadLinkedOpening(db, 't1', { cut: CUT, decimals: 2, routing: ROUTING, inventory: EXAMPLE_INVENTORY });
  assert.deepEqual(violations, []);
  const o = res.derived.opening;
  // الترتيب بالاسم العربي: بقالة ⇐ عميل ⇐ مؤسسة
  assert.deepEqual(o.receivables.map((r) => [r.customerId, r.customerName, r.balanceMilli]), [
    ['c2', 'بقالة الأمل', 6_150n], ['c3', 'عميل دائن', -50_000n], ['c1', 'مؤسسة النور', 750_000n],
  ]);
  assert.deepEqual(o.custody.map((c) => [c.salesRepId, c.salesRepName, c.ledgerCustodyMilli]), [['r1', 'حسام', 100_000n]]);
  assert.equal(o.paylinkHeldMilli, 379_500n);
  // المخزون لا يُقرأ من التشغيل (لا warehouseEntryItem/vanLoadItem — الفايك كان سيرمي) وحقله القديم صفر
  assert.deepEqual(o.warehouse, { valueMilli: 0n, uncostedQty: 0, uncostedProducts: 0 });
  assert.equal(o.counts.warehouseMovesIncluded, 0);
  assert.deepEqual(res.settlementSplits, o.settlementSplits);
  assert.deepEqual(Object.keys(res.settlementSplits), ['st1']);
  assert.equal(res.settlementSplits.st1.salesRepId, 'r1');
  assert.deepEqual(res.derived.inventory, EXAMPLE_INVENTORY);
  assert.notEqual(res.derived.inventory, EXAMPLE_INVENTORY, 'نسخة لا مرجع المُستدعي');

  // المطابقة الحرفية مع الدالّتين القائمتين على العميل نفسه (لا منطق موازٍ)
  const again = fakeDb(linkedTables());
  const src = await loadOpeningSources(again.db, 't1', CUT, { includeInventory: false });
  assert.deepEqual(canonical(computeDerivedOpening(src, CUT, { decimals: 2, routing: ROUTING })), canonical(o));

  // الأسماء: ما قرأه loadOpeningSources (r1) + استعلام واحد لمناديب مواقع المخزون الباقين بلا تكرار، مقيّد بالشركة
  const repCalls = calls.filter((c) => c.model === 'salesRep');
  assert.equal(repCalls.length, 2);
  assert.deepEqual(repCalls[1].args.where, { tenantId: 't1', id: { in: ['r2', 'r3', 'rDel'] } });
  assert.deepEqual(res.derived.salesRepNames, { r1: 'حسام', r2: 'علي', r3: 'سعيد' });
  // كل استعلام مقيّد بالشركة، ولا مخزون
  assert.ok(calls.every((c) => (c.args.where as Where).tenantId === 't1'));
  assert.deepEqual([...new Set(calls.map((c) => c.model))].sort(), ['accountEntry', 'customer', 'invoice', 'receipt', 'repSettlement', 'salesRep', 'settlementEntry']);

  // القيد الكامل: المشتقّ + اليدوي (بلا الحسابات المشتقة) + 319002
  const ctx = saContext();
  const manual = validateManualBalanceRows([
    { accountCode: '111101', debit: 20_000 }, { accountCode: '311001', credit: 15_000 },
    { accountCode: '211001', credit: 3_000, vendorName: 'مصنع الخليج' },
    { accountCode: '113001', debit: 500, customerId: 'c1' }, { accountCode: '114002', debit: 80, salesRepId: 'r1' },
  ], ctx, { midVatPeriod: false, derivedAccounts: true });
  assert.deepEqual(manual.issues.map((i) => [i.index, i.reason]), [[3, 'DERIVED_ACCOUNT'], [4, 'DERIVED_ACCOUNT']]);
  manual.lines[2].vendorId = 'v1';
  const move = buildOpeningMove({ openingDate: CUT.openingDate, manual: manual.lines, ctx, derived: res.derived });
  const draft = move.draft!;
  assert.equal(draft.date, '2026-12-31');
  assert.deepEqual(draft.lines.map((l) => [l.accountKey ?? l.accountId, l.customerId ?? l.salesRepId ?? l.vendorId ?? null, String(l.debitMilli - l.creditMilli)]), [
    ['AR_CONTROL', 'c2', '6150'],
    ['AR_CONTROL', 'c3', '-50000'],
    ['AR_CONTROL', 'c1', '750000'],
    ['REP_CUSTODY', 'r1', '100000'],
    ['PAYLINK_CLEARING', null, '379500'],
    ['INVENTORY_WAREHOUSE', null, '115000'],
    ['INVENTORY_VAN', null, '10000'],
    ['INVENTORY_VAN', 'r2', '57000'],
    ['INVENTORY_VAN', 'r3', '50000'],
    ['INVENTORY_VAN', 'rDel', '-32000'],
    [accountIdOf('111101'), null, '20000000'],
    [accountIdOf('311001'), null, '-15000000'],
    [accountIdOf('211001'), 'v1', '-3000000'],
    // 319002 = −(1,385.65 + 2,000)
    ['OPENING_EQUITY', null, '-3385650'],
  ]);
  assert.equal(draft.lines.find((l) => l.salesRepId === 'rDel')!.partnerName, 'مندوب rDel', 'المندوب المحذوف باسم بديل');
  assert.equal(draft.lines.find((l) => l.salesRepId === 'r3')!.label, 'بضاعة سيارة — سعيد');
  assert.deepEqual([move.derivedLineCount, move.derivedDebitMilli, move.derivedCreditMilli, move.equityDiffMilli], [10, 1_467_650n, 82_000n, 3_385_650n]);
  const v = validateMove(draft, ctx, { mode: 'SYSTEM' });
  assert.equal(v.totalDebitMilli, 21_467_650n);
  assert.equal(v.totalCreditMilli, 21_467_650n);
});

test('loadLinkedOpening: PERIODIC (inventory = null) بلا استعلام أسماء إضافي، والدفعات مقسّمة، والبداية النظيفة مرفوضة، والشركة مطلوبة', async () => {
  const { db, calls } = fakeDb(linkedTables());
  const res = await loadLinkedOpening(db, 't1', { cut: CUT, decimals: 2, routing: ROUTING, inventory: null });
  assert.equal(res.derived.inventory, null);
  assert.equal(calls.filter((c) => c.model === 'salesRep').length, 1, 'أسماء loadOpeningSources وحدها');
  assert.deepEqual(res.derived.salesRepNames, { r1: 'حسام' });
  const move = buildOpeningMove({ openingDate: CUT.openingDate, manual: [], ctx: saContext(), derived: res.derived });
  assert.equal(move.draft!.lines.filter((l) => l.accountKey === 'INVENTORY_WAREHOUSE' || l.accountKey === 'INVENTORY_VAN').length, 0);
  assert.equal(move.equityDiffMilli, 6_150n - 50_000n + 750_000n + 100_000n + 379_500n);

  // مناديب المواقع: بقيمة ≠ 0 وحدها، بلا المجهولة، مرتّبين بلا تكرار
  assert.deepEqual(inventoryRepIds(EXAMPLE_INVENTORY), ['r2', 'r3', 'rDel']);
  assert.deepEqual(inventoryRepIds(null), []);
  // التقسيم: LINKED_OPENING_ID_CHUNK + 3 مندوباً ⇒ استعلامان، لا استعلام لكل مندوب (لا N+1)
  const many = Array.from({ length: LINKED_OPENING_ID_CHUNK + 3 }, (_, i) => loc(`VAN:z${String(i).padStart(5, '0')}`, 1, 1_000n));
  const big = fakeDb(linkedTables());
  const r2 = await loadLinkedOpening(big.db, 't1', { cut: CUT, decimals: 2, routing: ROUTING, inventory: many });
  const extra = big.calls.filter((c) => c.model === 'salesRep').slice(1);
  assert.deepEqual(extra.map((c) => ((c.args.where as { id: { in: string[] } }).id.in).length), [LINKED_OPENING_ID_CHUNK, 3]);
  assert.equal(Object.keys(r2.derived.salesRepNames ?? {}).length, 1);

  await assert.rejects(() => loadLinkedOpening(db, 't1', { cut: openingCutoff(LINKED_FROM, TZ, T0, { cleanStart: true }), decimals: 2, routing: ROUTING, inventory: null }), RangeError);
  await assert.rejects(() => loadLinkedOpening(db, '', { cut: CUT, decimals: 2, routing: ROUTING, inventory: null }), RangeError);
});

test('loadLinkedOpening: لا وصول gl* ولا كتابة — العميل الحارس يرمي فيفشل، والفايك يحصي صفر مخالفات في المسار السليم', async () => {
  const tables = linkedTables();
  const { db, violations } = fakeDb(tables);
  await loadLinkedOpening(db, 't1', { cut: CUT, decimals: 2, routing: ROUTING, inventory: EXAMPLE_INVENTORY });
  assert.deepEqual(violations, []);
  // الفايك يرمي حقاً على gl* وعلى الكتابة (لا ينجح الاختبار أعلاه لأن الحارس صامت)
  const probe = fakeDb(tables);
  assert.throws(() => (probe.db as unknown as Record<string, unknown>).glSettings, /SHADOW_GL_ACCESS/);
  assert.throws(() => (probe.db.customer as unknown as Record<string, unknown>).create, /ممنوعة/);
  assert.deepEqual(probe.violations, ['glSettings', 'customer.create']);
});

// ═══ 5) فحص C3 الفرعي للدفاتر المربوطة ═══

test('c3OpeningEntriesEnabled: LINKED وحدها؛ اليدوية والقديمة وغير المفعّلة وغياب الحقل ⇒ false', () => {
  assert.equal(c3OpeningEntriesEnabled({ bookMode: 'LINKED' }), true);
  for (const bookMode of ['MANUAL', 'LEGACY', 'NONE', null, undefined] as const) assert.equal(c3OpeningEntriesEnabled({ bookMode }), false, String(bookMode));
  assert.equal(c3OpeningEntriesEnabled({}), false);
});

const AR = accountIdOf('113001');

class LinkedCheckStore implements CheckStore {
  settings: CheckSettingsFacts | null = {
    activatedAt: T0, backfillState: 'DONE', setupMethod: 'OPENING', cutoverDate: LINKED_FROM, openingSnapshotAt: T0, timezone: TZ,
    currencyDecimals: 2, lastSyncAt: at('2027-03-10T11:59:00.000Z'), inventoryMode: 'PERPETUAL',
    lockDates: { salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null },
  };
  arLedger = new Map<string, Milli>();
  arOpening = new Map<string, Milli>();
  openingEntries = new Map<string, Milli>();
  windows: { cutoverStart: Date; openingSnapshotAt: Date; cleanStart?: boolean }[] = [];
  async dbNow() { return at('2027-03-10T12:00:00.000Z'); }
  async loadSettings() { return this.settings; }
  async unbalancedMoves() { return []; }
  async periodLineTotals() { return []; }
  async storedPeriodBalances() { return []; }
  async controlAccounts() { return [{ id: AR, code: '113001', controlKind: 'AR' }]; }
  async mappedAccounts() { return []; }
  async ledgerByPartner(_t: string, _a: readonly string[], partner: 'customerId' | 'salesRepId', opts: { moveType?: string } = {}) {
    if (partner !== 'customerId') return new Map<string, Milli>();
    return opts.moveType === 'OPENING' ? this.arOpening : this.arLedger;
  }
  async ledgerTotal() { return 0n; }
  async accountEntryTotals() { return new Map<string, Milli>(); }
  async deletedOpeningImports() { return new Map<string, Milli>(); }
  async accountEntryOpeningTotals(_t: string, w: { cutoverStart: Date; openingSnapshotAt: Date; cleanStart?: boolean }) {
    this.windows.push(w);
    return this.openingEntries;
  }
  async customerNames(_t: string, ids: readonly string[]) { return new Map(ids.map((i) => [i, `عميل ${i}`])); }
  async salesReps() { return []; }
  async custodyInputs(): Promise<CustodyComponentsInput> { return { receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [], routing: { cashInvoice: 'MAIN_CASH' } }; }
  async repCollections() { return new Map<string, Milli>(); }
  async settlementBalance() { return 0n; }
  async paylinkExplanations() { return { refundedLinksWithoutRefund: [], cancelledOnlineWithoutRefund: [] }; }
  async pendingPartners(): Promise<PendingPartners> { return { customerIds: new Set(), salesRepIds: new Set(), settlement: false, unknown: false }; }
  async problemEvents() { return []; }
  async cursorStates() { return []; }
  async attentionMovesOn() { return []; }
  async draftsUpTo() { return { count: 0, drafts: [] }; }
  async taxes() { return []; }
  async sequences() { return []; }
  async postedMoveNumbers() { return []; }
  async erpOdooActive() { return false; }
}

test('runChecks C3 للمربوطة (bookMode LINKED): يُسأل accountEntryOpeningTotals بنافذة البدء واللقطة، وصف افتتاحي حُذف بلا حدث ⇒ أحمر', async () => {
  const store = new LinkedCheckStore();
  store.settings = { ...store.settings!, bookMode: 'LINKED' };
  // افتتاح الأستاذ لـc1 = 300 مشتقّاً من صفوفه؛ حُذف صفّ 100 بلا حدث فصارت صفوفه الحالية 200
  store.arOpening.set('c1', 300_000n);
  store.arLedger.set('c1', 300_000n);
  store.openingEntries.set('c1', 200_000n);
  const c3 = (await runChecks(store, 't1', { only: ['C3'] })).results[0];
  assert.equal(c3.key, 'C3');
  assert.equal(c3.status, 'RED');
  const row = c3.rows.find((r) => r.kind === OPENING_DELETED_WITHOUT_EVENT)!;
  assert.deepEqual([row.customerId, row.openingMilli, row.openingEntriesMilli, row.openingGapMilli], ['c1', '300000', '200000', '100000']);
  assert.deepEqual(store.windows, [{ cutoverStart: zonedStartOfDay(LINKED_FROM, TZ), openingSnapshotAt: T0, cleanStart: false }]);
  // صفوفه تطابق افتتاحه ⇒ أخضر
  store.openingEntries.set('c1', 300_000n);
  assert.equal((await runChecks(store, 't1', { only: ['C3'] })).results[0].status, 'GREEN');

  // غير المربوطة (وغياب الحقل): لا سؤال ولا تعمّق — السلوك القائم حرفياً
  for (const bookMode of [undefined, null, 'LEGACY', 'MANUAL'] as const) {
    const s = new LinkedCheckStore();
    s.settings = { ...s.settings!, bookMode };
    s.arOpening.set('c1', 300_000n);
    s.arLedger.set('c1', 300_000n);
    s.openingEntries.set('c1', 200_000n);
    const r = (await runChecks(s, 't1', { only: ['C3'] })).results[0];
    assert.equal(r.status, 'GREEN', String(bookMode));
    assert.equal(s.windows.length, 0, String(bookMode));
    const input = await loadC3Input(s, 't1', s.settings!, { customerIds: new Set(), salesRepIds: new Set(), settlement: false, unknown: false });
    assert.equal(input.openingEntries, null);
  }
  // مخزن قديم بلا accountEntryOpeningTotals ⇒ لا تعمّق ولو كانت مربوطة
  const legacyStore = new LinkedCheckStore();
  legacyStore.settings = { ...legacyStore.settings!, bookMode: 'LINKED' };
  (legacyStore as { accountEntryOpeningTotals?: unknown }).accountEntryOpeningTotals = undefined;
  const input = await loadC3Input(legacyStore, 't1', legacyStore.settings!, { customerIds: new Set(), salesRepIds: new Set(), settlement: false, unknown: false });
  assert.equal(input.openingEntries, null);
});

// ═══ 6) حرّاس ثابتة ═══

test('حارس ثابت: الدفاتر اليدوية لا تمرّر derived ولا derivedAccounts، وbuildOpeningMove يستدعي السطور المشتقّة بالخيار وحده', () => {
  const setup = read('routes', 'ledger', 'setup.ts');
  assert.doesNotMatch(setup, /derived\s*:/);
  assert.doesNotMatch(setup, /derivedAccounts|linkedOpeningLines|loadLinkedOpening/);
  const opening = read('services', 'gl', 'opening.ts');
  const build = opening.slice(opening.indexOf('export function buildOpeningMove('), opening.indexOf('// ═══ حلّ شركاء'));
  assert.equal((build.match(/linkedOpeningLines\(/g) ?? []).length, 1);
  assert.match(build, /const linked = input\.derived \? linkedOpeningLines\(input\.derived, date\) : null;/);
  // المخزون المشتقّ من محرّك التكلفة وحده: السطور لا تقرأ opening.warehouse القديم
  const helper = opening.slice(opening.indexOf('export function linkedOpeningLines('), opening.indexOf('export function buildOpeningMove('));
  assert.doesNotMatch(helper, /\.warehouse\b/);
  assert.doesNotMatch(helper, /composeWarehouse|valueStock/);
});

test('حارس ثابت: openingLinked.ts قراءة فقط بلا gl* ولا $raw، والمخزون من محرّك التكلفة لا من loadOpeningSources', () => {
  const src = read('services', 'gl', 'linking', 'openingLinked.ts');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  assert.doesNotMatch(code, /\$(executeRaw|queryRaw|executeRawUnsafe|queryRawUnsafe|transaction)/);
  assert.doesNotMatch(code, /\bdb\.gl[A-Z]/);
  assert.match(code, /loadOpeningSources\(db, tenantId, input\.cut, \{ includeInventory: false \}\)/);
  assert.match(code, /where: \{ tenantId, id: \{ in: missing\.slice\(i, i \+ LINKED_OPENING_ID_CHUNK\) \} \}/);
});
