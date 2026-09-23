// M4 — دفتر الأستاذ العام: اتّساقه مع ميزان المراجعة، وفلتر الشركاء، ومؤشّر دفعات القراءة
// (DESIGN.md §7.1 «الأداء» و«التصدير»، §7.2 قاعدة بنود الإقفال، §7.5 ORPT‑02).
//
// بلا قاعدة بيانات: `buildGeneralLedger` و`buildTrialBalance` و`composeBalances` صرفة تستقبل
// مصفوفات، وحلقة دفعات المؤشّر تُختبر بحقن دالة قراءة وهمية بدل prisma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PARTNER_FILTER_OPENING_IGNORED, buildGeneralLedger,
  type GeneralLedgerSection, type LedgerLineInput,
} from '../services/gl/reports/generalLedger';
import { accountEndingMilli, buildTrialBalance, trialBalanceRow } from '../services/gl/reports/trialBalance';
import { composeBalances } from '../services/gl/reports/balances';
import { DEFAULT_FISCAL_YEAR, makePeriod } from '../services/gl/reports/period';
import {
  LINE_KEYSET_ORDER_BY, balanceReadMode, compareLineKeys, lineKeysetAfter, readLinesByKeyset,
  reportLineFilters, reportLoadOptions, requiresPartnerScan,
  type LineKeysetCursor, type RawLine,
} from '../services/gl/reports/load';
import { normalizeReportOptions, type BalanceLineRow, type ReportAccount } from '../services/gl/reports/types';

// ═══ المتجهات: مدخلات واحدة يقرؤها الميزان ودفتر الأستاذ معاً ═══

/** السنة المالية تقويمية، والفترة مارس 2026 ⇒ `fyStart = 2026-01-01`. */
const PERIOD = makePeriod('2026-03-01', '2026-03-31', DEFAULT_FISCAL_YEAR);

const ACCOUNTS: ReportAccount[] = [
  { id: 'a-cash', code: '111001', name: 'الصندوق', nameI18n: { ar: 'الصندوق', en: 'Cash' }, type: 'asset_cash' },
  { id: 'a-re', code: '313001', name: 'الأرباح المبقاة', nameI18n: null, type: 'equity' },
  { id: 'a-exp', code: '521001', name: 'مصروف إيجار', nameI18n: null, type: 'expense' },
];

const TYPE_OF = new Map(ACCOUNTS.map((a) => [a.id, a.type]));

/** حركة خامّة: قيدٌ متوازن بسطرين، تُقرأ أرصدةً (`composeBalances`) وسطوراً (دفتر الأستاذ) معاً. */
interface Entry {
  id: string;
  date: string;
  number: string;
  closing?: boolean;
  debit: { accountId: string; milli: bigint };
  credit: { accountId: string; milli: bigint };
}

/**
 * قيد إقفال السنة المالية 2025 يحمل تاريخ ترحيله الفعلي (‏§2.5): إن وقع داخل فترة التقرير كان
 * سطراً من سطورها، وهو يعكس نشاطاً **سابقاً للسنة** ليس داخل الافتتاحي — وهنا كان التناقض.
 */
const entries = (closingDate: string): Entry[] => [
  // نشاط السنة المالية السابقة (قبل fyStart): خارج افتتاحي حساب الدخل بقاعدة §7.2
  { id: 'e-2025', date: '2025-08-10', number: 'JV/2025/9', debit: { accountId: 'a-exp', milli: 5_000_000n }, credit: { accountId: 'a-cash', milli: 5_000_000n } },
  // نشاط الفترة: 2,500.00 مديناً على 521001
  { id: 'e-mar', date: '2026-03-05', number: 'JV/2026/3', debit: { accountId: 'a-exp', milli: 2_500_000n }, credit: { accountId: 'a-cash', milli: 2_500_000n } },
  // إقفال 2025 المتأخر: يُصفّر 521001 مقابل 313001
  { id: 'e-cl', date: closingDate, number: 'CL/2025', closing: true, debit: { accountId: 'a-re', milli: 5_000_000n }, credit: { accountId: 'a-exp', milli: 5_000_000n } },
];

const CLOSING_BEFORE = '2026-02-15';
const CLOSING_INSIDE = '2026-03-20';

const balanceLines = (es: readonly Entry[]): BalanceLineRow[] => es.flatMap((e) => ([
  { accountId: e.debit.accountId, date: e.date, debitMilli: e.debit.milli, creditMilli: 0n, closing: e.closing === true, draft: false },
  { accountId: e.credit.accountId, date: e.date, debitMilli: 0n, creditMilli: e.credit.milli, closing: e.closing === true, draft: false },
]));

/** سطور دفتر الأستاذ: سطور المدى وحده (ما قبله في الافتتاحي، كما تقرؤه الطبقة الرقيقة). */
const ledgerLines = (es: readonly Entry[]): LedgerLineInput[] => es
  .filter((e) => e.date >= PERIOD.from && e.date <= PERIOD.to)
  .flatMap((e) => ([{ ...e.debit, seq: 0 }, { ...e.credit, seq: 1 }].map((leg, i) => ({
    id: `${e.id}-${i}`,
    moveId: e.id,
    accountId: leg.accountId,
    date: e.date,
    originalDate: null,
    lateArrival: false,
    seq: leg.seq,
    moveNumber: e.number,
    moveState: 'POSTED',
    moveType: e.closing === true ? 'FY_CLOSING' : 'MANUAL',
    journalId: 'j-gen',
    journalCode: 'JV',
    journalName: 'قيود عامة',
    partnerId: null,
    partnerName: null,
    salesRepId: null,
    salesRepName: null,
    analyticAccountId: null,
    label: null,
    debitMilli: i === 0 ? leg.milli : 0n,
    creditMilli: i === 1 ? leg.milli : 0n,
  }))));

function reports(closingDate: string) {
  const es = entries(closingDate);
  const balances = composeBalances({ period: PERIOD, accounts: ACCOUNTS, lines: balanceLines(es) });
  const tb = buildTrialBalance({ accounts: ACCOUNTS, period: PERIOD, balances });
  const gl = buildGeneralLedger({ period: PERIOD, accounts: ACCOUNTS, balances, lines: ledgerLines(es) });
  return { balances, tb, gl };
}

const sectionOf = (gl: ReturnType<typeof reports>['gl'], accountId: string): GeneralLedgerSection => {
  const s = gl.sections.find((x) => x.account.id === accountId);
  assert.ok(s, `لا قسم للحساب ${accountId}`);
  return s;
};

// ═══ 1) الاتّساق مع ميزان المراجعة على المدخلات نفسها (§7.2) ═══

test('دفتر الأستاذ = ميزان المراجعة: الإقفال قبل الفترة أو داخلها × حساب دخل أو ميزانية', () => {
  for (const closingDate of [CLOSING_BEFORE, CLOSING_INSIDE]) {
    const { balances, tb, gl } = reports(closingDate);
    // الميزان نفسه متوازن على هذه المدخلات (فالمقارنة إلى رقم صحيح لا إلى رقم مكسور)
    assert.equal(tb.balanced, true, `ميزان غير متوازن عند إقفال ${closingDate}`);

    for (const accountId of ['a-exp', 'a-re']) {
      const tbRow = trialBalanceRow(tb, accountId);
      assert.ok(tbRow, `لا صفّ ميزان للحساب ${accountId}`);
      const s = sectionOf(gl, accountId);
      const where = `${accountId} / إقفال ${closingDate}`;
      assert.equal(s.openingMilli, tbRow.cells[0].openingMilli, `افتتاحي مختلف: ${where}`);
      assert.equal(s.endingMilli, tbRow.cells[0].endingMilli, `نهائي مختلف: ${where}`);
      // والقاعدة المشتركة المعلنة في trialBalance.ts هي المرجع لكليهما
      const balance = balances.find((b) => b.accountId === accountId);
      assert.ok(balance);
      assert.equal(s.endingMilli, accountEndingMilli(balance, TYPE_OF.get(accountId) as string), `قاعدة §7.2: ${where}`);
    }
  }
});

test('الرقمان المتناقضان سابقاً: 521001 يعطي +2,500.00 في التقريرين لا −2,500.00', () => {
  for (const closingDate of [CLOSING_BEFORE, CLOSING_INSIDE]) {
    const { tb, gl } = reports(closingDate);
    const s = sectionOf(gl, 'a-exp');
    assert.equal(s.endingMilli, 2_500_000n, `دفتر الأستاذ عند إقفال ${closingDate}`);
    assert.equal(trialBalanceRow(tb, 'a-exp')?.cells[0].endingMilli, 2_500_000n);
    // الصيغة القديمة (البذرة تضمّ إقفال ما قبل الفترة، وبنود الإقفال حركةً) كانت تعطي −2,500.00
    const legacy = s.openingBalanceMilli + (s.debitMilli + s.closingDebitMilli) - (s.creditMilli + s.closingCreditMilli);
    assert.equal(legacy, -2_500_000n);
    assert.notEqual(legacy, s.endingMilli);
  }
});

test('بنود الإقفال تُفصَل ولا تُخفى: حساب الدخل يستبعدها، وحساب الميزانية يُبقيها في صفّه', () => {
  const { gl } = reports(CLOSING_INSIDE);

  const exp = sectionOf(gl, 'a-exp');
  assert.equal(exp.closingExcluded, true);
  assert.deepEqual(exp.lines.map((l) => [l.moveNumber, l.closing, l.excluded]), [
    ['JV/2026/3', false, false],
    ['CL/2025', true, true],
  ]);
  // السطر معروض، والرصيد الجاري لا يتحرّك عنده
  assert.deepEqual(exp.lines.map((l) => l.runningMilli), [2_500_000n, 2_500_000n]);
  assert.equal(exp.debitMilli, 2_500_000n);
  assert.equal(exp.creditMilli, 0n);
  assert.equal(exp.closingDebitMilli, 0n);
  assert.equal(exp.closingCreditMilli, 5_000_000n);
  assert.equal(exp.closingMilli, -5_000_000n);
  // ما يراه المستخدم مجموعاً = حركة القسم + صفّ الإقفال المفصول
  const shownDebit = exp.lines.reduce((t, l) => t + l.debitMilli, 0n);
  const shownCredit = exp.lines.reduce((t, l) => t + l.creditMilli, 0n);
  assert.equal(shownDebit, exp.debitMilli + exp.closingDebitMilli);
  assert.equal(shownCredit, exp.creditMilli + exp.closingCreditMilli);
  // ورصيد الحساب الفعلي بعد إقفاله محفوظٌ ولا يضيع: 5,000 قبل ناقص إقفالها زائد حركة الفترة
  assert.equal(exp.openingBalanceMilli, 0n);
  assert.equal(exp.endingBalanceMilli, -2_500_000n);
  assert.equal(exp.carriedForwardMilli, exp.openingMilli);

  const re = sectionOf(gl, 'a-re');
  assert.equal(re.closingExcluded, false);
  assert.deepEqual(re.lines.map((l) => [l.closing, l.excluded]), [[true, false]]);
  assert.deepEqual(re.lines.map((l) => l.runningMilli), [5_000_000n]);
  assert.equal(re.debitMilli, 5_000_000n);
  assert.equal(re.closingMilli, 0n);
  assert.equal(re.endingMilli, 5_000_000n);
  assert.equal(re.endingBalanceMilli, re.endingMilli);
});

test('الإقفال قبل الفترة: لا يدخل افتتاحي حساب الدخل ويدخل افتتاحي حساب الميزانية', () => {
  const { gl } = reports(CLOSING_BEFORE);
  const exp = sectionOf(gl, 'a-exp');
  assert.equal(exp.closingOpeningMilli, -5_000_000n);
  assert.equal(exp.openingMilli, 0n);            // §7.2: إقفاله في صف «أرباح سنوات سابقة»
  assert.equal(exp.openingBalanceMilli, -5_000_000n); // ورصيده الفعلي معروض بجواره
  assert.equal(exp.endingMilli, 2_500_000n);
  assert.equal(exp.lines.every((l) => !l.closing), true, 'إقفال ما قبل الفترة ليس من سطورها');

  const re = sectionOf(gl, 'a-re');
  assert.equal(re.closingOpeningMilli, 5_000_000n);
  assert.equal(re.openingMilli, 5_000_000n);
  assert.equal(re.openingBalanceMilli, 5_000_000n);
  assert.equal(re.lineCount, 0);
  assert.equal(re.endingMilli, 5_000_000n);
});

test('مجاميع دفتر الأستاذ تقابل مجاميع الميزان على الحسابات نفسها', () => {
  for (const closingDate of [CLOSING_BEFORE, CLOSING_INSIDE]) {
    const { tb, gl } = reports(closingDate);
    // الميزان ينقل إقفال حسابات الدخل إلى صفّ «أرباح سنوات سابقة»، ودفتر الأستاذ إلى صفّ الإقفال:
    // فمجموع النهائي فيهما يفترق بمقدار ما نُقل وحده، وهو معلن في totals.closingMilli
    const tbAccounts = tb.rows.filter((r) => r.kind === 'account');
    const tbEnding = tbAccounts.reduce((t, r) => t + r.cells[0].endingMilli, 0n);
    assert.equal(gl.totals.endingMilli, tbEnding, `إجمالي النهائي عند إقفال ${closingDate}`);
    const tbOpening = tbAccounts.reduce((t, r) => t + r.cells[0].openingMilli, 0n);
    assert.equal(gl.totals.openingMilli, tbOpening);
    assert.equal(
      gl.totals.endingBalanceMilli,
      gl.totals.openingBalanceMilli + gl.totals.debitMilli - gl.totals.creditMilli + gl.totals.closingMilli,
    );
  }
});

// ═══ 2) فلتر الشركاء: محمولٌ في طبقة القراءة، وبلا إسقاط صامت (§7.5) ═══

const baseOptions = () => normalizeReportOptions({
  dateFilter: { mode: 'month', from: '2026-03-01', to: '2026-03-31' },
});

test('فلتر الشركاء يُحمَل إلى طبقة القراءة ويفرض مسح البنود', () => {
  const opts = baseOptions();
  assert.equal('partners' in reportLoadOptions(opts), false, 'بلا فلتر لا يُضاف مفتاح');
  assert.equal('accountIds' in reportLoadOptions(opts), false);
  const withPartners = reportLoadOptions(opts, { partners: ['c-1', 'v-2'], accountIds: ['a-exp'] });
  assert.deepEqual(withPartners.partners, ['c-1', 'v-2']);
  assert.deepEqual(withPartners.accountIds, ['a-exp']);
  assert.equal('unit' in withPartners, false);

  assert.equal(requiresPartnerScan({ partners: ['c-1'] }), true);
  assert.equal(requiresPartnerScan({ partners: [] }), false);
  // الأرصدة الشهرية لا تحمل الشريك ⇒ مسح بنود كفلتر الدفتر تماماً
  assert.equal(balanceReadMode({ partners: ['c-1'] }), 'LINE_SCAN');
  assert.equal(balanceReadMode({ partners: [] }), 'AGGREGATE');
  assert.equal(balanceReadMode({}), 'AGGREGATE');
  assert.equal(balanceReadMode(reportLoadOptions(opts, { partners: ['c-1'] })), 'LINE_SCAN');
});

test('شرط الشريك في القراءة: عميل أو مورّد تحت AND فلا يُزيح استبعاد سطور العلامة', () => {
  const w = reportLineFilters({ partners: ['c-1', 'v-2'], accountIds: ['a-exp'], journals: ['j-gen'] });
  assert.equal('OR' in w, false, 'مفتاح OR محجوز لشرط NOT_MARKER في كل موضع استدعاء');
  assert.deepEqual(w.AND, [{ OR: [{ customerId: { in: ['c-1', 'v-2'] } }, { vendorId: { in: ['c-1', 'v-2'] } }] }]);
  assert.deepEqual(w.accountId, { in: ['a-exp'] });
  assert.deepEqual(w.journalId, { in: ['j-gen'] });
  assert.equal('AND' in reportLineFilters({ accountIds: ['a-exp'] }), false);
});

test('فلتر شركاء بأرصدة غير مفلترة ⇒ تنبيه صريح لا إسقاط صامت', () => {
  const es = entries(CLOSING_INSIDE);
  const input = {
    period: PERIOD,
    accounts: ACCOUNTS,
    balances: composeBalances({ period: PERIOD, accounts: ACCOUNTS, lines: balanceLines(es) }),
    lines: ledgerLines(es),
  };
  const plain = buildGeneralLedger(input);
  assert.deepEqual(plain.warnings, []);
  assert.deepEqual(plain.partners, []);
  assert.equal(plain.openingScope, 'account');

  const ignored = buildGeneralLedger({ ...input, options: { partners: ['c-1'] } });
  assert.deepEqual(ignored.partners, ['c-1']);
  assert.equal(ignored.openingScope, 'account');
  assert.deepEqual(ignored.warnings.map((w) => w.code), [PARTNER_FILTER_OPENING_IGNORED]);
  assert.match(ignored.warnings[0].message, /فلتر الشركاء/);
  assert.deepEqual(ignored.warnings[0].details, { partners: ['c-1'] });

  const filtered = buildGeneralLedger({ ...input, options: { partners: ['c-1'], openingScope: 'partners' } });
  assert.equal(filtered.openingScope, 'partners');
  assert.deepEqual(filtered.warnings, []);
});

// ═══ 3) مؤشّر الدفعات [tenantId, accountId, date, id] (§7.1) ═══

const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

const row = (accountId: string, date: string, id: string): RawLine =>
  ({ id, moveId: `m-${id}`, accountId, date: d(date), debitMilli: 0n, creditMilli: 0n });

/** قراءة وهمية تطبّق دلالة `lineKeysetAfter` نفسها على مصفوفة في الذاكرة. */
function fakeStore(rows: readonly RawLine[]) {
  const sorted = [...rows].sort(compareLineKeys);
  const calls: (LineKeysetCursor | null)[] = [];
  const fetchPage = async ({ take, after }: { take: number; after: LineKeysetCursor | null }) => {
    calls.push(after);
    const rest = after === null ? sorted : sorted.filter((r) => compareLineKeys(r, after) > 0);
    return rest.slice(0, take);
  };
  return { sorted, calls, fetchPage };
}

test('ترتيب دفعات البنود يخدم الفهرس [tenantId, accountId, date] ثم id', () => {
  assert.deepEqual([...LINE_KEYSET_ORDER_BY], [{ accountId: 'asc' }, { date: 'asc' }, { id: 'asc' }]);
  const after: LineKeysetCursor = { accountId: 'a-exp', date: d('2026-03-05'), id: 'l-7' };
  assert.deepEqual(lineKeysetAfter(after), {
    OR: [
      { accountId: { gt: 'a-exp' } },
      { accountId: 'a-exp', date: { gt: after.date } },
      { accountId: 'a-exp', date: after.date, id: { gt: 'l-7' } },
    ],
  });
  // الترتيب حتمي: لا يعيد 0 لسطرين مختلفين
  assert.equal(compareLineKeys(after, after), 0);
  assert.equal(compareLineKeys(after, { ...after, id: 'l-8' }) < 0, true);
  assert.equal(compareLineKeys(after, { ...after, date: d('2026-03-04') }) > 0, true);
  assert.equal(compareLineKeys(after, { ...after, accountId: 'a-zz' }) < 0, true);
});

test('حدود الدفعات: لا تكرار ولا فقد مهما وقع الحدّ (ومع تواريخ وحسابات متساوية)', async () => {
  const batch = 4;
  // ثلاثة حسابات × تواريخ متكرّرة: الحدّ يقع كثيراً داخل يومٍ واحد لحسابٍ واحد
  const make = (n: number): RawLine[] => Array.from({ length: n }, (_, i) => row(
    ['a-cash', 'a-exp', 'a-re'][i % 3],
    ['2026-03-05', '2026-03-05', '2026-03-06'][i % 3],
    `l-${String(i).padStart(3, '0')}`,
  ));
  for (const n of [0, 1, batch - 1, batch, batch + 1, batch * 2, batch * 2 + 1, batch * 3]) {
    const store = fakeStore(make(n));
    const out = await readLinesByKeyset(store.fetchPage, batch, 10_000, () => { throw new Error('سقف'); });
    assert.equal(out.length, n, `عدد السطور عند n=${n}`);
    assert.deepEqual(out.map((r) => r.id), store.sorted.map((r) => r.id), `ترتيب/تكرار عند n=${n}`);
    assert.equal(new Set(out.map((r) => r.id)).size, n, `تكرار عند n=${n}`);
    // مضاعف تامّ ⇒ دفعة أخيرة فارغة تُنهي الحلقة (لا توقّف مبكّر ولا حلقة لا نهائية)
    assert.equal(store.calls.length, Math.floor(n / batch) + 1, `عدد الدفعات عند n=${n}`);
    assert.equal(store.calls[0], null);
  }
});

test('سقف السطور الدفاعي يوقف القراءة المؤشّرية', async () => {
  const store = fakeStore(Array.from({ length: 20 }, (_, i) => row('a-cash', '2026-03-05', `l-${i}`)));
  await assert.rejects(
    () => readLinesByKeyset(store.fetchPage, 4, 8, () => { throw new Error('LEDGER_RANGE_TOO_LARGE'); }),
    /LEDGER_RANGE_TOO_LARGE/,
  );
});

test('طبقة القراءة تستعمل المؤشّر المركّب لا ترتيب المعرّف وحده', () => {
  const file = path.join(__dirname, '../services/gl/reports/load.ts');
  const code = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const reads = code.match(/tx\.glMoveLine\.findMany/g) ?? [];
  assert.equal(reads.length, 1, 'قراءة البنود في موضع واحد');
  assert.match(code, /orderBy: \[\.\.\.LINE_KEYSET_ORDER_BY\]/);
  assert.match(code, /AND: \[where, lineKeysetAfter\(after\)\]/);
  const linesRead = code.slice(code.indexOf('async function fetchLines'));
  assert.doesNotMatch(linesRead.slice(0, linesRead.indexOf('\n}')), /orderBy: \{ id: 'asc' \}/);
});

// ═══ 4) عقد المبالغ: نصّ عدد صحيح بالملّي تحت مفتاح ينتهي بـMilli ═══

test('كل مبلغ يخرج من دفتر الأستاذ ملّي صحيح تحت مفتاح Milli (بلا تنسيق ولا وحدة عرض)', () => {
  const { gl } = reports(CLOSING_INSIDE);
  const amountKeys: string[] = [];
  const walk = (node: unknown, key: string): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'bigint') {
      amountKeys.push(key);
      assert.match(key, /Milli$/, `مبلغ تحت مفتاح لا ينتهي بـMilli: ${key}`);
      return;
    }
    if (typeof node === 'number') {
      assert.equal(Number.isInteger(node), true, `عدد كسري في الردّ: ${key}`);
      assert.doesNotMatch(key, /Milli$/, `مفتاح Milli بعدد JS لا BigInt: ${key}`);
      return;
    }
    if (typeof node === 'string') {
      assert.doesNotMatch(key, /Milli$/, `مفتاح Milli بنصّ مُنسَّق: ${key}`);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, key);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(gl, 'result');
  assert.ok(amountKeys.length > 20, 'المبالغ تُفحص فعلاً');

  // وبعد التسلسل إلى JSON (كما تفعل النقطة): نصّ عدد صحيح، بلا فاصلة عشرية ولا فواصل آلاف
  const json = JSON.parse(JSON.stringify(gl, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const check = (node: unknown, key: string): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const v of node) check(v, key); return; }
    if (typeof node === 'object') { for (const [k, v] of Object.entries(node)) check(v, k); return; }
    if (key.endsWith('Milli')) {
      assert.equal(typeof node, 'string', `مبلغ غير نصّي بعد التسلسل: ${key}`);
      assert.match(String(node), /^-?\d+$/, `مبلغ غير صحيح بالملّي: ${key}=${String(node)}`);
    }
  };
  check(json, 'result');
  assert.equal(json.sections[0].endingMilli, String(gl.sections[0].endingMilli));
});
