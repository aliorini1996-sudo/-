// مراجعة المخزون نوفمبر ٢٠٢٦ (البند ٢، D7) — إعادة رفع فاتورةٍ دون اتصال بعد **إعادة تسمية** أساس الصنف (صفّ سجلٍّ بمعامل ١) لا تُعامَل
// تحويلاً: «١٠ كرتون» صدرت والكرتون أساس، ثم سُمّي الأساس «حبة» وأُضيف «كرتون = ٢٤» ⇒ تُكتب ١٠ بالأساس لا ٢٤٠.
// والمسار يحمّل السجلّ لصنفٍ لقطةُ الجهاز فيه بأساسٍ غير أساسه الآن (لا لمن عنده baseConvertedAt وحده).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
const prismaFake: unknown = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : new Proxy({}, { get: () => async () => { throw new Error('لا قاعدة هنا'); } })) });
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: pass, requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: () => 'T1', isOwnerSession: () => false,
});
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('لا مرحلة ثانية هنا'); } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveLineUnit } = require('../routes/invoices') as typeof import('../routes/invoices');
import type { BaseConversionRow } from '../services/baseConversions';

type Res = Awaited<ReturnType<typeof resolveLineUnit>>;
const okUnit = (r: Res) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<Res, { ok: true }>;
};

/** الصنف الآن: أساسه «حبة» وله «كرتون = ٢٤» أُضيف بعد إعادة التسمية (بياناتٌ سبقت حارس 409) */
const RENAMED = { name: 'ماء', unit: 'حبة', units: [{ id: 'u-ct', name: 'كرتون', factor: 24, price: 24, unitCode: 'CT', isActive: true }] };
const row = (fromUnit: string, factor: number, day: number): BaseConversionRow =>
  ({ fromUnit, toUnit: 'حبة', factor, fromUnitId: null, convertedAt: new Date(Date.UTC(2026, 10, day)) } as unknown as BaseConversionRow);
const never = async () => false;
const docAt = new Date(Date.UTC(2026, 10, 1));

test('إعادة التسمية وحدها (معامل ١): «١٠ كرتون» بأساس الجهاز القديم تُكتب بالأساس بمعامل ١ — لا ×٢٤', async () => {
  const r = okUnit(await resolveLineUnit(RENAMED, { unitName: 'كرتون', unitFactor: 1, baseUnitName: 'كرتون' },
    { replay: true, seenInHistory: never, conversions: [row('كرتون', 1, 2)], docAt }));
  assert.equal(r.unit.unitFactor, 1);
  assert.equal(r.rebase, 1);
  // والبند بلا اسم وحدة (أساس الجهاز) كذلك
  const bare = okUnit(await resolveLineUnit(RENAMED, { unitFactor: 1, baseUnitName: 'كرتون' },
    { replay: true, seenInHistory: never, conversions: [row('كرتون', 1, 2)], docAt }));
  assert.deepEqual([bare.unit.unitFactor, bare.rebase], [1, 1]);
});

test('التحويل الحقيقي (معامل ٢٤) كما كان: «١٠ كرتون» بأساس الجهاز تُكتب كراتين بمعامل ٢٤', async () => {
  const r = okUnit(await resolveLineUnit(RENAMED, { unitName: 'كرتون', unitFactor: 1, baseUnitName: 'كرتون' },
    { replay: true, seenInHistory: never, conversions: [row('كرتون', 24, 2)], docAt }));
  assert.equal(r.unit.unitFactor, 24);
  assert.equal(r.rebase, 24);
});

test('حارس نصّي: إعادة الرفع تحمّل السجلّ لصنفٍ لقطةُ أساسه على الجهاز غير أساسه الآن — لا للمحوَّل وحده', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'invoices.ts'), 'utf8');
  assert.match(src, /const renamedOnDevice = \(p: \{ id: string; unit: string \}\) => body\.items\.some\(\(it\) => it\.productId === p\.id/);
  assert.match(src, /const convertedIds = isReplay \? products\.filter\(\(p\) => p\.baseConvertedAt \|\| renamedOnDevice\(p\)\)\.map\(\(p\) => p\.id\) : \[\];/);
  // وفي الطيّ الأخير: آخر صفٍّ من أساس الجهاز بمعامل ١ ليس تحويلاً
  assert.match(src, /const renamedOnly = !!lastFromDev && Math\.round\(Number\(lastFromDev\.factor\)\) <= 1;/);
});
