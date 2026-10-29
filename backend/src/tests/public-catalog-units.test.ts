// المنيو العام (/public/catalog) بالوحدات المتعددة — الوحدات النشطة بأسعارها (المحدَّد، وإلا الأساس × المعامل)،
// وصنفٌ بلا وحدات كما كان حرفياً. قاعدةٌ مزيّفة، بلا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const T = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
let productArgs: Record<string, unknown> | null = null;
const products = [
  { name: 'ماء', unit: 'حبة', basePrice: 1, taxPct: 15, image: null, category: { name: 'مشروبات' },
    units: [{ name: 'شدة', factor: 6, price: null }, { name: 'كرتون', factor: 24, price: 20 }] },
  { name: 'عصير', unit: 'علبة', basePrice: 2.5, taxPct: 15, image: null, category: null, units: [] },
];
stub('config/database', {
  default: {
    tenant: { async findUnique() { return { isActive: true, catalogEnabled: true }; } },
    companySettings: { async findUnique() { return { name: 'شركة', logo: null, primaryColor: null, currency: 'SAR', phone: null }; } },
    salesRep: { async findFirst() { return { id: R, name: 'مندوب', phone: '0500000000' }; } },
    workChannel: { async findFirst() { return null; } },
    product: { async findMany(args: Record<string, unknown>) { productArgs = args; return products; } },
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/publicCatalog').default as Router;

async function get(tenantId: string, repId: string) {
  const res = { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
  const layer = (router as unknown as { stack: { route?: { stack: { handle: (q: unknown, s: unknown, n: (e?: unknown) => void) => Promise<void> }[] } }[] }).stack.find(l => l.route)!;
  await layer.route!.stack[0].handle({ params: { tenantId, repId } }, res, (e?: unknown) => { if (e) throw e; });
  return res;
}

test('المنيو العام: وحدات الصنف النشطة بمعاملها وسعرها — المحدَّد يغلب، والفارغ = سعر الأساس × المعامل', async () => {
  const res = await get(T, R);
  assert.equal(res.statusCode, 200);
  const list = (res.body!.data as { products: Record<string, unknown>[] }).products;
  assert.deepEqual(list[0].units, [{ name: 'شدة', factor: 6, price: 6 }, { name: 'كرتون', factor: 24, price: 20 }]);
  assert.equal(list[0].unit, 'حبة', 'unit وbasePrice لوحدة الأساس كما كانا');
  assert.equal(list[0].basePrice, 1);
  assert.deepEqual(list[1], { name: 'عصير', unit: 'علبة', basePrice: 2.5, taxPct: 15, image: null, category: null, units: [] }, 'صنفٌ بلا وحدات');
  // الموقوفة لا تُعرض للعلن، وبترتيب العقد
  const unitsSel = (productArgs!.select as { units: { where: unknown; orderBy: unknown; select: Record<string, unknown> } }).units;
  assert.deepEqual(unitsSel.where, { isActive: true });
  assert.deepEqual(unitsSel.orderBy, [{ sortOrder: 'asc' }, { factor: 'asc' }]);
  assert.deepEqual(Object.keys(unitsSel.select).sort(), ['factor', 'name', 'price'], 'لا رمز ضريبي ولا معرّف للعلن');
});
