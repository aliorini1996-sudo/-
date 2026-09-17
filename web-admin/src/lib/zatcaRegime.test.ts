import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isZatcaPhase2Live, zatcaCollectOn, zatcaRegimeOf } from './zatcaRegime';
import { BUILD_ID } from './buildId';
import { zatcaTabVisible } from '../components/zatca/zatcaAccess';

/**
 * فوترة ZATCA المرحلة الثانية (Z5.0 / Z5.6a) — محدِّدات الواجهة.
 *
 * نقد الخطة 5: العلم وحده كان سيُعيد الشركة المفعّلة إلى المرحلة الأولى في الواجهات إن أطفأه المالك بعد التفعيل (إصدار دون
 * اتصال، أزرار الإلغاء، رمز QR القديم، وسقوط حقول المشتري). المفتاح: (العلم || التفعيل الحيّ)، والخادم هو المرجع.
 * غير المعلَّمين وغير المفعّلين: مرحلة أولى ولا جمع — كما اليوم.
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const LIVE = '2026-11-20T06:00:00.000Z';

test('zatcaCollectOn: (العلم === true || مفعّلة) && SA — وإطفاء العلم بعد التفعيل لا يُسقط الجمع', () => {
  const cases: Array<[Parameters<typeof zatcaCollectOn>[0], boolean]> = [
    [{ zatcaPhase2Enabled: true, countryCode: 'SA' }, true],
    [{ zatcaPhase2Enabled: false, countryCode: 'SA', zatcaPhase2StartedAt: LIVE }, true],
    [{ countryCode: 'SA', zatcaPhase2StartedAt: LIVE }, true],
    [{ zatcaPhase2Enabled: false, countryCode: 'SA' }, false],
    [{ zatcaPhase2Enabled: false, countryCode: 'SA', zatcaPhase2StartedAt: null }, false],
    [{ zatcaPhase2Enabled: false, countryCode: 'SA', zatcaPhase2StartedAt: '' }, false],
    [{ zatcaPhase2Enabled: true, countryCode: 'EG' }, false],
    [{ zatcaPhase2Enabled: true, countryCode: null }, false],
    [{ zatcaPhase2Enabled: true }, false],
    [{ zatcaPhase2Enabled: 'true' as unknown as boolean, countryCode: 'SA' }, false],
    [null, false],
    [undefined, false],
  ];
  for (const [c, want] of cases) assert.equal(zatcaCollectOn(c), want, JSON.stringify(c));
});

test('zatcaRegimeOf: حقل الخادم مرجع؛ غيابه ⇒ مرحلة ثانية للمفعّلة (فشل آمن) وإلا مرحلة أولى', () => {
  assert.deepEqual(zatcaRegimeOf(null), { phase: 1 });
  assert.deepEqual(zatcaRegimeOf({ zatcaPhase2Enabled: true, countryCode: 'SA' }), { phase: 1 }, 'العلم وحده لا يغيّر الإصدار');
  assert.deepEqual(zatcaRegimeOf({ countryCode: 'SA', zatcaPhase2StartedAt: LIVE }), { phase: 2, mode: 'live', blocked: null });
  assert.deepEqual(zatcaRegimeOf({ zatcaPhase2StartedAt: LIVE, zatcaRegime: { phase: 2, mode: 'live', blocked: 'RENEWING' } }), { phase: 2, mode: 'live', blocked: 'RENEWING' });
  assert.deepEqual(zatcaRegimeOf({ zatcaRegime: { phase: 2, mode: 'rehearsal', blocked: null } }), { phase: 2, mode: 'rehearsal', blocked: null });
  assert.deepEqual(zatcaRegimeOf({ zatcaRegime: { phase: 1 } }), { phase: 1 });
  // مشوَّه ⇒ يُتجاهل (يعود للمفعّلة/غير المفعّلة)
  for (const bad of [{ phase: 3 }, { phase: 2 }, { phase: 2, mode: 'x' }, { phase: 2, mode: 'live', blocked: 'bad value!' }, 'phase2', [2], 2]) {
    assert.deepEqual(zatcaRegimeOf({ zatcaRegime: bad }), { phase: 1 }, JSON.stringify(bad));
    assert.deepEqual(zatcaRegimeOf({ zatcaRegime: bad, zatcaPhase2StartedAt: LIVE }), { phase: 2, mode: 'live', blocked: null }, JSON.stringify(bad));
  }
  assert.equal(isZatcaPhase2Live({ zatcaPhase2StartedAt: new Date(LIVE) }), true);
  assert.equal(isZatcaPhase2Live({}), false);
});

test('تبويب الربط يبقى لمدير شركة فُعّلت حيّاً والعلم مطفأ (كبوابة الخادم) — وبلا تفعيل ولا علم لا تبويب', () => {
  assert.equal(zatcaTabVisible({ zatcaPhase2Enabled: false, countryCode: 'SA', zatcaPhase2StartedAt: LIVE }, 'ADMIN'), true);
  assert.equal(zatcaTabVisible({ zatcaPhase2Enabled: false, countryCode: 'SA', zatcaPhase2StartedAt: null }, 'ADMIN'), false);
  assert.equal(zatcaTabVisible({ zatcaPhase2Enabled: false, countryCode: 'SA', zatcaPhase2StartedAt: LIVE }, 'MANAGER'), false);
  assert.equal(zatcaTabVisible({ zatcaPhase2Enabled: false, countryCode: 'SA', zatcaPhase2StartedAt: LIVE }, 'ADMIN', true), false);
  assert.equal(zatcaTabVisible({ countryCode: 'AE', zatcaPhase2StartedAt: LIVE }, 'ADMIN'), false);
});

test('إعدادات الشركة: اختيار العملة معطّل للمفعّلة وحدها (الخادم يردّ 409 ZATCA_SETTINGS_LOCKED) — بلا مساس بحقل الدولة المحروس', () => {
  const page = read('src', 'pages', 'CompanySettingsPage.tsx');
  assert.ok(page.includes("import { isZatcaPhase2Live } from '../lib/zatcaRegime';"));
  assert.ok(page.includes('const zatcaLive = isZatcaPhase2Live(data);'));
  assert.ok(page.includes("<select className={zatcaLive ? 'input bg-[#F1EBDF] text-[#6E6557] cursor-not-allowed' : 'input'} value={currencyOverride} disabled={zatcaLive} onChange={e => setCurrencyOverride(e.target.value)}>"));
  assert.ok(page.includes("tr('العملة مقفلة على الريال السعودي بعد تفعيل الفوترة الإلكترونية المرحلة الثانية')"));
  assert.ok(page.includes("<select className={`input ${sellerLocked ? LOCKED_INPUT_CLASS : ''}`} value={countryCode} disabled={sellerLocked} {...lockedProps}"));
});

test('معرّف الحزمة: يُحقن بـVite define بصيغة يقبلها الخادم (≤ 40 محرفاً آمناً)، و«dev» خارج Vite', () => {
  assert.equal(BUILD_ID, 'dev');
  const vite = read('vite.config.ts');
  assert.match(vite, /define: \{ __BUILD_ID__: JSON\.stringify\(BUILD_ID\) \}/);
  // الصيغة نفسها على أطول مدخل ممكن
  const sample = [new Date('2026-12-31T23:59:59.999Z').toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), 'a1b2c3d4e5f6'.slice(0, 7)].filter(Boolean).join('-');
  assert.equal(sample, '20261231T235959Z-a1b2c3d');
  assert.match(sample, /^[A-Za-z0-9._:+-]{1,40}$/);
  assert.ok(vite.includes(".replace(/[-:]/g, '').replace(/\\.\\d+Z$/, 'Z'), (process.env.RENDER_GIT_COMMIT || '').slice(0, 7)]"), 'الصيغة في vite.config.ts تغيّرت عن المختبَرة');
});
