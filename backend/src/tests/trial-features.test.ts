import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrialCompanyTx, TRIAL_FEATURES, TRIAL_LIMITS, trialZatcaPhase2 } from '../services/trialCompany';
import { getCountryTax } from '../config/countries';

/**
 * ميزات التجربة المجانية (طلب المالك ٢٦ نوفمبر ٢٠٢٦): كل تسجيلٍ تجريبيّ جديد يُفتح له مخزون الشركة وبصمة الحضور ومنيو المنتجات
 * وتوقيع المستلم والنظام المحاسبي المتكامل، وتبويب ربط ZATCA المرحلة الثانية للشركة السعودية — فوق ما كان مفعّلاً افتراضياً.
 * طريقا الإنشاء (التسجيل الذاتي وبوابة السفير) يمرّان بـcreateTrialCompanyTx نفسها (حارس portal-trial.test.ts).
 */

type Captured = { tenant?: Record<string, unknown>; admin?: Record<string, unknown>; settings?: Record<string, unknown> };

function fakeTx(c: Captured) {
  return {
    tenant: { create: async ({ data }: { data: Record<string, unknown> }) => { c.tenant = data; return { id: 't1', ...data }; } },
    admin: { create: async ({ data }: { data: Record<string, unknown> }) => { c.admin = data; return { id: 'a1', ...data }; } },
    companySettings: { create: async ({ data }: { data: Record<string, unknown> }) => { c.settings = data; return data; } },
  } as never;
}

const input = (countryCode?: string | null) => ({
  companyName: 'شركة', adminName: 'مدير', email: 'x@example.com', phone: '0500000000', countryCode, passwordHash: 'h',
  now: new Date('2026-11-26T08:00:00Z'),
});

test('التجربة السعودية: الميزات الخمس مفتوحة وربط ZATCA المرحلة الثانية مفعّل، والباقة والحدود كما كانت', async () => {
  const c: Captured = {};
  await createTrialCompanyTx(fakeTx(c), input('SA'));
  const t = c.tenant!;
  for (const k of ['warehouseEnabled', 'attendanceEnabled', 'catalogEnabled', 'invoiceSignatureEnabled', 'accountingSuiteEnabled']) {
    assert.equal(t[k], true, k);
  }
  assert.equal(t.zatcaPhase2Enabled, true);
  assert.equal(t.plan, 'trial');
  assert.equal(t.maxSalesReps, TRIAL_LIMITS.maxSalesReps);
  assert.equal(t.maxAdminUsers, TRIAL_LIMITS.maxAdminUsers);
  // «كل ما كان مفعّلاً مسبقاً» باقٍ: لا يُطفأ النظام المحاسبي ولا يُكتب فوق افتراضه
  assert.notEqual(t.accountingEnabled, false);
  assert.equal(c.settings!.einvoiceProvider, 'zatca');
});

test('بلا دولة ⇒ السعودية افتراضاً، فيُفعَّل ربط ZATCA كذلك', async () => {
  const c: Captured = {};
  await createTrialCompanyTx(fakeTx(c), input(null));
  assert.equal(c.tenant!.zatcaPhase2Enabled, true);
  assert.equal(c.tenant!.warehouseEnabled, true);
});

test('تجربة خارج السعودية: الميزات الخمس مفتوحة، وربط ZATCA مطفأ (لا معنى له لمزوّدٍ آخر)', async () => {
  for (const code of ['EG', 'AE']) {
    const c: Captured = {};
    await createTrialCompanyTx(fakeTx(c), input(code));
    assert.equal(c.tenant!.zatcaPhase2Enabled, false, code);
    for (const [k, v] of Object.entries(TRIAL_FEATURES)) assert.equal(c.tenant![k], v, `${code} ${k}`);
  }
});

test('trialZatcaPhase2: السعودية بمزوّد zatca وحدها', () => {
  assert.equal(trialZatcaPhase2(getCountryTax('SA')), true);
  assert.equal(trialZatcaPhase2({ code: 'SA', provider: 'none' } as never), false);
  assert.equal(trialZatcaPhase2(getCountryTax('EG')), false);
});

test('الميزات الخمس ثابتة: لا ميزة مدفوعة أخرى تُفتح للتجربة بلا قرار', () => {
  assert.deepEqual(Object.keys(TRIAL_FEATURES).sort(), [
    'accountingSuiteEnabled', 'attendanceEnabled', 'catalogEnabled', 'invoiceSignatureEnabled', 'warehouseEnabled',
  ]);
  assert.ok(Object.values(TRIAL_FEATURES).every((v) => v === true));
});
