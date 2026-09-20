import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeScale } from './pdf';

/**
 * حارس مقياس التقاط PDF — يمنع عودة «الصفحة البيضاء».
 *
 * جدولٌ طويل في canvas واحد كان يتجاوز حدّ المتصفّح فتخرج html2canvas صورةً
 * بيضاء صامتة. safeScale يبقي كل التقاطٍ دون الحدّين (بُعد Chrome ومساحة iOS)،
 * والمُستدعي يقطّع الصفوف فوق ذلك. هذه الحرّاس تُثبّت الحدّين.
 */

const MAX_DIM = 16384;
const MAX_AREA = 16_000_000;

test('عنصر صغير يأخذ المقياس المطلوب كاملاً', () => {
  assert.equal(safeScale(780, 400), 2);
  assert.equal(safeScale(780, 4000), 2);
});

// شريحةٌ واحدة (≤300 صفّ ≈ 9000px، وبهامشٍ واسع حتى 20000px) لا تتجاوز الحدّين
// أبداً — وهو النطاق الفعليّ بعد تقطيع sheetsToPdf. فوقه تتكفّل الأرضية بجودةٍ
// مقروءة، والحارس في elementsToPdfBlob (canvas فارغ ⇒ خطأ) يمنع أيّ بياض صامت.
test('ضمن نطاق الشريحة المقطّعة لا يتجاوز أي بُعد الحدّ ولا المساحة', () => {
  for (const h of [4000, 9000, 14000, 20000]) {
    const s = safeScale(780, h);
    assert.ok(Math.max(780, h) * s <= MAX_DIM + 1, `البُعد تجاوز الحدّ عند h=${h}`);
    assert.ok(780 * h * s * s <= MAX_AREA * 1.001, `المساحة تجاوزت الحدّ عند h=${h}`);
  }
});

test('المقياس يتناقص مع طول الجدول ثم يستقرّ على أرضية 0.6 (لا يهبط لصفر)', () => {
  assert.ok(safeScale(780, 14000) < 2, 'جدول متوسط الطول يُصغَّر');
  assert.ok(safeScale(780, 40000) < safeScale(780, 14000), 'الأطول يُصغَّر أكثر');
  assert.ok(safeScale(780, 1_000_000) >= 0.6, 'لا يهبط تحت الأرضية');
});

test('أبعاد فاسدة (صفر/سالب) لا تُنتج NaN', () => {
  assert.equal(safeScale(0, 100), 2);
  assert.equal(safeScale(780, 0), 2);
  assert.ok(Number.isFinite(safeScale(-5, 100)));
});
