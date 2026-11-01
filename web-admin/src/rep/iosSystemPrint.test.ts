// «نظام الطباعة» في تطبيق الآيفون 1.1.0: الوثيقة نفسها التي كان الإطار سيطبعها تذهب إلى نافذة الطباعة في التطبيق (systemPrint)
// قبل أيّ إطار، وتعذّر التطبيق يصل الشاشة (Error('print frame') ⇒ «تعذرت الطباعة…») — في الشريط الكلاسيكي وصفحة المعايرة.
// وبلا جسر (سفاري، تطبيق 1.0، أندرويد، سطح المكتب) الإطار كما اليوم.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printThermalReceipt } from './thermal';
import { printHtmlDocument } from './printPage';
import { LEGACY_THERMAL_GEOM } from './thermalHtml';
import type { ReceiptDoc } from './RepDocuments';

const receipt: ReceiptDoc = {
  kind: 'receipt', number: 'RC-77', date: '2026-10-31T11:00:00', company: { name: 'شركة الاختبار للتوزيع', countryCode: 'SA' },
  customer: { name: 'بقالة النور' }, repName: 'أحمد', amount: 100, paymentMethod: 'CASH', notes: '',
};

/** صفحةٌ بلا DOM: إنشاء الإطار يرمي «iframe» — فإن وصلنا إليه عُرف؛ والجسر (إن طُلب) يجيب بـreply */
async function withPage(bridge: unknown | null, run: (posted: Array<Record<string, unknown>>) => Promise<void>): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const keys = ['window', 'document'] as const;
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  const posted: Array<Record<string, unknown>> = [];
  const win: Record<string, unknown> = { addEventListener() {}, removeEventListener() {} };
  if (bridge !== null) {
    win.webkit = { messageHandlers: { fsPrint: { postMessage(msg: Record<string, unknown>) { posted.push(msg); return Promise.resolve(bridge); } } } };
    win.__fsIosBridge = { v: 1, caps: ['print', 'pick', 'cancel', 'systemPrint'] };
  }
  const doc = { createElement() { throw new Error('iframe'); }, body: { appendChild() {} } };
  Object.defineProperty(g, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(g, 'document', { value: doc, configurable: true, writable: true });
  try { await run(posted); } finally { for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; } }
}

test('الشريط الكلاسيكي في تطبيق الآيفون: systemPrint بالوثيقة وعرض 58 مم، بلا إطار — وتعذّر التطبيق يرمي «print frame»', async () => {
  await withPage({ ok: true, outcome: 'printed' }, async (posted) => {
    await printThermalReceipt(receipt);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].op, 'systemPrint');
    assert.equal(posted[0].widthMm, LEGACY_THERMAL_GEOM.paperWidthMm);
    assert.equal(posted[0].name, '');
    assert.match(posted[0].html as string, /RC-77/);
    assert.match(posted[0].html as string, /<html/i);
  });
  // إغلاق نافذة الطباعة بلا طباعة ليس خطأً
  await withPage({ ok: true, outcome: 'dismissed' }, async () => { await printThermalReceipt(receipt); });
  for (const reply of [{ ok: false, code: 'failed' }, { ok: false, code: 'busy' }, undefined]) {
    await withPage(reply, async () => {
      await assert.rejects(printThermalReceipt(receipt), (e: unknown) => e instanceof Error && e.message === 'print frame', JSON.stringify(reply));
    });
  }
});

test('صفحة المعايرة (printHtmlDocument) في تطبيق الآيفون: الوثيقة نفسها حرفاً وعرض الورق — وتعذّره يرمي «print frame»', async () => {
  const html = '<!doctype html><html><head><style>@page{size:80mm auto}</style></head><body>اختبار</body></html>';
  await withPage({ ok: true, outcome: 'printed' }, async (posted) => {
    await printHtmlDocument(html, 80);
    assert.deepEqual(posted, [{ op: 'systemPrint', html, widthMm: 80, name: '' }]);
  });
  await withPage({ ok: false, code: 'print_unavailable' }, async () => {
    await assert.rejects(printHtmlDocument(html, 80), (e: unknown) => e instanceof Error && e.message === 'print frame');
  });
});

test('بلا جسر الآيفون (سفاري، تطبيق 1.0، أندرويد، سطح المكتب): الإطار كما اليوم — لا رسالة إلى أيّ تطبيق', async () => {
  await withPage(null, async (posted) => {
    await assert.rejects(Promise.resolve().then(() => printThermalReceipt(receipt)), /iframe/);
    await assert.rejects(Promise.resolve().then(() => printHtmlDocument('<html></html>', 58)), /iframe/);
    assert.equal(posted.length, 0);
  });
});
