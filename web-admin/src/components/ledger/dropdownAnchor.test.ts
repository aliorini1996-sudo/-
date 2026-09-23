import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DROPDOWN_EDGE, MIN_DROPDOWN_HEIGHT, MIN_DROPDOWN_WIDTH, PREFERRED_DROPDOWN_HEIGHT,
  anchorDropdown, anchorVisible, clampTo, dropdownLeft, dropdownVertical, dropdownWidth, samePosition,
  type AnchorPosition, type AnchorRect, type AnchorViewport,
} from './dropdownAnchor';

/**
 * حسابُ موضع قائمة منتقي الحساب بعد إخراجها من الحاضن القاصّ.
 *
 * الحالة التي كسرت الاستعمال (قياس المتشكّك على الدفعة أ): القائمة `absolute` داخل
 * `div.table-wrapper.overflow-x-auto`، وارتفاعها ٣٦٦px يُقصّ إلى ١٣٥px على جوال ٤٠٠px
 * وإلى ٢١٥px على ١٢٨٠px — فلا يُرى إلا رأس «الأصول» وحسابٌ واحد. أكثر اختبارات هذا
 * الملف حراسةٌ على ألّا يعود القصّ: الارتفاع المتاح لا ينزل عن ٣٦٦px حين تتّسع النافذة،
 * والقائمة كلّها تبقى داخل حدود النافذة في كل الأحوال.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcFile = (rel: string) => readFileSync(join(here, '../..', rel), 'utf8');

/** الارتفاع الذي قاسه المتشكّك للقائمة كاملةً قبل القصّ. */
const FULL_LIST_HEIGHT = 366;

const rect = (top: number, left: number, width: number, height = 32): AnchorRect =>
  ({ top, bottom: top + height, left, right: left + width, width });

const vw = (width: number, height: number): AnchorViewport => ({ width, height });

/** الشريط الرأسي الذي تشغله القائمة فعلاً — يُشتقّ من `top` أو من `bottom` حسب الانقلاب. */
function band(pos: AnchorPosition, viewport: AnchorViewport): { top: number; bottom: number } {
  if (pos.placement === 'below') {
    assert.equal(pos.bottom, null, 'الفتح تحت الحقل يضبط top وحده');
    return { top: pos.top!, bottom: pos.top! + pos.maxHeight };
  }
  assert.equal(pos.top, null, 'الانقلاب فوق الحقل يضبط bottom وحده');
  const bottom = viewport.height - pos.bottom!;
  return { top: bottom - pos.maxHeight, bottom };
}

// ═══ الحصر ═══

test('clampTo يحصر بين الحدّين ويغلّب الأدنى إن انعكسا', () => {
  assert.equal(clampTo(50, 0, 100), 50);
  assert.equal(clampTo(-5, 0, 100), 0);
  assert.equal(clampTo(120, 0, 100), 100);
  // نافذة أضيق من القائمة: الحدّ الأعلى دون الأدنى — نلتزم الهامش الأدنى لا القيمة السالبة
  assert.equal(clampTo(500, 8, -20), 8);
});

// ═══ تحت الحقل: لا قصّ ═══

test('نافذة طويلة: القائمة تحت الحقل بارتفاعها الكامل — لا قصّ', () => {
  const view = vw(1280, 800);
  const pos = anchorDropdown(rect(300, 900, 300), view);
  assert.equal(pos.placement, 'below');
  assert.equal(pos.top, 336); // أسفل الحقل (332) + الفراغ (4)
  assert.equal(pos.bottom, null);
  assert.equal(pos.maxHeight, PREFERRED_DROPDOWN_HEIGHT);
  assert.ok(pos.maxHeight >= FULL_LIST_HEIGHT, 'عاد القصّ: الارتفاع المتاح دون ارتفاع القائمة');
});

test('جوال ٤٠٠px: القائمة تحت الحقل بلا قصّ ولا خروج عن النافذة', () => {
  const view = vw(400, 800);
  const pos = anchorDropdown(rect(180, 20, 360), view);
  const b = band(pos, view);
  assert.equal(pos.placement, 'below');
  assert.ok(pos.maxHeight >= FULL_LIST_HEIGHT, 'الارتفاع المتاح على الجوال دون ارتفاع القائمة — القصّ عاد');
  assert.ok(b.top >= DROPDOWN_EDGE && b.bottom <= view.height - DROPDOWN_EDGE);
});

// ═══ الانقلاب فوق الحقل ═══

test('حقل قرب أسفل النافذة: القائمة تنقلب فوقه وتلتصق به', () => {
  const view = vw(400, 800);
  const anchor = rect(700, 20, 360);
  const pos = anchorDropdown(anchor, view);
  const b = band(pos, view);
  assert.equal(pos.placement, 'above');
  assert.equal(b.bottom, anchor.top - 4, 'أسفل القائمة لا يلتصق بأعلى الحقل');
  assert.equal(pos.maxHeight, PREFERRED_DROPDOWN_HEIGHT);
  assert.ok(b.top >= DROPDOWN_EDGE, 'رأس القائمة يخرج من أعلى النافذة');
});

test('لا تنقلب إلا حين تكون المساحة فوق الحقل أوسع', () => {
  const view = vw(400, 800);
  // مساحة تحته ٤٥٦ ومساحة فوقه ٢٨٨ — تبقى تحته وإن لم تكفِ لو كانت أقلّ
  assert.equal(dropdownVertical(rect(300, 20, 360), view).placement, 'below');
  // تحته ٥٦ وفوقه ٦٨٨ — تنقلب
  assert.equal(dropdownVertical(rect(700, 20, 360), view).placement, 'above');
  // متساويتان — تبقى تحته (الأصل)
  assert.equal(dropdownVertical(rect(378, 20, 360), view).placement, 'below');
});

// ═══ الحواف والاتجاه ═══

test('RTL تحاذي حافة الحقل اليمنى وLTR حافته اليسرى', () => {
  const view = vw(800, 800);
  const anchor = rect(100, 240, 120); // حقل أضيق من أدنى عرض
  const wide = dropdownWidth(anchor, view);
  assert.equal(wide, MIN_DROPDOWN_WIDTH, 'الحقل الضيّق لا يرفع القائمة إلى أدنى عرضها');
  assert.equal(dropdownLeft(anchor, view, wide, { dir: 'rtl' }) + wide, anchor.right);
  assert.equal(dropdownLeft(anchor, view, wide, { dir: 'ltr' }), anchor.left);
});

test('القائمة لا تخرج من حافتَي النافذة يميناً ولا يساراً', () => {
  const view = vw(400, 800);
  // حقل ملاصق للحافة اليمنى: المحاذاة اليمنى تدفعها خارج النافذة لولا الحصر
  const nearRight = anchorDropdown(rect(100, 95, 300), view, { dir: 'rtl' });
  assert.equal(nearRight.left, 92);
  assert.equal(nearRight.left + nearRight.width, view.width - DROPDOWN_EDGE);
  // والمثل في LTR بحقلٍ يبدأ بعد منتصف النافذة
  const nearLeft = anchorDropdown(rect(100, 150, 300), view, { dir: 'ltr' });
  assert.equal(nearLeft.left + nearLeft.width, view.width - DROPDOWN_EDGE);
  assert.ok(nearLeft.left >= DROPDOWN_EDGE);
});

test('نافذة أضيق من أدنى عرض القائمة: تُقلَّص إلى ما بين الهامشين', () => {
  const view = vw(260, 800);
  const pos = anchorDropdown(rect(100, 30, 200), view);
  assert.equal(pos.width, view.width - 2 * DROPDOWN_EDGE);
  assert.equal(pos.left, DROPDOWN_EDGE);
});

// ═══ النافذة القصيرة ═══

test('نافذة قصيرة: ارتفاع لا ينزل عن الأدنى والقائمة كلّها داخل النافذة', () => {
  const view = vw(400, 240);
  const pos = anchorDropdown(rect(100, 40, 300), view);
  const b = band(pos, view);
  assert.equal(pos.maxHeight, MIN_DROPDOWN_HEIGHT, 'القائمة انكمشت إلى سطرٍ واحد — علّة القصّ نفسها');
  assert.ok(b.top >= DROPDOWN_EDGE && b.bottom <= view.height - DROPDOWN_EDGE, 'القائمة تتجاوز حدود النافذة القصيرة');
});

test('نافذة أقصر من الأدنى نفسه: الارتفاع يلتزم النافذة لا الأدنى', () => {
  const view = vw(400, 100);
  const pos = anchorDropdown(rect(40, 40, 300), view);
  const b = band(pos, view);
  assert.equal(pos.maxHeight, view.height - 2 * DROPDOWN_EDGE);
  assert.ok(b.top >= DROPDOWN_EDGE && b.bottom <= view.height - DROPDOWN_EDGE);
});

// ═══ مسحٌ شامل: لا خروج عن النافذة في أي موضع ═══

test('مسح المواضع كلّها: القائمة داخل النافذة دائماً، وبلا قصّ حين تتّسع', () => {
  for (const view of [vw(400, 800), vw(1280, 800), vw(360, 640), vw(400, 240)]) {
    for (const dir of ['rtl', 'ltr'] as const) {
      for (let top = 0; top <= view.height - 32; top += 16) {
        for (const left of [0, Math.round(view.width / 2) - 60, view.width - 220]) {
          const pos = anchorDropdown(rect(top, left, 220), view, { dir });
          const b = band(pos, view);
          const tag = `${dir} ${view.width}×${view.height} top=${top} left=${left}`;
          assert.ok(b.top >= DROPDOWN_EDGE, `رأس القائمة خارج النافذة (${tag})`);
          assert.ok(b.bottom <= view.height - DROPDOWN_EDGE, `ذيل القائمة خارج النافذة (${tag})`);
          assert.ok(pos.left >= DROPDOWN_EDGE, `القائمة خارج الحافة (${tag})`);
          assert.ok(pos.left + pos.width <= view.width - DROPDOWN_EDGE, `القائمة تتجاوز الحافة المقابلة (${tag})`);
          // نافذة ٨٠٠px فيها متّسع لارتفاع القائمة كاملاً فوق الحقل أو تحته
          if (view.height >= 800) {
            assert.ok(pos.maxHeight >= FULL_LIST_HEIGHT, `قصٌّ في نافذة واسعة (${tag})`);
          }
        }
      }
    }
  }
});

test('anchorVisible يكشف خروج الحقل من النافذة بالتمرير', () => {
  const view = vw(400, 800);
  assert.ok(anchorVisible(rect(300, 40, 300), view));
  assert.ok(!anchorVisible(rect(-40, 40, 300), view), 'حقلٌ مرّ فوق الشاشة ما زال «مرئياً»');
  assert.ok(!anchorVisible(rect(800, 40, 300), view), 'حقلٌ تحت الشاشة ما زال «مرئياً»');
  // تمريرٌ أفقيّ داخل شبكة القيد يخرج العمود من الشاشة
  assert.ok(!anchorVisible(rect(300, -320, 300), view), 'عمودٌ خرج يساراً ما زال «مرئياً»');
  assert.ok(!anchorVisible(rect(300, 400, 300), view), 'عمودٌ خرج يميناً ما زال «مرئياً»');
  // ملامسةٌ جزئية تبقى مرئية
  assert.ok(anchorVisible(rect(-16, 40, 300), view));
});

test('samePosition يمنع إعادة التصيير بلا تغيّر', () => {
  const view = vw(1280, 800);
  const a = anchorDropdown(rect(300, 900, 300), view);
  assert.ok(samePosition(a, anchorDropdown(rect(300, 900, 300), view)));
  assert.ok(!samePosition(a, anchorDropdown(rect(301, 900, 300), view)));
  assert.ok(samePosition(null, null));
  assert.ok(!samePosition(a, null));
});

// ═══ حارس على الواجهة نفسها ═══

test('قائمة منتقي الحساب مبوَّبة إلى body وتتبع الحقل ولا تُقصّ', () => {
  const s = srcFile('components/ledger/MoveLinesGrid.tsx');
  const code = s.split(/\r?\n/).filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.ok(code.includes('createPortal('), 'القائمة لم تُبوَّب خارج الحاضن — تعود مقصوصة');
  assert.ok(code.includes('document.body'), 'البوّابة ليست إلى body');
  assert.ok(code.includes('anchorDropdown('), 'الموضع غير محسوب من حساب المرساة');
  assert.ok(code.includes('getBoundingClientRect()'), 'الموضع غير مقيس من الحقل');
  // تتبُّع الحقل: التمرير بالتقاط (حدث scroll لا يصعد من الحاضن) والتحجيم
  assert.match(code, /addEventListener\('scroll', [A-Za-z]+, true\)/, 'تمرير الحاضن الداخلي لا يحرّك القائمة');
  assert.ok(code.includes("addEventListener('resize'"), 'تغيير القياس لا يحرّك القائمة');
  assert.ok(code.includes("removeEventListener('scroll'") && code.includes("removeEventListener('resize'"), 'مستمعات التمرير والتحجيم لا تُنزع');
  // لا يعود الغلاف `absolute` داخل الحاضن القاصّ
  assert.ok(!/className="absolute z-30/.test(code), 'القائمة عادت absolute داخل الشبكة');
  // السلوك المحفوظ: السهام وEnter وEsc والاتجاه
  for (const k of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'dir={dir}']) {
    assert.ok(code.includes(k), `فُقد ${k} من المنتقي بعد التبويب`);
  }
  // الحاضن يبقى قابلاً للتمرير الأفقي — لم يُعالَج القصّ برفع overflow عنه
  assert.ok(code.includes('table-wrapper overflow-x-auto'), 'رُفع التمرير الأفقي عن شبكة القيد');
});
