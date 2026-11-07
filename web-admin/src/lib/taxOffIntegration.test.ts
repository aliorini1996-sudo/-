/**
 * «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — حرّاس الدمج: ترجمات ثوابت الأساس (lib/taxMode.ts) في القاموس بلغاته الأربع،
 * وحارس جمع بيانات المشتري (zatcaCollectOn) لسباق الإزالة مع علم المالك، وعبارتا «المرحلة الأولى» و«ولا ضريبة» تحت الإزالة
 * (بطاقة المرتجعات وإشعار موضع الصفوف في الدفاتر). الشركة بضريبتها (taxDisabled غائب أو false): كل شيء كما كان حرفاً.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PHRASES } from '../i18n/strings';
import { TAX_FREE_TITLES, TAX_MODE_CONFIRM_OFF, TAX_MODE_HINT, TAX_MODE_LABEL, TAX_MODE_MESSAGES } from './taxMode';
import { buyerRelaxOn, zatcaCollectOn } from './zatcaRegime';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const TAX_WORD = /ضريب|VAT|\btax\b|\bTVA\b|\bKDV\b|增值税|税/i;

test('ثوابت الأساس وعنوانا المستند بلا ضريبة مترجمةٌ بلغاتها الأربع (tr يمرّرها كمتغيّرات فلا يلتقطها حارس langs)', () => {
  const keys = [TAX_MODE_LABEL, TAX_MODE_HINT, TAX_MODE_CONFIRM_OFF, ...Object.values(TAX_MODE_MESSAGES), ...Object.values(TAX_FREE_TITLES)];
  for (const k of keys) {
    const e = PHRASES[k];
    assert.ok(e, `غائبة عن القاموس: ${k}`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(e[l] && !/[؀-ۿ]/.test(e[l]), `${l} لـ${k}`);
    }
  }
  // عنوانا المستند بلا ضريبة لا يحملان ذكرها في أيّ لغة
  for (const t of Object.values(TAX_FREE_TITLES)) for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.doesNotMatch(PHRASES[t][l], TAX_WORD);
});

test('zatcaCollectOn: الشركة بلا ضريبة لا تجمع بيانات المشتري ولو بقي علم المالك أو التفعيل (سباق) — والغائب/false كما كان', () => {
  const flagged = { countryCode: 'SA', zatcaPhase2Enabled: true };
  const live = { countryCode: 'SA', zatcaPhase2StartedAt: '2026-10-02T00:00:00.000Z' };
  for (const c of [flagged, live]) {
    assert.equal(zatcaCollectOn(c), true);
    assert.equal(zatcaCollectOn({ ...c, taxDisabled: false }), true);
    assert.equal(zatcaCollectOn({ ...c, taxDisabled: null }), true);
    assert.equal(zatcaCollectOn({ ...c, taxDisabled: true }), false);
    assert.equal(buyerRelaxOn({ ...c, buyerVatAddressRelaxed: true, taxDisabled: true }), false);
    assert.equal(buyerRelaxOn({ ...c, buyerVatAddressRelaxed: true }), true);
  }
  assert.equal(zatcaCollectOn({ countryCode: 'SA', taxDisabled: true }), false);
  assert.equal(zatcaCollectOn({ countryCode: 'AE', zatcaPhase2Enabled: true }), false);
});

test('بطاقة المرتجعات: «غير مشترط» وحدها للشركة بلا ضريبة — وعبارة المرحلة الأولى لغيرها كما كانت', () => {
  const s = read('components', 'ReturnPolicyCard.tsx');
  assert.ok(s.includes("import { isTaxOff } from '../lib/taxMode';"));
  assert.match(s, /const taxOff = isTaxOff\(company\);/);
  assert.ok(s.includes("<b>{phaseDefault ? tr('مشترط في المرحلة الثانية') : taxOff ? tr('غير مشترط') : tr('غير مشترط في المرحلة الأولى')}</b>"));
  assert.ok(PHRASES['غير مشترط'], 'المفتاح غائب عن القاموس');
});

test('إشعار موضع الصفوف في الدفاتر: سطر «بعد البدء» بلا «ولا ضريبة» للشركة بلا ضريبة — والنصّ القديم لغيرها', () => {
  const s = read('components', 'ImportLedgerNotice.tsx');
  const withTax = 'في يوم البدء أو بعده: تُرحَّل بتاريخها على حساب الأرصدة الافتتاحية 319002، لا إيرادا ولا ضريبة';
  const noTax = 'في يوم البدء أو بعده: تُرحَّل بتاريخها على حساب الأرصدة الافتتاحية 319002، لا إيرادا';
  assert.ok(s.includes(`\${taxOff ? tr('${noTax}') : tr('${withTax}')}`));
  assert.doesNotMatch(noTax, TAX_WORD);
  assert.ok(PHRASES[noTax] && PHRASES[withTax]);
  for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.doesNotMatch(PHRASES[noTax][l], TAX_WORD, l);
  // اللوحة تمرّر علم الشركة نفسه الذي يُسقط أعمدة الضريبة من الاستيراد
  const panel = read('components', 'DataImportPanel.tsx');
  assert.ok(panel.includes('<CutoverSplitNotice ctx={ledger} split={view.split} excludeAfter={excludeAfter} taxOff={taxOff}'));
  assert.match(panel, /const taxOff = isTaxOff\(companyCfg\);/);
});
