import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { layoutPageStarts, safeScale } from './pdf';

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

// ─── «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦): لوحتا الرأس/التذييل في تقسيم ملف الـPDF ───
// layoutPageStarts يقرأ صناديق `[data-section]` (keepBoxesOf) — ولوحتا المصمّم data-section="canvas-header|canvas-footer" منها.
// والحدود في النواة (رأس ≤ 150 مم أوّل الصفحة الأولى، وتذييل ≤ 120 مم دون نصف صفحة PDF بعرض 794) تمنع قصّ أيٍّ منهما.

const MM = 96 / 25.4;
const A4_PAGE_PX = (841.89 / 595.28) * 794; // طول صفحة A4 ببكسل العنصر (الصورة بعرض الصفحة)
const LETTER_PAGE_PX = (792 / 612) * 794;

test('التحرير الحرّ: لوحة التذييل (حتى 120 مم) العابرة لحدّ الصفحة تنقل القصّ إلى أعلاها — على A4 وLetter', () => {
  for (const pagePx of [A4_PAGE_PX, LETTER_PAGE_PX]) {
    for (const footMm of [20, 60, 120]) {
      const h = footMm * MM;
      for (const top of [pagePx - h + 5, pagePx - h / 2, pagePx - 10]) {
        const band = { top, bottom: top + h };
        const rows = Array.from({ length: 60 }, (_, i) => ({ top: 160 + i * 30, bottom: 160 + i * 30 + 28 })).filter((r) => r.bottom <= top);
        const starts = layoutPageStarts(band.bottom + 40, pagePx, [...rows, band]);
        assert.ok(starts.every((s) => !(s > band.top + 0.5 && s < band.bottom - 0.5)), `قصٌّ داخل اللوحة: ${footMm} مم عند ${top.toFixed(0)}`);
        assert.ok(starts.includes(band.top), `القصّ لم يرتفع لأعلى اللوحة: ${footMm} مم`);
      }
    }
  }
});

test('التحرير الحرّ: لوحة الرأس (حتى 150 مم) أوّل الورقة لا تُقصّ، والورقة بلا لوحات كما هي', () => {
  const head = { top: 40, bottom: 40 + 150 * MM };
  const starts = layoutPageStarts(3000, A4_PAGE_PX, [head]);
  assert.ok(starts.every((s) => !(s > head.top && s < head.bottom)));
  assert.deepEqual(layoutPageStarts(3000, A4_PAGE_PX, []), layoutPageStarts(3000, A4_PAGE_PX, [{ top: 0, bottom: 0 }]));
  // الرأس أوّل الصفحة الأولى فيتّسع لها كاملاً (حشوة 40 + 150 مم)، والتذييل دون نصف أقصر صفحة (Letter) فلا يُقصّ أينما وقع
  assert.ok(40 + 150 * MM < LETTER_PAGE_PX && 120 * MM < LETTER_PAGE_PX / 2, 'حدود اللوحتين في النواة');
  // الصناديق من [data-section] — لوحتا المصمّم داخلها
  const src = fs.readFileSync(path.join(process.cwd(), 'src/rep/pdf.ts'), 'utf8');
  assert.ok(src.includes("el.querySelectorAll('tr, [data-section], [data-line]')"));
});
