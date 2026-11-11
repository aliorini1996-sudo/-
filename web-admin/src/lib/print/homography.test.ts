// «نموذج الشركة المطبوع مسبقاً» — تصحيح المنظور الخالص: حلّ النظام 8×8، والتحويل ومعكوسه، والأركان تنطبق بالضبط، وأخذ العيّنات
// الثنائي الخطي (الهوية بلا تغيير، والقصّ، والتركيب فوق الأبيض، وما خارج الصورة أبيض).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyH, invertH, isConvexQuad, quadArea, quadSignedArea, rectQuad, solveHomography, solveLinear, warpQuadToRect, warpToRect,
  type Homography, type Quad,
} from './homography';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/** صورة RGBA اصطناعية: لون كل بكسل دالّةٌ في موضعه */
function synth(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set(f(x, y), (y * w + x) * 4);
  return a;
}
const px = (a: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(a.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

test('solveLinear: نظامٌ معروف، والمنفرد null، وما ليس عدداً null', () => {
  const x = solveLinear([[2, 1, -1], [-3, -1, 2], [-2, 1, 2]], [8, -11, -3]);
  assert.ok(x);
  near(x[0], 2); near(x[1], 3); near(x[2], -1);
  assert.equal(solveLinear([[1, 2], [2, 4]], [3, 6]), null);
  assert.equal(solveLinear([[1, Number.NaN], [0, 1]], [1, 1]), null);
  assert.equal(solveLinear([[1, 0]], [1, 1]), null);
  // يحتاج تبديل صفوف (المحور الأول صفر)
  const y = solveLinear([[0, 1], [1, 0]], [5, 7]);
  assert.deepEqual(y, [7, 5]);
});

test('الهوية: المستطيل إلى نفسه ⇒ مصفوفة الوحدة', () => {
  const H = solveHomography(rectQuad(1240, 1754), rectQuad(1240, 1754));
  assert.ok(H);
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  H.forEach((v, i) => near(v, I[i], 1e-9));
});

test('شكلٌ رباعي معروف (صورة جوال مائلة): الأركان الأربعة تنطبق بالضبط، والمعكوس يعيدها', () => {
  const quad: Quad = [{ x: 212.4, y: 95.1 }, { x: 1987.6, y: 160.3 }, { x: 2101.2, y: 2380.9 }, { x: 140.7, y: 2290.2 }];
  const rect = rectQuad(1240, 1754);
  const H = solveHomography(rect, quad);
  assert.ok(H);
  near(H[8], 1, 0);
  rect.forEach((r, i) => {
    const p = applyH(H, r.x, r.y);
    assert.ok(p);
    near(p.x, quad[i].x, 1e-6); near(p.y, quad[i].y, 1e-6);
  });
  const inv = invertH(H);
  assert.ok(inv);
  quad.forEach((q, i) => {
    const p = applyH(inv, q.x, q.y);
    assert.ok(p);
    near(p.x, rect[i].x, 1e-6); near(p.y, rect[i].y, 1e-6);
  });
  // والحلّ المباشر في الاتجاه المعاكس يساوي المعكوس
  const back = solveHomography(quad, rect);
  assert.ok(back);
  back.forEach((v, i) => near(v, inv[i], 1e-9));
  // مركز المستطيل يقع داخل الشكل (تقاطع القطرين للتحويل الإسقاطي)
  const c = applyH(H, 620, 877);
  assert.ok(c && c.x > 140 && c.x < 2101 && c.y > 95 && c.y < 2381);
});

test('تحويلٌ تآلفي معروف (تكبير وإزاحة) يُستعاد بقيمه', () => {
  const src = rectQuad(100, 50);
  const dst: Quad = src.map((p) => ({ x: 2 * p.x + 10, y: 3 * p.y - 5 })) as unknown as Quad;
  const H = solveHomography(src, dst);
  assert.ok(H);
  [2, 0, 10, 0, 3, -5, 0, 0, 1].forEach((v, i) => near(H[i], v, 1e-9));
});

test('الأركان الفاسدة: ثلاثٌ على خطٍّ واحد أو متكرّرة أو NaN ⇒ null', () => {
  const r = rectQuad(10, 10);
  assert.equal(solveHomography(r, [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]), null);
  assert.equal(solveHomography(r, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]), null);
  assert.equal(solveHomography(r, [{ x: Number.NaN, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), null);
  assert.equal(applyH([0, 0, 0, 0, 0, 0, 0, 0, 0] as unknown as Homography, 1, 1), null);
  assert.equal(invertH([1, 2, 3, 2, 4, 6, 0, 0, 1] as unknown as Homography), null);
});

test('isConvexQuad والمساحة: المحدّب صالح بالاتجاهين، والمتقاطع (ربطة عنق) والمنطبق والصغير جداً لا', () => {
  assert.equal(quadArea(rectQuad(10, 20)), 200);
  assert.equal(isConvexQuad(rectQuad(10, 20)), true);
  assert.equal(isConvexQuad([...rectQuad(10, 20)].reverse() as unknown as Quad), true);
  // تبادل الركنين السفليين ⇒ متقاطع
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }]), false);
  // مقعّر (سهم)
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 10 }]), false);
  // ثلاث نقاط على خط
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]), false);
  assert.equal(isConvexQuad(rectQuad(10, 20), 500), false);
  assert.equal(isConvexQuad([{ x: Number.NaN, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }]), false);
});

test('warpToRect بالهوية: الصورة كما هي بكسلاً ببكسل', () => {
  const w = 7; const h = 5;
  const src = synth(w, h, (x, y) => [x * 30, y * 50, (x * y * 7) % 256, 255]);
  const H = solveHomography(rectQuad(w, h), rectQuad(w, h));
  assert.ok(H);
  const out = warpToRect(src, w, h, H, w, h);
  assert.deepEqual(Array.from(out), Array.from(src));
});

test('warpToRect: قصّ ربع الصورة الأيمن الأسفل إلى مستطيلٍ بحجمه يطابق بكسلاته', () => {
  const w = 8; const h = 6;
  const src = synth(w, h, (x, y) => [x * 31, y * 41, 100, 255]);
  const quad: Quad = [{ x: 4, y: 3 }, { x: 8, y: 3 }, { x: 8, y: 6 }, { x: 4, y: 6 }];
  const out = warpQuadToRect(src, w, h, quad, 4, 3);
  assert.ok(out);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) assert.deepEqual(px(out, 4, x, y), px(src, w, x + 4, y + 3));
});

test('warpToRect: التكبير ×2 يستوفي خطياً بين البكسلات، والحواف تُمسك آخر بكسل', () => {
  // صفٌّ واحد: 0 و200
  const src = synth(2, 1, (x) => [x * 200, x * 200, x * 200, 255]);
  const H = solveHomography(rectQuad(4, 1), rectQuad(2, 1));
  assert.ok(H);
  const out = warpToRect(src, 2, 1, H, 4, 1);
  // مراكز الهدف 0.5,1.5,2.5,3.5 ⇒ في المصدر 0.25,0.75,1.25,1.75 ⇒ -0.25,0.25,0.75,1.25 بعد إزاحة نصف بكسل
  assert.deepEqual([out[0], out[4], out[8], out[12]], [0, 50, 150, 200]);
  assert.ok([3, 7, 11, 15].every((i) => out[i] === 255));
});

test('warpToRect: الشفاف يُركَّب فوق الأبيض، وما خارج الصورة أبيض معتم، وout يُكتب فيه مباشرة', () => {
  const src = synth(2, 2, () => [0, 0, 0, 0]);
  const H = solveHomography(rectQuad(2, 2), rectQuad(2, 2));
  assert.ok(H);
  assert.deepEqual(Array.from(warpToRect(src, 2, 2, H, 2, 2)), new Array(16).fill(255));
  const half = synth(1, 1, () => [0, 0, 0, 128]);
  const one = warpToRect(half, 1, 1, H, 1, 1);
  assert.ok(Math.abs(one[0] - 127) <= 1 && one[3] === 255);
  // مستطيلٌ أكبر من الصورة بمرّتين: نصفه الأيمن خارجها ⇒ أبيض
  const red = synth(2, 2, () => [255, 0, 0, 255]);
  const H2 = solveHomography(rectQuad(4, 2), [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }]);
  assert.ok(H2);
  const buf = new Uint8ClampedArray(4 * 2 * 4);
  const o = warpToRect(red, 2, 2, H2, 4, 2, buf);
  assert.equal(o, buf);
  assert.deepEqual(px(o, 4, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(o, 4, 3, 1), [255, 255, 255, 255]);
  // مصدرٌ فاسد (أقصر من أبعاده) ⇒ أبيض لا استثناء
  assert.deepEqual(Array.from(warpToRect(new Uint8ClampedArray(3), 2, 2, H, 1, 1)), [255, 255, 255, 255]);
  // شكلٌ متقاطع ⇒ null
  assert.equal(warpQuadToRect(red, 2, 2, [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 }], 2, 2), null);
});

test('warpToRect: صورةٌ مائلة اصطناعية تُستعاد — مستطيلٌ ملوّن داخل شكلٍ رباعي يعود إلى موضعه', () => {
  // الهدف 40×60: النصف العلوي أسود والسفلي أبيض. نرسمه في «صورة» 100×100 عبر تحويلٍ معروف ثم نصحّحه
  const dw = 40; const dh = 60; const sw = 100; const sh = 100;
  const quad: Quad = [{ x: 15, y: 8 }, { x: 88, y: 14 }, { x: 92, y: 95 }, { x: 6, y: 90 }];
  const toRect = solveHomography(quad, rectQuad(dw, dh));
  assert.ok(toRect);
  const src = synth(sw, sh, (x, y) => {
    const p = applyH(toRect, x + 0.5, y + 0.5);
    if (!p || p.x < 0 || p.y < 0 || p.x > dw || p.y > dh) return [255, 0, 0, 255]; // خارج الورقة: أحمر
    return p.y < dh / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255];
  });
  const out = warpQuadToRect(src, sw, sh, quad, dw, dh);
  assert.ok(out);
  // بعيداً عن الحواف وخطّ المنتصف: أسود فوق، أبيض تحت، ولا أحمر من خارج الورقة
  for (let y = 3; y < dh - 3; y++) {
    if (Math.abs(y + 0.5 - dh / 2) < 3) continue;
    for (let x = 3; x < dw - 3; x++) {
      const [r, g] = px(out, dw, x, y);
      if (y < dh / 2) assert.ok(r < 40 && g < 40, `(${x},${y}) ليس أسود: ${r},${g}`);
      else assert.ok(r > 215 && g > 215, `(${x},${y}) ليس أبيض: ${r},${g}`);
    }
  }
});

test('المساحة الموقّعة: موجبةٌ للترتيب المعتمد على الشاشة (أعلى اليسار ثم اليمين ثم أسفل اليمين ثم اليسار) وسالبةٌ للمعكوس', () => {
  assert.equal(quadSignedArea(rectQuad(10, 20)), 200);
  assert.equal(quadSignedArea([...rectQuad(10, 20)].reverse() as unknown as Quad), -200);
  // تبديل الأعلى: اليسار مكان اليمين (صورةٌ كالمرآة أفقياً)
  assert.ok(quadSignedArea([{ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }]) < 0);
  assert.equal(quadArea([...rectQuad(10, 20)].reverse() as unknown as Quad), 200);
});
