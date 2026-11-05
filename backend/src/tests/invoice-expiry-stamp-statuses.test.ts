// مراجعة المخزون نوفمبر ٢٠٢٦ (البند ١، D6) — ختم صلاحية المرتجع لا يبقى رهنَ ردّ 201 وحده:
//   • stampExpiryAfterIssue يختم على 201 و202 (إشعارٌ قياسي تأخّر اعتماده أو CLEARED_NO_XML) وردّ التكرار 200 (idempotent)،
//     ولا شيء لغيرها — وstampExpiryIfMissing لا يرمي أبداً.
//   • حرّاس نصّية: الختم داخل معاملة الإنشاء للمرتجع الحرّ وللإشعار الدائن المرتبط واليدويّ، والتكرار والسباق يُكملان الناقص.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
let reads: unknown[] = [];
let fail = false;
const prismaFake: unknown = new Proxy({}, {
  get: (_t, k) => (k === 'then' ? undefined : new Proxy({}, {
    get: (_m, method) => async (args: unknown) => {
      if (k === 'invoice' && method === 'findFirst') {
        reads.push(args);
        if (fail) throw new Error('قاعدة متعطّلة');
        return null; // لا مستند ⇒ لا كتابة
      }
      throw new Error(`غير متوقَّع: ${String(k)}.${String(method)}`);
    },
  })),
});
stub('config/database', { default: prismaFake });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stampExpiryAfterIssue, stampExpiryIfMissing } = require('../services/invoiceExpiry') as typeof import('../services/invoiceExpiry');

const body = (extra: Record<string, unknown> = {}) => ({ success: true, data: { id: 'inv-1' }, ...extra });

test('D6: الختم على 201 و202 وردّ التكرار 200، ولا ختم لغيرها أو بلا معرّف', async () => {
  for (const [status, b, want] of [
    [201, body(), 1],
    [202, body(), 1],
    [200, body({ idempotent: true }), 1],
    [200, body(), 0],
    [400, body(), 0],
    [409, body(), 0],
    [422, body(), 0],
    [201, { success: true, data: {} }, 0],
    [202, null, 0],
  ] as const) {
    reads = []; fail = false;
    await stampExpiryAfterIssue('T1', status, b);
    assert.equal(reads.length, want, `${status} ${JSON.stringify(b)}`);
  }
  reads = [];
  await stampExpiryAfterIssue('T1', 202, body());
  assert.deepEqual((reads[0] as { where: unknown }).where, { id: 'inv-1', tenantId: 'T1' }, 'نطاق الشركة');
});

test('D6: stampExpiryIfMissing لا يرمي — فشل الختم يُسجَّل والمستند كما هو', async () => {
  reads = []; fail = true;
  await stampExpiryIfMissing('T1', 'inv-1');
  await stampExpiryAfterIssue('T1', 202, body());
  assert.equal(reads.length, 2);
  fail = false;
});

test('حارس نصّي: الختم داخل معاملة الإنشاء — المرتجع الحرّ والإشعار المرتبط واليدويّ — والتكرار والسباق يُكملان الناقص', () => {
  const inv = fs.readFileSync(path.join(SRC, 'routes', 'invoices.ts'), 'utf8');
  const notes = fs.readFileSync(path.join(SRC, 'routes', 'invoicesNotes.ts'), 'utf8');
  const zatca = fs.readFileSync(path.join(SRC, 'routes', 'invoicesZatca.ts'), 'utf8');
  // المرحلة الأولى: الحرّ من «آخر بيع» قبل المعاملة ثم في بنود الإنشاء بجوار المرتبط
  assert.match(inv, /const freeExpiry = isReturn && !saleForReturn && tracksExpiry\s*\? await freeReturnExpiry\(/);
  assert.match(inv, /\.\.\.\(linkedExpiry\?\.get\(saleLinkLines\[idx\]\?\.saleItemId \?\? ''\) \?\? \{\}\),[\s\S]{0,200}\.\.\.\(freeExpiry\?\.get\(idx\) \?\? \{\}\),/);
  // الإشعار الدائن المرتبط (POST / وPOST /:id/credit-note) واليدويّ
  assert.equal((inv.match(/expiryStampsFor: linkedNoteExpiry\(tid,/g) ?? []).length, 2);
  assert.match(inv, /invoice: manualExpiry\?\.size \? \{ \.\.\.phase2Ctx, expiryStamps: manualExpiry \} : phase2Ctx,/);
  assert.match(notes, /\.\.\.\(kind === 'CREDIT_NOTE' && prepared\.lines\[idx\]\?\.productId \? \(expiry\?\.get\(prepared\.lines\[idx\]!\.invoiceItemId\) \?\? \{\}\) : \{\}\),/);
  // الإشعار يسأل لبنود الأصل المفعّلة صلاحيتها وحدها (من الصفّ المحمَّل) — أصلٌ بلا صلاحية بلا استعلام
  assert.ok(notes.includes('const lifeItems = preview.original.items.filter(i => i.productId && preview.shelfLifeProducts?.has(i.productId));'));
  assert.ok(notes.includes("shelfLifeProducts: new Set(row.items.filter(it => it.productId && it.product?.shelfLifeEnabled === true)"));
  assert.match(zatca, /\.\.\.\(ctx\.expiryStamps\?\.get\(idx\) \?\? \{\}\),\s*\.\.\.invoiceItemLotColumns\(/);
  // وصفوف اللوط بعدها (تغلبها) في المواضع الثلاثة
  assert.ok(inv.indexOf('...(freeExpiry?.get(idx) ?? {}),') < inv.indexOf('...invoiceItemLotColumns(alloc?.lines ?? null, idx, { tenantId: tid'));
  // التكرار (POST /، والسباق على clientRef، وreplyIfClientRefExists) يختم ما بقي
  assert.equal((inv.match(/needsExpiryStamp\(existing\)\) await stampExpiryIfMissing\(/g) ?? []).length, 3);
});
