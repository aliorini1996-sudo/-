// «نموذج الشركة المطبوع مسبقاً» — خطوة «رفع النموذج» بلا DOM (renderToStaticMarkup: المؤثّرات لا تعمل): الحالة الأولى زرّ الاختيار
// وحقل الملف بقبول الصور وPDF، والمقابض الأربعة أزرارٌ بمواضعها المئوية وtouch-action:none، وطبقة الأركان تعتّم ما خارج الورقة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FormUploadStep, { FormCornerHandles, FormQuadOverlay } from './FormUploadStep';
import type { Quad } from '../../../lib/print/formImageCompose';

const noop = () => {};

test('الحالة الأولى: زرّ اختيار الصورة وحقل ملفٍ مخفيّ يقبل JPG/PNG/WebP وPDF — بلا مقابض ولا زرّ تصحيحٍ مفعّل', () => {
  const html = renderToStaticMarkup(createElement(FormUploadStep, { paper: { widthMm: 210, lengthMm: 297 }, onDone: noop }));
  assert.match(html, /data-form-upload-step=""/);
  assert.match(html, /type="file"/);
  assert.match(html, /accept="image\/jpeg,image\/png,image\/webp[^"]*application\/pdf/);
  assert.match(html, /اختيار صورة النموذج/);
  // مقاس الورقة ودقّتها في الملاحظة
  assert.match(html, /210 × 297/);
  assert.match(html, /1240 × 1754/);
  assert.doesNotMatch(html, /data-form-corner=/);
  assert.match(html, /<button type="button"[^>]*disabled=""[^>]*data-form-upload-apply=""/);
  // كل زرّ type="button" (الخطوة قد تُفتح من داخل نموذج)
  assert.equal(html.match(/<button\b/g)?.length, html.match(/<button type="button"/g)?.length);
  // لا تنبيه صورةٍ حالية بلا current، ومعه يظهر
  assert.doesNotMatch(html, /data-form-upload-current/);
  const withCur = renderToStaticMarkup(createElement(FormUploadStep, {
    paper: { widthMm: 148, lengthMm: 210 }, onDone: noop, onCancel: noop,
    current: { id: '0f8fad5b-d9cb-469f-a165-70867728950e', v: 'a1b2c3d4e5f60718', wPx: 874, hPx: 1240 },
  }));
  assert.match(withCur, /data-form-upload-current=""/);
  assert.match(withCur, /874 × 1240/);
  assert.match(withCur, /إلغاء/);
});

test('المقابض: أربعة أزرار بمواضعها المئوية الماديّة، وtouch-action:none، والمسحوب أكبر', () => {
  const quad: Quad = [{ x: 0, y: 0 }, { x: 1200, y: 90 }, { x: 1150, y: 1800 }, { x: 60, y: 1700 }];
  const html = renderToStaticMarkup(createElement(FormCornerHandles, {
    quad, w: 1200, h: 1800, active: 2, onCornerPointerDown: noop, onCornerKeyDown: noop,
  }));
  assert.equal(html.match(/<button type="button"/g)?.length, 4);
  for (const k of ['tl', 'tr', 'br', 'bl']) assert.match(html, new RegExp(`data-form-corner="${k}"`));
  assert.equal(html.match(/touch-action:none/g)?.length, 4);
  assert.match(html, /left:100%;top:5%/);
  assert.match(html, /left:5%;top:94\.4/);
  assert.match(html, /width:22px;height:22px/);
  assert.match(html, /aria-label="ركن الورقة أعلى اليسار/);
  const off = renderToStaticMarkup(createElement(FormCornerHandles, {
    quad, w: 1200, h: 1800, disabled: true, onCornerPointerDown: noop, onCornerKeyDown: noop,
  }));
  assert.equal(off.match(/disabled=""/g)?.length, 4);
});

test('طبقة الأركان: SVG بفضاء الصورة، يعتّم ما خارج الورقة (evenodd)، ويتقطّع حدّها إن كانت الأركان فاسدة', () => {
  const quad: Quad = [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 140 }, { x: 10, y: 140 }];
  const ok = renderToStaticMarkup(createElement(FormQuadOverlay, { quad, w: 100, h: 150 }));
  assert.match(ok, /viewBox="0 0 100 150"/);
  assert.match(ok, /fill-rule="evenodd"/);
  assert.match(ok, /points="10,10 90,10 90,140 10,140"/);
  assert.doesNotMatch(ok, /stroke-dasharray/);
  const bad = renderToStaticMarkup(createElement(FormQuadOverlay, { quad, w: 100, h: 150, bad: true }));
  assert.match(bad, /stroke-dasharray="6 4"/);
});
