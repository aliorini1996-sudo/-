// «تتبّع اللوط» — T3: تشغيلة المرتجع بلا دليل (attributeUnnamedReturnRows، طلب المالك ١٦ نوفمبر ٢٠٢٦):
// «المرتجع يدخل كـLOT جديد غير مسمى… مفروض يتم ربطه بـLOT سابق». كل صفٍّ بقي بلا تشغيلة بعد الصريح والوراثة يُنسب إلى أول
// مرشّحٍ لصنفه (العميل ثم السيارة ثم الشركة) ASSUMED بوسم طبقته، والكمية ومصدر الصفّ كما هما (I3 وreturnedBySource).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOT_EPS, LOT_ROW_FLAGS, RETURN_GUESS_TIERS, allocateReturnFromHistory, allocateReturnFromSale, attributeUnnamedReturnRows, isReturnGuessRow,
  rankReturnGuesses, stampFromRows,
  type AllocRow, type ReturnGuessCandidate, type SaleLotRow,
} from '../services/lots';

const RDAY = '2026-11-16';
type Row = AllocRow & { productId: string; line: number };
const row = (o: Partial<Row> & { qty: number }): Row => ({
  productId: 'p', line: 0, lotId: null, certainty: 'UNKNOWN', flags: [], expiryDate: null, sourceItemLotId: null, ...o,
});
const cand = (lotId: string, tier: ReturnGuessCandidate['tier'], o: Partial<ReturnGuessCandidate> = {}): ReturnGuessCandidate => ({
  lotId, lotNumber: `N-${lotId}`, expiryDate: '2027-06-01', status: 'ACTIVE', tier, ...o,
});
const brief = (rows: AllocRow[]) => rows.map((r) => [r.lotId, +r.qty.toFixed(6), r.certainty, r.flags, r.sourceItemLotId ?? null]);
const sumOf = (rows: { qty: number }[]) => rows.reduce((s, r) => s + r.qty, 0);

test('LOT_ROW_FLAGS المجمَّدة: الأربعة الجديدة تُلحق آخراً فلا يتغيّر ترتيب وسوم الصفوف القائمة', () => {
  assert.deepEqual([...LOT_ROW_FLAGS], [
    'REPLAY_BLOCKED', 'REPLAY_RECALLED', 'REPLAY_EXPIRED', 'REPLAY_CLAMPED', 'HINT_REJECTED', 'SPLIT_UNIT',
    'EXPLICIT_FALLBACK', 'RETURN_GUESS_CUSTOMER', 'RETURN_GUESS_VAN', 'RETURN_GUESS_COMPANY',
  ]);
  assert.deepEqual([...RETURN_GUESS_TIERS], ['RETURN_GUESS_CUSTOMER', 'RETURN_GUESS_VAN', 'RETURN_GUESS_COMPANY']);
  for (const t of RETURN_GUESS_TIERS) assert.ok((LOT_ROW_FLAGS as readonly string[]).includes(t));
});

test('attributeUnnamedReturnRows: الصفّ بلا تشغيلة ⇒ أول مرشّح ASSUMED بوسم طبقته وانتهاء بطاقته؛ الكمية والمصدر والحقول الإضافية كما هي', () => {
  const rows: Row[] = [
    row({ lotId: 'L9', qty: 2, certainty: 'ASSUMED', expiryDate: '2027-01-01', sourceItemLotId: 's9' }),
    row({ qty: 3, sourceItemLotId: 's1' }),
    row({ qty: 4, line: 1, flags: ['HINT_REJECTED'] }),
  ];
  const frozen = JSON.stringify(rows);
  const cands = new Map([['p', [cand('L1', 'RETURN_GUESS_CUSTOMER', { expiryDate: '2026-12-31' })]]]);
  const r = attributeUnnamedReturnRows(rows, cands, RDAY);
  assert.deepEqual(brief(r.rows), [
    ['L9', 2, 'ASSUMED', [], 's9'],
    ['L1', 3, 'ASSUMED', ['RETURN_GUESS_CUSTOMER'], 's1'],
    ['L1', 4, 'ASSUMED', ['HINT_REJECTED', 'RETURN_GUESS_CUSTOMER'], null],
  ]);
  assert.deepEqual(r.rows.map((x) => [x.productId, x.line, x.expiryDate]), [['p', 0, '2027-01-01'], ['p', 0, '2026-12-31'], ['p', 1, '2026-12-31']]);
  assert.equal(r.rows[0], rows[0], 'الصفّ المسمّى يمرّ كما هو');
  assert.deepEqual(r.warnings, []);
  assert.equal(JSON.stringify(rows), frozen, 'لا تُعدَّل المدخلات');
  // I3: Σ كل سطر كما كان
  for (const line of [0, 1]) assert.equal(sumOf(r.rows.filter((x) => x.line === line)), sumOf(rows.filter((x) => x.line === line)));
});

test('بلا مرشّح لصنفه ⇒ UNKNOWN كما هو (D25: صنفٌ بلا تشغيلةٍ مسمّاة في الحقبة)', () => {
  const rows = [row({ qty: 5 }), row({ qty: 1, productId: 'q' })];
  const r = attributeUnnamedReturnRows(rows, new Map([['other', [cand('L1', 'RETURN_GUESS_COMPANY')]], ['q', []]]), RDAY);
  assert.deepEqual(r.rows, rows);
  assert.deepEqual(r.warnings, []);
  // ومرشّحٌ تالف (بلا معرّف أو بطبقةٍ مجهولة) يُهمل
  const bad = [{ ...cand('', 'RETURN_GUESS_VAN') }, { ...cand('L2', 'RETURN_GUESS_VAN'), tier: 'NOPE' as unknown as ReturnGuessCandidate['tier'] }];
  assert.deepEqual(attributeUnnamedReturnRows(rows, new Map([['p', bad]]), RDAY).rows, rows);
});

test('ترتيب المرشّحين: الطبقة أولاً، وداخلها ACTIVE صالح ثم ACTIVE منتهٍ ثم HOLD ثم RECALL ثم ترتيب الإدخال؛ والتكرار يبقى في أعلى طبقة', () => {
  const list: ReturnGuessCandidate[] = [
    cand('vanActive', 'RETURN_GUESS_VAN'),
    cand('custRecall', 'RETURN_GUESS_CUSTOMER', { status: 'BLOCKED', blockKind: 'RECALL' }),
    cand('custHold', 'RETURN_GUESS_CUSTOMER', { status: 'BLOCKED', blockKind: 'HOLD' }),
    cand('custExpired', 'RETURN_GUESS_CUSTOMER', { expiryDate: '2026-11-15' }),
    cand('custNew', 'RETURN_GUESS_CUSTOMER'),
    cand('custOld', 'RETURN_GUESS_CUSTOMER', { expiryDate: RDAY }), // يوم الانتهاء نفسه ليس انتهاءً
    cand('custNew', 'RETURN_GUESS_VAN'),
    cand('co', 'RETURN_GUESS_COMPANY'),
    cand('vanActive', 'RETURN_GUESS_COMPANY'),
  ];
  assert.deepEqual(rankReturnGuesses(list, RDAY).map((c) => [c.lotId, c.tier]), [
    ['custNew', 'RETURN_GUESS_CUSTOMER'], ['custOld', 'RETURN_GUESS_CUSTOMER'], ['custExpired', 'RETURN_GUESS_CUSTOMER'],
    ['custHold', 'RETURN_GUESS_CUSTOMER'], ['custRecall', 'RETURN_GUESS_CUSTOMER'],
    ['vanActive', 'RETURN_GUESS_VAN'], ['co', 'RETURN_GUESS_COMPANY'],
  ]);
  // تشغيلة العميل المنتهية تسبق تشغيلة السيارة الصالحة: الترتيب بالحالة داخل الطبقة لا عبرها
  const r = attributeUnnamedReturnRows([row({ qty: 1 })], new Map([['p', [cand('v', 'RETURN_GUESS_VAN'), cand('c', 'RETURN_GUESS_CUSTOMER', { expiryDate: '2026-01-01' })]]]), RDAY);
  assert.deepEqual(brief(r.rows), [['c', 1, 'ASSUMED', ['RETURN_GUESS_CUSTOMER'], null]]);
  // بلا العميل: السيارة، ثم الشركة
  const v = attributeUnnamedReturnRows([row({ qty: 1 })], new Map([['p', [cand('co', 'RETURN_GUESS_COMPANY'), cand('v', 'RETURN_GUESS_VAN')]]]), RDAY);
  assert.deepEqual(brief(v.rows), [['v', 1, 'ASSUMED', ['RETURN_GUESS_VAN'], null]]);
  const c = attributeUnnamedReturnRows([row({ qty: 1 })], new Map([['p', [cand('co', 'RETURN_GUESS_COMPANY')]]]), RDAY);
  assert.deepEqual(brief(c.rows), [['co', 1, 'ASSUMED', ['RETURN_GUESS_COMPANY'], null]]);
});

test('تشغيلةٌ موقوفة مخمَّنة ⇒ LOT_INTO_BLOCKED مرةً لكل تشغيلة بطبقتها، ولكل صنفٍ مرشّحه', () => {
  const rows = [row({ qty: 1 }), row({ qty: 2, line: 1 }), row({ qty: 3, productId: 'q' })];
  const r = attributeUnnamedReturnRows(rows, new Map([
    ['p', [cand('H', 'RETURN_GUESS_VAN', { status: 'BLOCKED', blockKind: 'HOLD' })]],
    ['q', [cand('Q', 'RETURN_GUESS_COMPANY')]],
  ]), RDAY);
  assert.deepEqual(r.rows.map((x) => [x.productId, x.lotId]), [['p', 'H'], ['p', 'H'], ['q', 'Q']]);
  assert.deepEqual(r.warnings, [{ code: 'LOT_INTO_BLOCKED', productId: 'p', detail: { lotId: 'H', lotNumber: 'N-H', blockKind: 'HOLD', tier: 'RETURN_GUESS_VAN' } }]);
});

test('كسرٌ أدقّ من أربع خانات: أرضيته للتشغيلة وباقيه UNKNOWN بمصدره — لا غبار في لوطٍ مسمّى، وΣ كما هو', () => {
  const rows = [row({ qty: 2.00005, sourceItemLotId: 's1' }), row({ qty: 0.00004, sourceItemLotId: 's2' })];
  const r = attributeUnnamedReturnRows(rows, new Map([['p', [cand('L1', 'RETURN_GUESS_CUSTOMER')]]]), RDAY);
  assert.deepEqual(r.rows.map((x) => [x.lotId, x.certainty, x.sourceItemLotId]), [['L1', 'ASSUMED', 's1'], [null, 'UNKNOWN', 's1'], [null, 'UNKNOWN', 's2']]);
  assert.equal(r.rows[0].qty, 2);
  assert.ok(Math.abs(sumOf(r.rows) - sumOf(rows)) < 1e-12);
});

test('المرتجع المرتبط: بيعٌ بلا صفوف ⇒ تخمينٌ بلا مصدر؛ وصفّ بيعٍ UNKNOWN ⇒ التخمين يبقى مصدره صفَّ البيع المرتبط نفسه', () => {
  const linked = (saleRows: SaleLotRow[], qty: number, returned = new Map<string, number>()) =>
    allocateReturnFromSale({ qty, returnDay: RDAY, saleRows, returnedBySource: returned }).map((r) => ({ ...r, productId: 'p' }));
  const cands = new Map([['p', [cand('Lc', 'RETURN_GUESS_CUSTOMER')]]]);
  assert.deepEqual(brief(attributeUnnamedReturnRows(linked([], 4), cands, RDAY).rows), [['Lc', 4, 'ASSUMED', ['RETURN_GUESS_CUSTOMER'], null]]);
  const sale: SaleLotRow[] = [
    { id: 'sN', lotId: 'L1', quantity: 2, certainty: 'ASSUMED', expiryDate: '2027-01-01' },
    { id: 'sU', lotId: null, quantity: 5, certainty: 'UNKNOWN', expiryDate: null },
  ];
  const r = attributeUnnamedReturnRows(linked(sale, 9), cands, RDAY);
  // صفّ البيع المسمّى يُورث كما كان، وUNKNOWN بمصدره sU يُخمَّن ويبقى مصدره sU، والفائض بلا مصدر
  assert.deepEqual(brief(r.rows), [
    ['L1', 2, 'ASSUMED', [], 'sN'],
    ['Lc', 5, 'ASSUMED', ['RETURN_GUESS_CUSTOMER'], 'sU'],
    ['Lc', 2, 'ASSUMED', ['RETURN_GUESS_CUSTOMER'], null],
  ]);
  assert.equal(sumOf(r.rows), 9);
});

test('المرتجع الحرّ: ما فاق مبيعات العميل المسمّاة يُخمَّن من مشترياته بلا مصدر (لا يستهلك صفّ بيع)', () => {
  const sales: SaleLotRow[][] = [[{ id: 's1', lotId: 'L1', quantity: 5, certainty: 'CONFIRMED', expiryDate: '2027-01-01' }]];
  const fromHistory = allocateReturnFromHistory({ qty: 8, returnDay: RDAY, sales, returnedBySource: new Map() }).map((r) => ({ ...r, productId: 'p' }));
  const r = attributeUnnamedReturnRows(fromHistory, new Map([['p', [cand('L1', 'RETURN_GUESS_CUSTOMER')]]]), RDAY);
  assert.deepEqual(brief(r.rows), [['L1', 5, 'ASSUMED', [], 's1'], ['L1', 3, 'ASSUMED', ['RETURN_GUESS_CUSTOMER'], null]]);
  // returnedBySource يحسب صفوف sourceItemLotId وحدها: 5 من s1 كما كان، والمخمَّن لا يمسّ أي صفّ بيع
  const bySource = new Map<string, number>();
  for (const x of r.rows) if (x.sourceItemLotId) bySource.set(x.sourceItemLotId, (bySource.get(x.sourceItemLotId) ?? 0) + x.qty);
  assert.deepEqual([...bySource], [['s1', 5]]);
});

test('الختم والتوجيه (D6/D12) لا يقرآن المخمَّن: تخمينٌ منتهٍ لا يقلب returnExpired، والصفّ الموروث وحده يختم', () => {
  const guessed = attributeUnnamedReturnRows([row({ qty: 3 })], new Map([['p', [cand('Lx', 'RETURN_GUESS_VAN', { expiryDate: '2026-10-01' })]]]), RDAY).rows;
  assert.equal(isReturnGuessRow(guessed[0]), true);
  assert.equal(stampFromRows(guessed, RDAY), null, 'كـUNKNOWN اليوم: الختم الاحتياطي يبقى');
  const inherited: AllocRow = { lotId: 'L1', qty: 2, certainty: 'ASSUMED', flags: [], expiryDate: '2027-02-01', sourceItemLotId: 's1' };
  assert.deepEqual(stampFromRows([inherited, ...guessed], RDAY), { expiresAt: '2027-02-01', returnExpired: false });
  // والصفوف بلا وسوم (البيع والقديم) كما كانت
  assert.deepEqual(stampFromRows([{ lotId: 'a', expiryDate: '2026-10-01' }], RDAY), { expiresAt: '2026-10-01', returnExpired: true });
  assert.equal(isReturnGuessRow({ flags: ['SPLIT_UNIT', 'EXPLICIT_FALLBACK'] }), false);
  assert.equal(isReturnGuessRow({}), false);
});

test('خاصيّة: I3 لكل سطر، ولا صفّ مسمّى خارج الشبكة، والمسمّى قبله لا يتغيّر، وبلا مرشّحين لا يتغيّر شيء', () => {
  let seed = 20261116;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let iter = 0; iter < 400; iter++) {
    const rows: Row[] = [];
    const n = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) {
      const named = rand() < 0.4;
      const qty = rand() < 0.2 ? 1 + rand() * 3 : Math.round(rand() * 400000) / 10000 + 0.0001;
      rows.push(row({
        qty, line: Math.floor(rand() * 3), productId: rand() < 0.5 ? 'p' : 'q',
        lotId: named ? 'N1' : null, certainty: named ? 'ASSUMED' : 'UNKNOWN', sourceItemLotId: rand() < 0.5 ? `s${i}` : null,
      }));
    }
    const cands = new Map<string, ReturnGuessCandidate[]>();
    if (rand() < 0.7) cands.set('p', [cand('P1', RETURN_GUESS_TIERS[Math.floor(rand() * 3)], { status: rand() < 0.2 ? 'BLOCKED' : 'ACTIVE' })]);
    const r = attributeUnnamedReturnRows(rows, cands, RDAY);
    for (const line of [0, 1, 2]) {
      for (const pid of ['p', 'q']) {
        const before = sumOf(rows.filter((x) => x.line === line && x.productId === pid));
        const after = sumOf(r.rows.filter((x) => x.line === line && x.productId === pid));
        assert.ok(Math.abs(before - after) <= LOT_EPS, 'I3');
      }
    }
    for (const x of r.rows) {
      if (x.lotId === 'P1') {
        assert.equal(x.productId, 'p');
        assert.equal(x.certainty, 'ASSUMED');
        assert.ok(isReturnGuessRow(x));
        assert.ok(Math.abs(Math.round(x.qty * 10000) / 10000 - x.qty) < 1e-9, `غبار في مسمّى ${x.qty}`);
      }
      if (x.productId === 'q') assert.notEqual(x.lotId, 'P1');
    }
    assert.deepEqual(r.rows.filter((x) => x.lotId === 'N1'), rows.filter((x) => x.lotId === 'N1'));
    if (!cands.size) assert.deepEqual(r.rows, rows);
  }
});
