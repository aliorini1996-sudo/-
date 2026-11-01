// «تصفير المخزون» حدٌّ لدفعات الصلاحية بأساس تحميل السيارة (services/invoiceExpiry.ts vanLoadBatchAt) — تشغيلاً فوق
// قاعدةٍ مزيّفة في الذاكرة تُمرَّر لـsaleExpiryFor، بلا قاعدة بيانات ولا شبكة.
//
// ما يُحرس: بلا تصفيرٍ للمندوب الاستعلامات كما كانت حرفاً بحرف (والنتيجة نفسها)؛ وبعد التصفير يُطابَق البيع الجديد بدفعة
// ما بعد التصفير لا بدفعةٍ صُفّرت؛ وبيعٌ بلا تحميلٍ بعد التصفير يقع على ما يقع عليه اليوم بلا دفعة (null — لا تخمين).
// والبيع دون اتصال قبل التصفير المرفوع بعده يُقاس حدُّه بلحظته على الجهاز (clientCreatedAt) لا بلحظة الرفع، ولا يُعدّ مصروفاً
// من دفعات ما بعد التصفير.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
// القاعدة الحقيقية لا تُستورد أصلاً: كل قراءةٍ هنا عبر `db` المُمرَّر
stub('config/database', { default: {} });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { saleExpiryFor } = require('../services/invoiceExpiry') as typeof import('../services/invoiceExpiry');

type Row = Record<string, any>;
const T = 'T1';
const day = (d: number, h = 10) => new Date(Date.UTC(2026, 9, d, h));
const LIFE = { shelfLifeEnabled: true, shelfLifeValue: 10, shelfLifeUnit: 'DAY', shelfLifeBasis: 'VAN_LOAD' };

let st: { loads: Row[]; items: Row[]; inv: Row[]; calls: { model: string; op: string; args: Row }[] };
const reset = () => { st = { loads: [], items: [], inv: [], calls: [] }; };
reset();

const dateOk = (w: any, d: Date) => !w
  || ((!w.lte || d <= w.lte) && (!w.lt || d < w.lt) && (!w.gte || d >= w.gte) && (!w.gt || d > w.gt));
const eqOrNot = (w: any, x: unknown) => {
  if (w === undefined) return true;
  if (w && typeof w === 'object' && 'not' in w) return x !== w.not;
  return w === x;
};
// شرط وثيقة الحركة/الفاتورة بما فيه AND المتداخل (حدّ التصفير)
const loadOk = (l: Row, w: Row = {}): boolean => (!w.tenantId || w.tenantId === l.tenantId)
  && (!w.salesRepId || w.salesRepId === l.salesRepId)
  && (!w.type || w.type === l.type)
  && (w.zeroRunId === undefined || eqOrNot(w.zeroRunId, l.zeroRunId ?? null))
  && dateOk(w.createdAt, l.createdAt)
  && (w.AND ?? []).every((x: Row) => loadOk(l, x));
// clientCreatedAt: null = «بلا لحظة جهاز»، وإلا شرط تاريخٍ لا يطابق الفارغ (كـPrisma)
const deviceOk = (w: any, d: Date | null | undefined) => w === undefined
  || (w === null ? d == null : d != null && dateOk(w, d));
const invOk = (i: Row, w: Row = {}): boolean => (!w.tenantId || w.tenantId === i.tenantId)
  && (!w.salesRepId || w.salesRepId === i.salesRepId)
  && (!w.status || w.status === i.status)
  && eqOrNot(w.type, i.type) && eqOrNot(w.id, i.id)
  && dateOk(w.invoiceDate, i.invoiceDate)
  && deviceOk(w.clientCreatedAt, i.clientCreatedAt)
  && (w.AND ?? []).every((x: Row) => invOk(i, x))
  && (w.OR === undefined || (w.OR as Row[]).some((x) => invOk(i, x)));
const sum = (rows: Row[]) => (rows.length ? rows.reduce((s, r) => s + r.baseQty, 0) : null);
const log = (model: string, op: string, args: Row) => { st.calls.push({ model, op, args }); };

const db: Row = {
  vanLoad: {
    async findFirst(a: Row) {
      log('vanLoad', 'findFirst', a);
      const rows = st.loads.filter((l) => loadOk(l, a.where)).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
      return rows[0] ? { createdAt: rows[0].createdAt } : null;
    },
  },
  vanLoadItem: {
    async findMany(a: Row) {
      log('vanLoadItem', 'findMany', a);
      return st.items.filter((it) => it.productId === a.where.productId && loadOk(it.vanLoad, a.where.vanLoad))
        .map((it) => ({ qty: it.qty, unitFactor: it.unitFactor, baseQty: it.baseQty, vanLoad: { createdAt: it.vanLoad.createdAt } }));
    },
    async aggregate(a: Row) {
      log('vanLoadItem', 'aggregate', a);
      return { _sum: { baseQty: sum(st.items.filter((it) => it.productId === a.where.productId && loadOk(it.vanLoad, a.where.vanLoad))) } };
    },
  },
  invoiceItem: {
    async aggregate(a: Row) {
      log('invoiceItem', 'aggregate', a);
      return { _sum: { baseQty: sum(st.inv.filter((it) => it.productId === a.where.productId && invOk(it.invoice, a.where.invoice))) } };
    },
  },
};

let seq = 0;
/** حركة سيارة بسطرٍ واحد للصنف P1 بالأساس (qty × factor) */
const move = (type: string, at: Date, qty: number, extra: Row = {}) => {
  const l = { id: `L${++seq}`, tenantId: T, salesRepId: 'R1', type, createdAt: at, zeroRunId: null, ...extra };
  st.loads.push(l);
  st.items.push({ productId: 'P1', qty: Math.abs(qty), unitFactor: 1, baseQty: Math.abs(qty), vanLoad: l });
  return l;
};
const sold = (at: Date, qty: number, extra: Row = {}) => st.inv.push({
  productId: 'P1', baseQty: qty, invoice: { id: `I${++seq}`, tenantId: T, salesRepId: 'R1', status: 'CONFIRMED', type: 'CASH', invoiceDate: at, ...extra },
});
const expiryOf = async (at: Date, clientCreatedAt?: Date | null) => (await saleExpiryFor(T, 'UTC', LIFE,
  { invoiceId: 'NEW', invoiceDate: at, salesRepId: 'R1', productId: 'P1', ...(clientCreatedAt !== undefined ? { clientCreatedAt } : {}) }, db as never))
  ?.toISOString().slice(0, 10) ?? null;

test('بلا تصفيرٍ للمندوب: الاستعلامات الثلاثة كما كانت حرفاً بحرف، والدفعة الأقدم غير المستنفدة', async () => {
  reset();
  move('LOAD', day(1), 50);
  move('LOAD', day(5), 50);
  sold(day(3), 30);
  // تسويةٌ عادية (بلا zeroRunId) ليست حدّاً
  move('ADJUST', day(4), -10);
  const at = day(6);
  assert.equal(await expiryOf(at), '2026-10-11', '٣٠ مُباعة من دفعة ١ أكتوبر (٥٠) فما زال البيع منها');
  const [cutQ, ...rest] = st.calls;
  assert.deepEqual(cutQ, { model: 'vanLoad', op: 'findFirst', args: {
    where: { tenantId: T, salesRepId: 'R1', zeroRunId: { not: null }, createdAt: { lte: at } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  } });
  const by = (m: string, op: string, type?: string) => rest.find((c) => c.model === m && c.op === op && (!type || c.args.where.vanLoad?.type === type))!.args;
  assert.deepEqual(by('vanLoadItem', 'findMany'), {
    where: { productId: 'P1', vanLoad: { tenantId: T, salesRepId: 'R1', type: 'LOAD', createdAt: { lte: at } } },
    select: { qty: true, unitFactor: true, baseQty: true, vanLoad: { select: { createdAt: true } } },
  });
  assert.deepEqual(by('invoiceItem', 'aggregate'), {
    where: { productId: 'P1', invoice: { tenantId: T, salesRepId: 'R1', status: 'CONFIRMED', type: { not: 'RETURN' }, id: { not: 'NEW' }, invoiceDate: { lt: at } } },
    _sum: { baseQty: true },
  });
  assert.deepEqual(by('vanLoadItem', 'aggregate', 'UNLOAD'), {
    where: { productId: 'P1', vanLoad: { tenantId: T, salesRepId: 'R1', type: 'UNLOAD', createdAt: { lt: at } } },
    _sum: { baseQty: true },
  });
});

test('تصفيرٌ بين تحميلٍ قديم وتحميلٍ جديد: البيع الجديد من دفعة ما بعد التصفير', async () => {
  reset();
  move('LOAD', day(1), 100); // لم يُبع منها إلا ١٠ — ٩٠ صُفّرت
  sold(day(2), 10);
  move('ADJUST', day(3, 9), -90, { zeroRunId: 'Z1' });
  move('LOAD', day(4), 40);
  // بلا الحدّ: ١٠ مُباعة < ١٠٠ ⇒ دفعة ١ أكتوبر ⇒ انتهاء ١١ أكتوبر (أبكر من الحقيقي)
  assert.equal(await expiryOf(day(6)), '2026-10-14', 'من تحميل ٤ أكتوبر');
  // والمصروف بعد التصفير وحده: ٤٠ مُباعة بعده تستنفد دفعة ٤ أكتوبر فيُنسب ما بعدها لدفعة ٨ أكتوبر
  move('LOAD', day(8), 40);
  sold(day(7), 40);
  assert.equal(await expiryOf(day(9)), '2026-10-18');
  // وتنزيلٌ للمستودع قبل التصفير لا يُستهلك من دفعات ما بعده
  reset();
  move('LOAD', day(1), 100);
  move('UNLOAD', day(2), 60);
  move('ADJUST', day(3, 9), -40, { zeroRunId: 'Z1' });
  move('LOAD', day(4), 30);
  move('LOAD', day(5), 30);
  assert.equal(await expiryOf(day(6)), '2026-10-14', 'التنزيل القديم (٦٠) لا يقفز فوق دفعة ٤ أكتوبر');
});

test('الحدّ آخر تصفيرٍ حتى لحظة البيع: بيعٌ قديم يُقاس على دفعاته، وتصفيرٌ لاحق لا يمسّه', async () => {
  reset();
  move('LOAD', day(1), 100);
  move('ADJUST', day(3, 9), -100, { zeroRunId: 'Z1' });
  move('LOAD', day(4), 50);
  move('ADJUST', day(6, 9), -50, { zeroRunId: 'Z2' });
  move('LOAD', day(7), 20);
  assert.equal(await expiryOf(day(2)), '2026-10-11', 'قبل كل تصفير: دفعة ١ أكتوبر');
  assert.equal(await expiryOf(day(5)), '2026-10-14', 'بين التصفيرين: دفعة ٤ أكتوبر');
  assert.equal(await expiryOf(day(8)), '2026-10-17', 'بعد الثاني: دفعة ٧ أكتوبر');
  // تصفيرُ مندوبٍ آخر ليس حدّاً لهذا المندوب
  reset();
  move('LOAD', day(1), 100);
  move('ADJUST', day(3, 9), -100, { zeroRunId: 'Z1', salesRepId: 'R2' });
  move('LOAD', day(4), 50);
  assert.equal(await expiryOf(day(5)), '2026-10-11');
});

test('بيعٌ بلا تحميلٍ بعد التصفير: كما اليوم بلا دفعة — null (لا تخمين)، وتحميلٌ لاحق للبيع لا يُحسب', async () => {
  reset();
  move('LOAD', day(1), 100);
  move('ADJUST', day(3, 9), -100, { zeroRunId: 'Z1' });
  assert.equal(await expiryOf(day(5)), null, 'دفعة ما قبل التصفير لا تُنسب لبيعٍ بعده');
  move('LOAD', day(6), 10);
  assert.equal(await expiryOf(day(5)), null, 'التحميل بعد لحظة البيع ليس دفعته');
  // والسلوك نفسه لمندوبٍ بلا أيّ تحميل ولا تصفير — المرجع
  reset();
  assert.equal(await expiryOf(day(5)), null);
  // وصنفٌ بلا صلاحية أو بيعٌ بلا مندوب: لا استعلام أصلاً
  reset();
  assert.equal(await saleExpiryFor(T, 'UTC', { ...LIFE, shelfLifeEnabled: false }, { invoiceId: 'N', invoiceDate: day(5), salesRepId: 'R1', productId: 'P1' }, db as never), null);
  assert.equal(await saleExpiryFor(T, 'UTC', LIFE, { invoiceId: 'N', invoiceDate: day(5), salesRepId: null, productId: 'P1' }, db as never), null);
  assert.equal(st.calls.length, 0);
});

test('بيعٌ دون اتصال قبل التصفير رُفع بعده: من دفعته قبل التصفير، ولا يدفع البيع الحقيقي التالي إلى دفعةٍ أحدث', async () => {
  reset();
  move('LOAD', day(1), 100); // الدفعة A
  // البيع دون اتصال على الجهاز ٢ أكتوبر (١٠) — لم يُرفع بعد
  move('ADJUST', day(3, 9), -90, { zeroRunId: 'Z1' });
  move('LOAD', day(4), 40); // الدفعة B
  // بيعٌ حقيقي بعد التصفير (رُفع فوراً، ولحظة جهازه معه) — ٣٥ من B فيبقى منها ٥
  sold(day(4, 12), 35, { clientCreatedAt: day(4, 11) });
  // الرفع ٥ أكتوبر: لحظة الجهاز قبل التصفير ⇒ لا حدّ ⇒ الدفعة A (قبل الإصلاح: الحدّ ٣ أكتوبر ⇒ B ⇒ ١٤ أكتوبر)
  st.calls = [];
  assert.equal(await expiryOf(day(5), day(2)), '2026-10-11', 'من الدفعة A');
  assert.deepEqual(st.calls[0].args.where.createdAt, { lte: day(2) }, 'الحدّ حتى لحظة الجهاز');
  // ولحظة الرفع ما زالت حدّ التحميلات والمبيعات السابقة كما كانت
  assert.deepEqual(st.calls.find((c) => c.model === 'vanLoadItem' && c.op === 'findMany')!.args.where.vanLoad.createdAt, { lte: day(5) });
  assert.deepEqual(st.calls.find((c) => c.model === 'invoiceItem')!.args.where.invoice.invoiceDate, { lt: day(5) });
  sold(day(5), 10, { clientCreatedAt: day(2) });
  move('LOAD', day(6), 40); // الدفعة C
  // البيع الحقيقي التالي: المصروف بعد التصفير ٣٥ وحده (لا ٤٥) ⇒ ما زال من B (قبل الإصلاح: ٤٥ > ٤٠ ⇒ C ⇒ ١٦ أكتوبر)
  assert.equal(await expiryOf(day(7)), '2026-10-14', 'من الدفعة B لا C');
  assert.equal(await expiryOf(day(7), day(7, 9)), '2026-10-14', 'وبلحظة جهازٍ بعد التصفير: النتيجة نفسها');
  // وبيعٌ رُفع قبل التصفير وإن تقدّمت ساعة جهازه بعده: خرج قبله فلا يُعدّ مصروفاً بعده
  sold(day(3, 8), 5, { clientCreatedAt: day(3, 20) });
  assert.equal(await expiryOf(day(7)), '2026-10-14', 'ما رُفع قبل التصفير لا يُستهلك من B');
});

test('لحظة جهازٍ بعد لحظة الرفع (ساعةٌ متقدّمة) لا تُعتمد: تصفيرٌ بعد الرفع ليس حدّاً لبيعٍ قبله', async () => {
  reset();
  move('LOAD', day(1), 100);
  move('ADJUST', day(3, 9), -100, { zeroRunId: 'Z1' });
  move('LOAD', day(4), 50);
  st.calls = [];
  assert.equal(await expiryOf(day(2), day(5)), '2026-10-11');
  assert.deepEqual(st.calls[0].args.where.createdAt, { lte: day(2) });
});

test('بلا تصفيرٍ للمندوب ولحظة جهازٍ مختلفة: الاستعلامات الثلاثة كما كانت حرفاً بحرف (بلحظة الرفع)', async () => {
  reset();
  move('LOAD', day(1), 50);
  move('LOAD', day(5), 50);
  sold(day(3), 30, { clientCreatedAt: day(2) });
  const at = day(6);
  assert.equal(await expiryOf(at, day(4)), '2026-10-11');
  const [cutQ, ...rest] = st.calls;
  assert.deepEqual(cutQ.args.where, { tenantId: T, salesRepId: 'R1', zeroRunId: { not: null }, createdAt: { lte: day(4) } });
  assert.deepEqual(rest.find((c) => c.model === 'vanLoadItem' && c.op === 'findMany')!.args.where,
    { productId: 'P1', vanLoad: { tenantId: T, salesRepId: 'R1', type: 'LOAD', createdAt: { lte: at } } });
  assert.deepEqual(rest.find((c) => c.model === 'invoiceItem')!.args.where,
    { productId: 'P1', invoice: { tenantId: T, salesRepId: 'R1', status: 'CONFIRMED', type: { not: 'RETURN' }, id: { not: 'NEW' }, invoiceDate: { lt: at } } });
  assert.deepEqual(rest.find((c) => c.model === 'vanLoadItem' && c.op === 'aggregate')!.args.where,
    { productId: 'P1', vanLoad: { tenantId: T, salesRepId: 'R1', type: 'UNLOAD', createdAt: { lt: at } } });
});

test('حارس نصّي: لحظة الجهاز تُمرَّر من كل موضعٍ يحسب صلاحية بيعٍ قائم', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
  const svc = read('services/invoiceExpiry.ts');
  const calls = svc.split('await saleExpiryFor(').length - 1;
  assert.equal((svc.match(/clientCreatedAt: (?:inv|sale\.invoice|r\.invoice)\.clientCreatedAt,/g) ?? []).length, calls, 'كل استدعاءٍ يمرّر لحظة الجهاز');
  assert.equal((svc.match(/invoice: \{ select: \{ invoiceDate: true, clientCreatedAt: true, salesRepId: true \} \}/g) ?? []).length, 4,
    'المرتبط والحرّ والقيد والمرتجع المرتبط قبل الإصدار');
  assert.ok(svc.includes('zeroCutoffAt(tenantId, repId, deviceAt, db)'));
  const inv = read('routes/invoices.ts');
  assert.ok(inv.includes('clientCreatedAt: sale.clientCreatedAt,') && inv.includes('id: true, number: true, invoiceDate: true, clientCreatedAt: true,'),
    'شاشة اختيار فاتورة البيع');
});
