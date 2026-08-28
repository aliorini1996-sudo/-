import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * حارس «شكل الأرقام» — خيار كل شركة بين ٠١٢٣ و0123.
 *
 * الحيلة كلها في إلحاق نظام الترقيم بالـlocale (`-u-nu-latn` / `-u-nu-arab`):
 * Intl يطبّقه على الأرقام والتواريخ والعملات معاً، فيسري الخيار من نقطة واحدة.
 * هذه الحرّاس تثبت أن الإلحاق يعمل فعلاً في بيئة التشغيل — لا نفترضه.
 *
 * ⚠️ تُختبر السلسلة الحرفية لا الدالة: `locale()` تقرأ حالة المتجر (zustand)
 * وإعدادات حيّة، وإقحامها هنا يختبر الوهم لا القاعدة.
 */

const AR = 'ar-SA-u-nu-arab';
const LATN = 'ar-SA-u-nu-latn';

const ARABIC_INDIC = /[٠-٩]/;   // ٠-٩
const LATIN_DIGITS = /[0-9]/;

test('الأرقام العربية: التنسيق يعطي ٠١٢٣ لا 0123', () => {
  const s = new Intl.NumberFormat(AR).format(1234.5);
  assert.ok(ARABIC_INDIC.test(s), `توقعت أرقاما عربية فجاء: ${s}`);
  assert.ok(!LATIN_DIGITS.test(s), `تسربت أرقام لاتينية: ${s}`);
});

test('الأرقام الإنجليزية: التنسيق يعطي 0123 لا ٠١٢٣', () => {
  const s = new Intl.NumberFormat(LATN).format(1234.5);
  assert.ok(LATIN_DIGITS.test(s), `توقعت أرقاما لاتينية فجاء: ${s}`);
  assert.ok(!ARABIC_INDIC.test(s), `تسربت أرقام عربية: ${s}`);
});

test('المبالغ بالعملة تتبع الخيار — لا الأرقام المجردة وحدها', () => {
  const opts: Intl.NumberFormatOptions = { style: 'currency', currency: 'SAR', minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const ar = new Intl.NumberFormat(AR, opts).format(343.85);
  const latn = new Intl.NumberFormat(LATN, opts).format(343.85);
  assert.ok(ARABIC_INDIC.test(ar) && !LATIN_DIGITS.test(ar), `العملة بالعربية: ${ar}`);
  assert.ok(LATIN_DIGITS.test(latn) && !ARABIC_INDIC.test(latn), `العملة باللاتينية: ${latn}`);
});

test('التواريخ تتبع الخيار كذلك — الفاتورة كلها بنسق واحد', () => {
  const d = new Date('2026-08-27T10:30:00Z');
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' };
  const ar = new Intl.DateTimeFormat(AR, opts).format(d);
  const latn = new Intl.DateTimeFormat(LATN, opts).format(d);
  assert.ok(ARABIC_INDIC.test(ar), `التاريخ بالعربية: ${ar}`);
  assert.ok(LATIN_DIGITS.test(latn) && !ARABIC_INDIC.test(latn), `التاريخ باللاتينية: ${latn}`);
});

test('اللغات اللاتينية تبقى لاتينية مهما كان الخيار', () => {
  for (const loc of ['en-US', 'fr-FR', 'tr-TR']) {
    const s = new Intl.NumberFormat(loc).format(1234.5);
    assert.ok(!ARABIC_INDIC.test(s), `${loc} خرج بأرقام عربية: ${s}`);
  }
});

test('القيمة العددية لا تتغير — الخيار عرض لا حساب', () => {
  const raw = 1234.56;
  for (const loc of [AR, LATN]) {
    const s = new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(raw);
    // نعيد النسق العربي إلى اللاتيني ثم نقرأ الرقم — يجب أن يطابق الأصل.
    // النسق العربي يستعمل فاصلة عشرية عربية (٫ U+066B) وحاجز آلاف (٬ U+066C)
    // لا النقطة والفاصلة اللاتينيتين — وتجريدهما بلا ترجمة يفقد الكسر
    const back = s
      .replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660))
      .replace(/٫/g, '.')
      .replace(/[^\d.]/g, '');
    assert.equal(Number(back), raw, `انحرفت القيمة في ${loc}: ${s}`);
  }
});
