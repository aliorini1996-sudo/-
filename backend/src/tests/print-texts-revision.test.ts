// «نصوص المطبوعات» — الحفظ المشروط بالمراجعة (بلاغ ٤ نوفمبر ٢٠٢٦، D-G2): مديرٌ ثانٍ أو نافذةٌ قديمة كان حفظها يستبدل العمود كلّه
// فيمسح صياغات غيره وحذوفه بلا تنبيه. الآن القراءة والحفظ يعيدان rev، والحفظ برأس x-print-texts-rev يُقرأ ويُقارن ويُكتب في معاملة
// واحدة: مراجعةٌ قديمة ⇒ 409 PRINT_TEXTS_STALE بلا كتابة. وبلا الرأس (حزمةٌ أقدم) الحفظ كما كان حرفياً.
// المعالجات الحقيقية فوق Prisma مزيّف في الذاكرة (نمط print-texts.test.ts) — والمزيّف يعيد ترتيب المفاتيح كما يفعل jsonb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { emptyPrintTexts, type PrintTextsV1 } from '../services/printTexts';

const SRC = path.join(__dirname, '..');
type Row = Record<string, any>;
const T = 'T1';

const stub = (r: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, r));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/** jsonb يخزّن المفاتيح مرتّبةً بالطول ثم بالبايت — فما يُقرأ بعد الحفظ ليس بترتيب ما كُتب */
function jsonbOrder(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(jsonbOrder);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map((k) => [k, jsonbOrder(o[k])]));
}

/** مساواة jsonb: بنيوية لا تتأثر بترتيب المفاتيح — للمزيّف وحده (مستقلّة عن بصمة المسار) */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}
/** شرط عمود printTexts في where كما ينفّذه PostgreSQL: AnyNull/DbNull ⇒ IS NULL، وقيمةٌ ⇒ jsonb = jsonb */
function jsonFilterMatches(cur: unknown, f: Row | undefined): boolean {
  if (f === undefined) return true;
  assert.deepEqual(Object.keys(f), ['equals'], 'شرط العمود مساواةٌ وحدها');
  if (f.equals === Prisma.AnyNull || f.equals === Prisma.DbNull) return cur === null;
  return cur !== null && canon(cur) === canon(f.equals);
}

let st: { admin: Row | null; settings: Row | null };
let writes: Row[] = [];
let txCount = 0;
/** خطّافٌ ينفَّذ قبل كل قراءة لصفّ الإعدادات — لمحاكاة حفظين يقرآن العمود قبل أن يكتب أيٌّ منهما */
let beforeRead: (() => Promise<void>) | null = null;
function reset(printTexts: unknown = null): void {
  writes = [];
  txCount = 0;
  beforeRead = null;
  st = { admin: { isActive: true, canManageCompanySettings: true }, settings: { tenantId: T, name: 'شركة', printTexts } };
}
reset();
const companySettings = {
  async findUnique(a: Row) {
    if (beforeRead) await beforeRead();
    if (!st.settings || a.where.tenantId !== st.settings.tenantId) return null;
    return { printTexts: st.settings.printTexts };
  },
  async updateMany(a: Row) {
    writes.push(a);
    if (!st.settings || a.where.tenantId !== st.settings.tenantId) return { count: 0 };
    if (!jsonFilterMatches(st.settings.printTexts, a.where.printTexts)) return { count: 0 };
    st.settings.printTexts = a.data.printTexts === Prisma.DbNull ? null : jsonbOrder(JSON.parse(JSON.stringify(a.data.printTexts)));
    return { count: 1 };
  },
  async upsert() { throw new Error('لا upsert'); },
  async create() { throw new Error('لا create'); },
};
const db: Row = {
  admin: { async findUnique() { return st.admin; } },
  companySettings,
  async $transaction(fn: (tx: Row) => Promise<unknown>) { txCount++; return fn({ companySettings }); },
};
stub('config/database', { default: db });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../routes/printTexts') as typeof import('../routes/printTexts');
const router = mod.default;
const rev = (v: unknown): string => mod.printTextsRevision(v);

async function call(method: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = (router as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === '/' && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} / مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { query: {}, params: {}, body: {}, headers: {}, user: { id: 'ADM', role: 'ADMIN', tenantId: T }, ...req };
  for (const h of layer.route.stack as Row[]) {
    let passed = false;
    let err: unknown;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body };
}
const withRev = (r: string): Row => ({ 'x-print-texts-rev': r });

/** إعدادٌ صالح بصورته القانونية (ترتيب القائمة) — مفتاحان من أول القائمة */
function texts(phone: string, extra: Record<string, PrintTextsV1['edits'][string]> = {}): PrintTextsV1 {
  return {
    ...emptyPrintTexts(), secondLang: 'en', companyNameAlt: 'Al Riyada',
    edits: { 'h.phone': { text: phone, alt: null, hidden: false }, ...extra },
  };
}

test('المراجعة: بصمة ١٦ حرفاً ست عشرية ثابتة لا تتأثر بترتيب المفاتيح، وnull وغياب القيمة واحد، وكل تغيير يغيّرها', () => {
  const a = texts('الهاتف');
  assert.match(rev(a), /^[0-9a-f]{16}$/);
  assert.equal(rev(a), rev(JSON.parse(JSON.stringify(a))));
  assert.equal(rev(a), rev(jsonbOrder(a)), 'ترتيب jsonb لا يغيّر البصمة');
  assert.equal(rev(null), rev(undefined));
  assert.match(rev(null), /^[0-9a-f]{16}$/);
  assert.notEqual(rev(null), rev(emptyPrintTexts()));
  assert.notEqual(rev(a), rev(texts('هاتف')));
  assert.notEqual(rev(a), rev({ ...a, edits: { 'h.phone': { text: 'الهاتف', alt: null, hidden: true } } }));
  assert.notEqual(rev(a), rev({ ...a, secondLang: 'fr' }));
  assert.equal(mod.PRINT_TEXTS_REV_HEADER, 'x-print-texts-rev');
});

test('القراءة تعيد rev للقيمة المخزّنة (null ⇒ بصمة null، وبلا صفّ مثلها)', async () => {
  reset();
  assert.equal((await call('get', {})).body.rev, rev(null));
  reset(jsonbOrder(texts('الهاتف')));
  const g = await call('get', {});
  assert.equal(g.body.rev, rev(texts('الهاتف')));
  assert.deepEqual(g.body.data, texts('الهاتف'));
  st.settings = null;
  assert.equal((await call('get', {})).body.rev, rev(null));
});

test('مراجعة مطابقة ⇒ 200 وكتابة في معاملة واحدة وrev جديد يساوي ما يعيده GET بعدها (رغم إعادة jsonb ترتيب المفاتيح)', async () => {
  reset(jsonbOrder(texts('الهاتف')));
  const base = (await call('get', {})).body.rev as string;
  const next = texts('رقم الهاتف', { 'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false } });
  const ok = await call('put', { body: next, headers: withRev(base) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { success: true, data: next, stored: true, hasCompany: true, rev: rev(next) });
  assert.equal(txCount, 1, 'القراءة والمقارنة والكتابة في معاملة');
  // الكتابة مشروطة بالقيمة المقروءة نفسها (مقارنةٌ وتبديل) لا بالشركة وحدها
  assert.deepEqual(writes, [{ where: { tenantId: T, printTexts: { equals: jsonbOrder(texts('الهاتف')) } }, data: { printTexts: next } }]);
  const after = await call('get', {});
  assert.equal(after.body.rev, ok.body.rev, 'بصمة الردّ = بصمة المقروء بعده — وإلا رُفض الحفظ التالي');
  // حفظٌ ثانٍ بمراجعة الردّ يمرّ
  const again = await call('put', { body: texts('هاتف'), headers: withRev(ok.body.rev) });
  assert.equal(again.status, 200);
  assert.equal(again.body.rev, rev(texts('هاتف')));
});

test('مراجعة قديمة ⇒ 409 PRINT_TEXTS_STALE برسالة عربية ولا كتابة — والعمود كما حفظه الجهاز الآخر', async () => {
  const theirs = texts('هاتف المكتب', { 'cust.phone': { text: null, alt: null, hidden: true } });
  reset(null);
  const opened = (await call('get', {})).body.rev as string;
  // جهازٌ آخر يحفظ بعد فتح هذا المحرّر
  st.settings!.printTexts = jsonbOrder(theirs);
  writes = [];
  const r = await call('put', { body: texts('الهاتف'), headers: withRev(opened) });
  assert.deepEqual([r.status, r.body], [409, { success: false, code: 'PRINT_TEXTS_STALE', message: 'تغيرت نصوص المطبوعات من جهاز آخر' }]);
  assert.equal(writes.length, 0, 'لا كتابة');
  assert.deepEqual(st.settings!.printTexts, jsonbOrder(theirs));
  // و«استعادة الافتراضي» بمراجعة قديمة مرفوضة كذلك (لا تمحو حفظ الآخر)
  const rs = await call('put', { body: { reset: true }, headers: withRev(opened) });
  assert.deepEqual([rs.status, rs.body.code], [409, 'PRINT_TEXTS_STALE']);
  assert.equal(writes.length, 0);
  // بعد إعادة القراءة يمرّ الحفظ بالمراجعة الجديدة
  const fresh = (await call('get', {})).body.rev as string;
  assert.equal(fresh, rev(theirs));
  const ok = await call('put', { body: { reset: true }, headers: withRev(fresh) });
  assert.deepEqual([ok.status, ok.body], [200, { success: true, data: emptyPrintTexts(), stored: false, hasCompany: true, rev: rev(null) }]);
  assert.equal(writes[0].data.printTexts, Prisma.DbNull);
  assert.equal(st.settings!.printTexts, null);
  // ورأسٌ فارغ أو عشوائي = مراجعةٌ لا تطابق
  for (const bad of ['', 'not-a-rev', rev(texts('x'))]) {
    assert.equal((await call('put', { body: texts('الهاتف'), headers: withRev(bad) })).status, 409, JSON.stringify(bad));
  }
});

test('مديران فتحا المحرّر معاً: الأول يحفظ، والثاني يُرفض بدل أن يمسح حفظ الأول، ثم يحفظ بعد إعادة القراءة', async () => {
  reset(jsonbOrder(texts('الهاتف')));
  const a = (await call('get', {})).body.rev as string;
  const b = (await call('get', {})).body.rev as string;
  const first = texts('الهاتف', { 'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false } });
  assert.equal((await call('put', { body: first, headers: withRev(a) })).status, 200);
  const second = texts('الهاتف', { 'cust.phone': { text: null, alt: null, hidden: true } });
  assert.equal((await call('put', { body: second, headers: withRev(b) })).body.code, 'PRINT_TEXTS_STALE');
  assert.deepEqual((await call('get', {})).body.data, first, 'تعديل الأول باقٍ');
  const reread = (await call('get', {})).body.rev as string;
  assert.equal((await call('put', { body: second, headers: withRev(reread) })).status, 200);
});

test('بلا الرأس (حزمةٌ أقدم) ⇒ الحفظ كما كان: 200 وكتابة واحدة بلا معاملة ولو تغيّر العمود، والردّ يحمل rev', async () => {
  reset(jsonbOrder(texts('هاتف آخر')));
  const r = await call('put', { body: texts('الهاتف') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, data: texts('الهاتف'), stored: true, hasCompany: true, rev: rev(texts('الهاتف')) });
  assert.equal(txCount, 0, 'المسار القديم كما هو');
  assert.deepEqual(writes, [{ where: { tenantId: T }, data: { printTexts: texts('الهاتف') } }]);
});

test('الحرّاس قبل المراجعة: المندوب 403 بلا معاملة، والجسم المرفوض 400 بلا معاملة، وبلا صفّ إعدادات 409 COMPANY_SETTINGS_MISSING', async () => {
  reset();
  const r0 = rev(null);
  assert.equal((await call('put', { user: { id: 'R1', role: 'SALES_REP', tenantId: T }, body: texts('الهاتف'), headers: withRev(r0) })).status, 403);
  assert.equal((await call('put', { body: { ...texts('الهاتف'), extra: 1 }, headers: withRev(r0) })).status, 400);
  assert.equal(txCount, 0);
  assert.equal(writes.length, 0);
  st.settings = null;
  const m = await call('put', { body: texts('الهاتف'), headers: withRev(r0) });
  assert.deepEqual([m.status, m.body], [409, { success: false, code: 'COMPANY_SETTINGS_MISSING', message: 'احفظ بيانات الشركة أولا' }]);
  assert.equal(writes.length, 0);
});

/** حاجزٌ لـn قراءات: لا تعود أيٌّ منها حتى تصل كلّها — فيقرأ الحفظان العمود قبل أن يكتب أيٌّ منهما (أسوأ تداخل) */
function readBarrier(n: number): () => Promise<void> {
  let arrived = 0;
  const waiting: Array<() => void> = [];
  return () => {
    arrived++;
    if (arrived > n) return Promise.resolve();
    if (arrived === n) { waiting.splice(0).forEach((r) => r()); return Promise.resolve(); }
    return new Promise<void>((r) => { waiting.push(r); });
  };
}

test('سباق: حفظان في اللحظة نفسها بالمراجعة نفسها ⇒ واحدٌ فقط ينجح والآخر 409 PRINT_TEXTS_STALE — ولا يمسح الثاني الأول', async () => {
  for (const base of [null, texts('الهاتف')]) {
    reset(base === null ? null : jsonbOrder(base));
    const opened = (await call('get', {})).body.rev as string;
    const a = texts('هاتف أ', { 'inv.title': { text: 'فاتورة أ', alt: null, hidden: false } });
    const b = texts('هاتف ب', { 'cust.phone': { text: null, alt: null, hidden: true } });
    writes = [];
    beforeRead = readBarrier(2);
    const [ra, rb] = await Promise.all([
      call('put', { body: a, headers: withRev(opened) }),
      call('put', { body: b, headers: withRev(opened) }),
    ]);
    beforeRead = null;
    const label = base === null ? 'null' : 'texts';
    assert.deepEqual([ra.status, rb.status].sort(), [200, 409], `base=${label}: ${JSON.stringify([ra.body, rb.body])}`);
    const [win, lose, winVal] = ra.status === 200 ? [ra, rb, a] : [rb, ra, b];
    assert.deepEqual(lose.body, { success: false, code: 'PRINT_TEXTS_STALE', message: 'تغيرت نصوص المطبوعات من جهاز آخر' });
    assert.deepEqual(win.body, { success: true, data: winVal, stored: true, hasCompany: true, rev: rev(winVal) });
    assert.deepEqual(st.settings!.printTexts, jsonbOrder(winVal), 'العمود كما كتبه الفائز وحده');
    assert.equal((await call('get', {})).body.rev, win.body.rev);
    // وكلا الحفظين اشترط القيمة المقروءة (العمود الفارغ ⇒ AnyNull)
    assert.equal(writes.length, 2);
    for (const w of writes) {
      assert.deepEqual(w.where, { tenantId: T, printTexts: { equals: base === null ? Prisma.AnyNull : jsonbOrder(base) } });
    }
  }
});

test('سباق مع «استعادة الافتراضي»: الاستعادة وحفظٌ بالمراجعة نفسها معاً ⇒ واحدٌ فقط ينجح', async () => {
  reset(jsonbOrder(texts('الهاتف')));
  const opened = (await call('get', {})).body.rev as string;
  beforeRead = readBarrier(2);
  const [r1, r2] = await Promise.all([
    call('put', { body: { reset: true }, headers: withRev(opened) }),
    call('put', { body: texts('هاتف جديد'), headers: withRev(opened) }),
  ]);
  beforeRead = null;
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal((r1.status === 409 ? r1 : r2).body.code, 'PRINT_TEXTS_STALE');
  assert.deepEqual(st.settings!.printTexts, r1.status === 200 ? null : jsonbOrder(texts('هاتف جديد')));
});

test('حفظٌ من جهاز آخر بين قراءة هذا الحفظ وكتابته ⇒ 409 PRINT_TEXTS_STALE والعمود كما حفظه الآخر', async () => {
  const theirs = texts('هاتف المكتب');
  reset(jsonbOrder(texts('الهاتف')));
  const opened = (await call('get', {})).body.rev as string;
  const origUpdate = companySettings.updateMany;
  companySettings.updateMany = async (a: Row) => { st.settings!.printTexts = jsonbOrder(theirs); return origUpdate(a); };
  try {
    const r = await call('put', { body: texts('رقم الهاتف'), headers: withRev(opened) });
    assert.deepEqual([r.status, r.body], [409, { success: false, code: 'PRINT_TEXTS_STALE', message: 'تغيرت نصوص المطبوعات من جهاز آخر' }]);
    assert.deepEqual(st.settings!.printTexts, jsonbOrder(theirs));
  } finally {
    companySettings.updateMany = origUpdate;
  }
});

test('حُذف صفّ الإعدادات بين القراءة والكتابة ⇒ 409 COMPANY_SETTINGS_MISSING (لا PRINT_TEXTS_STALE ولا 200)', async () => {
  reset(null);
  const opened = (await call('get', {})).body.rev as string;
  const origUpdate = companySettings.updateMany;
  companySettings.updateMany = async (a: Row) => { st.settings = null; return origUpdate(a); };
  try {
    const r = await call('put', { body: texts('الهاتف'), headers: withRev(opened) });
    assert.deepEqual([r.status, r.body], [409, { success: false, code: 'COMPANY_SETTINGS_MISSING', message: 'احفظ بيانات الشركة أولا' }]);
  } finally {
    companySettings.updateMany = origUpdate;
  }
});
