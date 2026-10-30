// رموز الأخطاء التي يقرؤها التكامل البرمجي (مفتاح API): وحدةٌ غير صالحة في «طلب بضاعة» المندوب ⇒ UNIT_INVALID كبقية
// مسارات الكتابة، وعقد تاريخ الاستيراد الغائب عبر المفتاح ⇒ رسالة تقول ما يُرسَل لا «حدّث الصفحة». بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import { UnitInvalidError } from '../services/warehouseStock';
import { errorHandler } from '../middleware/errorHandler';
import { ImportHttpError, importErrorBody } from '../services/importLedger';
import { fail as repStockFail } from '../routes/repStockRequests';
import { assertImportDateContract } from '../routes/import';

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(s: number) { out.status = s; return res; },
    json(b: unknown) { out.body = b; return res; },
  } as unknown as Response;
  return { res, out };
}

/** fail() ثم المعالج العامّ إن مرّر الخطأ — كما يجري في التطبيق */
function runFail(err: unknown) {
  const { res, out } = fakeRes();
  const next: NextFunction = (e?: unknown) => { errorHandler(e, { user: { apiKeyId: 'k1' } } as unknown as Request, res, (() => {}) as NextFunction); };
  repStockFail(err, res, next);
  return out;
}

test('PUT /rep-stock-requests/:id: unitId ليس من وحدات الصنف أو موقوف ⇒ 400 {code:UNIT_INVALID} كبقية مسارات الكتابة', () => {
  const out = runFail(new UnitInvalidError('الوحدة ليست من وحدات الصنف'));
  assert.equal(out.status, 400);
  assert.deepEqual(out.body, { success: false, code: 'UNIT_INVALID', message: 'الوحدة ليست من وحدات الصنف' });
});

test('أخطاء الموجّه المقصودة الأخرى (409/404/400) كما كانت حرفاً بحرف: بلا رمز', () => {
  for (const status of [409, 404, 400]) {
    const out = runFail(Object.assign(new Error('م'), { status }));
    assert.equal(out.status, status);
    assert.deepEqual(out.body, { success: false, message: 'م' });
  }
});

function contractError(contract: string | undefined, viaKey: boolean): ImportHttpError {
  try { assertImportDateContract(contract, viaKey); } catch (e) { assert.ok(e instanceof ImportHttpError); return e; }
  assert.fail('لم يُرفض');
}

test('POST /import/balances|ledger: العقد الصحيح يمرّ عبر المفتاح واللوحة', () => {
  assert.doesNotThrow(() => assertImportDateContract('local-ymd-v2', true));
  assert.doesNotThrow(() => assertImportDateContract('local-ymd-v2', false));
});

test('عقد التاريخ الغائب عبر المفتاح ⇒ 409 IMPORT_CLIENT_OUTDATED برسالة تذكر الحقل وقيمته، والتفاصيل كما هي', () => {
  for (const c of [undefined, 'v1']) {
    const body = importErrorBody(contractError(c, true));
    assert.equal(body.code, 'IMPORT_CLIENT_OUTDATED');
    assert.equal(body.expected, 'local-ymd-v2');
    assert.equal(body.received, c ?? null);
    assert.match(String(body.message), /dateContract/);
    assert.match(String(body.message), /local-ymd-v2/);
    assert.doesNotMatch(String(body.message), /حدّث الصفحة/);
  }
});

test('جلسة اللوحة: رسالة «حدّث الصفحة» القائمة حرفاً بحرف', () => {
  const e = contractError(undefined, false);
  assert.equal(e.status, 409);
  assert.equal(e.message, 'هذه الصفحة مفتوحة من قبل تحديث النظام ولم يُكتب شيء. حدّث الصفحة ثم أعد رفع الملف');
});

test('POST /van-stock/loads: وحدة بند غير صالحة ⇒ 400 {code:UNIT_INVALID} كالمستودع وطلب البضاعة، وبقية أخطاء الموجّه كما كانت', async () => {
  const { default: vanRouter } = await import('../routes/vanStock');
  const layer = (vanRouter as unknown as { stack: { handle: (...a: unknown[]) => void }[] }).stack.filter((l) => l.handle.length === 4).pop();
  assert.ok(layer, 'معالج أخطاء الموجّه');
  const run = (err: unknown) => {
    const { res, out } = fakeRes();
    layer!.handle(err, {}, res, (() => { out.status = -1; }) as NextFunction);
    return out;
  };
  assert.deepEqual(run(new UnitInvalidError('وحدة موقوفة')), { status: 400, body: { success: false, code: 'UNIT_INVALID', message: 'وحدة موقوفة' } });
  assert.deepEqual(run(Object.assign(new Error('يجب تحديد المندوب'), { status: 400 })), { status: 400, body: { success: false, message: 'يجب تحديد المندوب' } });
});

test('إعادة رفع فاتورة المرحلة الثانية (clientRef): الصفّ المُعاد تحميله يحمل التشغيلات مع withLots=1 كالصفّ القائم', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'invoices.ts'), 'utf8');
  const reload = src.slice(src.indexOf('if (p2) {', src.indexOf('idempotency: إن سبق رفع هذه الفاتورة')), src.indexOf('// ردّ إعادة الرفع = ردّ الرفع الأوّل'));
  assert.match(reload, /p2\.reload/);
  assert.match(reload, /include: \{ items: \(\(await wantsLots\(req, tid\)\) \? \{ include: ITEM_LOTS_INCLUDE \} : true\) as true, customer: true \}/);
});
