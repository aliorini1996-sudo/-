// حداثة إعدادات الشركة في المستند المفتوح (D-G3/D-G4): «نصوص المطبوعات» المعدّلة تصل إعادة الطباعة والمشاركة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withLiveCompany, docOpenRefreshDue, DOC_OPEN_REFRESH_GAP_MS, companyRefreshDue, COMPANY_REFRESH_MIN_GAP_MS,
  announceDocOpen, DOC_OPEN_EVENT,
} from './companyRefresh';

type Co = { name: string; printTexts?: unknown };
type Doc = { kind: 'invoice' | 'receipt' | 'statement'; number: string; company?: Co | null };

const oldCo: Co = { name: 'شركة', printTexts: null };
const newCo: Co = { name: 'شركة', printTexts: { v: 1, texts: { 'inv.title': 'فاتورة' } } };

test('withLiveCompany: الفاتورة وسند القبض يأخذان نسخة الشركة الأحدث، وبقية الحقول كما هي', () => {
  for (const kind of ['invoice', 'receipt'] as const) {
    const doc: Doc = { kind, number: 'INV-1', company: oldCo };
    const out = withLiveCompany(doc, newCo);
    assert.notEqual(out, doc, 'نسخة جديدة كي يُعاد رسم المستند');
    assert.equal(out.company, newCo);
    assert.equal(out.number, 'INV-1');
    assert.equal(out.kind, kind);
    assert.equal(doc.company, oldCo, 'لا يُعدَّل المستند الأصلي');
  }
  // مستند بُني قبل تحميل الشركة (company=null) يأخذها حين تصل
  const bare: Doc = { kind: 'invoice', number: 'INV-2', company: null };
  assert.equal(withLiveCompany(bare, newCo).company, newCo);
});

test('withLiveCompany: الهوية نفسها حين لا تغيير أو شركة فارغة، وكشف الحساب يتجدّد كالفاتورة (ترويسته بنصوص الشركة)', () => {
  const same: Doc = { kind: 'invoice', number: 'INV-1', company: newCo };
  assert.equal(withLiveCompany(same, newCo), same);
  const doc: Doc = { kind: 'receipt', number: 'R-1', company: oldCo };
  assert.equal(withLiveCompany(doc, null), doc, 'أوف‑لاين بلا كاش: لا تُمحى نسخة المستند');
  assert.equal(withLiveCompany(doc, undefined), doc);
  const st: Doc = { kind: 'statement', number: 'S-1', company: oldCo };
  const stOut = withLiveCompany(st, newCo);
  assert.equal(stOut.company, newCo, 'كشف الحساب المفتوح لا يبقى على ترويسة ما قبل الحفظ');
  assert.equal(stOut.number, 'S-1');
  assert.equal(withLiveCompany(stOut, newCo), stOut);
});

test('announceDocOpen: يطلق DOC_OPEN_EVENT على window، وبلا window لا شيء ولا رمي', () => {
  const g = globalThis as { window?: EventTarget };
  const had = 'window' in g;
  const prev = g.window;
  try {
    delete g.window;
    assert.doesNotThrow(() => announceDocOpen());
    const w = new EventTarget();
    let n = 0;
    w.addEventListener(DOC_OPEN_EVENT, () => { n += 1; });
    g.window = w;
    announceDocOpen();
    assert.equal(n, 1);
  } finally {
    if (had) g.window = prev; else delete g.window;
  }
});

test('docOpenRefreshDue: فتح مستند يجلب الشركة مرة كل 30 ثانية على الأكثر', () => {
  const T = 1_800_000_000_000;
  assert.equal(DOC_OPEN_REFRESH_GAP_MS, 30 * 1000);
  assert.ok(DOC_OPEN_REFRESH_GAP_MS < COMPANY_REFRESH_MIN_GAP_MS);
  assert.equal(docOpenRefreshDue(null, T), true);
  assert.equal(docOpenRefreshDue(0, T), true);
  assert.equal(docOpenRefreshDue(T, T + DOC_OPEN_REFRESH_GAP_MS - 1), false);
  assert.equal(docOpenRefreshDue(T, T + DOC_OPEN_REFRESH_GAP_MS), true);
  assert.equal(docOpenRefreshDue(Number.NaN, T), true);
  // الفجوة الدورية لم تتغيّر
  assert.equal(companyRefreshDue(T, T + DOC_OPEN_REFRESH_GAP_MS), false);
  // فشل الجلب الأول في /m (last = 0) ⇒ المحفِّز التالي يعيد المحاولة فوراً
  assert.equal(companyRefreshDue(0, T), true);
});
