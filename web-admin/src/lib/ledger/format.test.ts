import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useLang } from '../../i18n/lang';
import { setActiveNumerals } from '../../utils/format';
import { formatLedgerAmount, ledgerAmountParts, milliToDecimalString } from './format';
import { LedgerAmount } from '../../components/ledger/LedgerAmount';

/**
 * تنسيق مبالغ الدفاتر (§8.3): العلامة اللاحقة بمحارف أرقام اللغة، والعزل بـbdi dir=ltr.
 * يمرّ بالمسار الحقيقي (`activeLocale()` من متجر اللغة و`activeNumerals`) لا بسلسلة locale حرفية.
 */

const setLang = (lang: 'ar' | 'en' | 'fr' | 'tr' | 'zh') => useLang.setState({ lang });

test('ar بالأرقام العربية: ٣٬٢١٠٫٣٤-', () => {
  setLang('ar'); setActiveNumerals('arabic');
  const s = formatLedgerAmount(-3210.34, { decimals: 2 });
  assert.equal(s, '٣٬٢١٠٫٣٤-');
  assert.ok(s.endsWith('-') && !s.startsWith('-'));
});

test('ar بالأرقام اللاتينية وen: 3,210.34-', () => {
  setLang('ar'); setActiveNumerals('latin');
  assert.equal(formatLedgerAmount(-3210.34, { decimals: 2 }), '3,210.34-');
  setLang('en');
  assert.equal(formatLedgerAmount(-3210.34, { decimals: 2 }), '3,210.34-');
});

test('fr: العلامة لاحقة بفواصل اللغة (3 210,34-) وأرقام لاتينية', () => {
  setLang('fr');
  const s = formatLedgerAmount(-3210.34, { decimals: 2 });
  assert.equal(s.replace(/[  ]/g, ' '), '3 210,34-');
  assert.doesNotMatch(s, /[٠-٩]/);
});

test('الموجب بلا علامة، والصفر السالب بلا «-»، والمنازل الثلاث', () => {
  setLang('en');
  assert.equal(formatLedgerAmount(3210.34, { decimals: 2 }), '3,210.34');
  assert.equal(formatLedgerAmount(-0.001, { decimals: 2 }), '0.00');
  assert.equal(formatLedgerAmount('-1234.5675', { decimals: 3 }), '1,234.568-');
  assert.equal(formatLedgerAmount(-3210.34, { decimals: 2, negativeStyle: 'leading' }), '-3,210.34');
  assert.equal(ledgerAmountParts(0, { decimals: 2 }).zero, true);
});

test('التقريب نصف-لأعلى بلا فقد دقة عائم (1.005 ⇒ 1.01)', () => {
  setLang('en');
  assert.equal(formatLedgerAmount('1.005', { decimals: 2 }), '1.01');
  assert.equal(formatLedgerAmount('-2.675', { decimals: 2 }), '2.68-');
  assert.equal(milliToDecimalString('-3210340'), '-3210.340');
  assert.equal(milliToDecimalString(5), '0.005');
});

test('LedgerAmount يلفّ المبلغ في bdi dir=ltr والعلامة اللاحقة داخله', () => {
  setLang('ar'); setActiveNumerals('latin');
  const html = renderToStaticMarkup(createElement(LedgerAmount, { value: -3210.34, decimals: 2 }));
  assert.match(html, /^<bdi dir="ltr"[^>]*>3,210\.34-<\/bdi>$/);
  setActiveNumerals('arabic');
  const html2 = renderToStaticMarkup(createElement(LedgerAmount, { value: -3210.34, decimals: 2 }));
  assert.match(html2, /^<bdi dir="ltr"[^>]*>٣٬٢١٠٫٣٤-<\/bdi>$/);
});

test('parseAmountToMilli: الأرقام العربية والفواصل والتقريب', async () => {
  const { parseAmountToMilli, ledgerName } = await import('./format');
  assert.equal(parseAmountToMilli('٣٬٢١٠٫٣٤', 2), 3210340n);
  assert.equal(parseAmountToMilli('1,234.5', 2), 1234500n);
  assert.equal(parseAmountToMilli('3,5', 2), 3500n);
  assert.equal(parseAmountToMilli('1.005', 2), 1010n);
  assert.equal(parseAmountToMilli('', 2), 0n);
  assert.equal(parseAmountToMilli('abc', 2), null);
  assert.equal(ledgerName({ name: 'النقدية', nameEn: 'Cash', nameI18n: { fr: 'Caisse' } }, 'fr'), 'Caisse');
  assert.equal(ledgerName({ name: 'النقدية', nameEn: 'Cash', nameI18n: null }, 'tr'), 'Cash');
  assert.equal(ledgerName({ name: 'النقدية', nameEn: 'Cash', nameI18n: null }, 'ar'), 'النقدية');
});
