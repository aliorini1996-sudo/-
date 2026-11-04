/**
 * «التحرير الحرّ» — PrintCanvasSheet وسياق معاينة المصمّم (rep/printCanvas.tsx، rep/printDesignContext.ts).
 * اللوحة المحلولة تُبنى هنا يدوياً بشكل ResolvedCanvas (lib/print/layout.ts) فلا يتوقّف الاختبار على المحرّك.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintCanvasSheet, canvasBoxLook, canvasOverflowIds, canvasQrSidePx, physicalAlign } from './printCanvas';
import { PrintDesignPreviewContext, pdAttrs, pdProps, type PrintDesignPreview } from './printDesignContext';
import type { CanvasBandR, CanvasBoxR, ResolvedCanvas } from '../lib/print/layout';
import type { Align, CanvasBand, CanvasBoxId } from '../lib/print/printSettingsCore';

const MM = 96 / 25.4;
const px = (mm: number): number => Math.round(mm * MM * 100) / 100;

function box(id: CanvasBoxId, band: CanvasBand, x: number, y: number, w: number, h: number, align: Align = 'start', fontPct = 100): CanvasBoxR {
  return { id, band, x, y, w, h, align, fontPct, px: { left: px(x), top: px(y), width: px(w), height: px(h) } };
}
function bandR(band: CanvasBand, hMm: number, boxes: CanvasBoxR[]): CanvasBandR {
  return { band, hMm, hPx: px(hMm), boxes };
}
function canvasOf(header: CanvasBandR | null, footer: CanvasBandR | null): ResolvedCanvas {
  const placed = new Set<CanvasBoxId>([...(header?.boxes ?? []), ...(footer?.boxes ?? [])].map((b) => b.id));
  const hostOf = { logo: 'header', company: 'header', title: 'header', docInfo: 'info', customer: 'info', qr: 'totals', totals: 'totals', signatures: 'signatures', footer: 'footer' } as ResolvedCanvas['hostOf'];
  return { contentWmm: 188, header, footer, placed, hostOf };
}

const HEADER = bandR('header', 60, [
  box('logo', 'header', 150, 2, 36, 30, 'end'),
  box('company', 'header', 100, 0, 80, 20, 'start'),
  box('title', 'header', 60, 34, 70, 12, 'center'),
]);
const FOOTER = bandR('footer', 70, [
  box('qr', 'footer', 0, 0, 50, 50),
  box('totals', 'footer', 110, 0, 78, 40, 'start', 120),
  box('signatures', 'footer', 60, 52, 120, 15, 'end'),
]);
const CANVAS = canvasOf(HEADER, FOOTER);

const QR_SLOT = createElement('div', { 'data-qr-value': 'ZATCA-TLV', 'data-qr-ec': 'L' }, createElement('img', { alt: 'QR', src: 'data:QR' }));
const BLOCKS: Partial<Record<CanvasBoxId, ReactNode>> = {
  logo: createElement('img', { alt: 'logo', src: 'data:logo', style: { maxWidth: '100%', maxHeight: '100%' } }),
  company: createElement('b', null, 'شركة الاختبار'),
  title: createElement('h1', null, 'فاتورة ضريبية'),
  qr: QR_SLOT,
  totals: createElement('div', null, 'الإجمالي'),
  signatures: createElement('div', null, 'التوقيع'),
};
const FLOW = createElement('table', { 'data-flow': '' }, createElement('tbody', null, createElement('tr', null, createElement('td', null, 'صنف'))));

const render = (c: ResolvedCanvas, blocks = BLOCKS, ctx: PrintDesignPreview | null = null, dir?: 'rtl' | 'ltr'): string => {
  const el = createElement(PrintCanvasSheet, { canvas: c, blocks, flow: FLOW, dir });
  return renderToStaticMarkup(ctx ? createElement(PrintDesignPreviewContext.Provider, { value: ctx }, el) : el);
};

/** سمات style لمربعٍ معيّن (data-canvas-box) */
function boxTag(html: string, id: CanvasBoxId): string {
  const m = html.match(new RegExp(`<div data-canvas-box="${id}"[^>]*>`));
  assert.ok(m, `box ${id} rendered`);
  return m[0];
}

test('الورقة: لوحة الرأس ← السريان ← لوحة التذييل، بارتفاعٍ صريح وposition:relative وdata-copy-anchor على الرأس وحده', () => {
  const html = render(CANVAS);
  const iH = html.indexOf('data-section="canvas-header"');
  const iF = html.indexOf('data-flow');
  const iT = html.indexOf('data-section="canvas-footer"');
  assert.ok(iH >= 0 && iF > iH && iT > iF, 'header, flow, footer in order');
  assert.match(html, new RegExp(`<div data-section="canvas-header" data-copy-anchor="" style="position:relative;height:${px(60)}px;break-inside:avoid;page-break-inside:avoid"`));
  assert.match(html, new RegExp(`<div data-section="canvas-footer" style="position:relative;height:${px(70)}px;break-inside:avoid;page-break-inside:avoid"`));
  assert.equal(html.match(/data-copy-anchor/g)?.length, 1);
});

test('المربعات: absolute بإحداثيات مادية (left لا right) بالبكسل من اللوحة المحلولة — في RTL وLTR سواء', () => {
  for (const dir of ['rtl', 'ltr'] as const) {
    const html = render(CANVAS, BLOCKS, null, dir);
    const t = boxTag(html, 'company');
    assert.match(t, new RegExp(`position:absolute;left:${px(100)}px;top:0;width:${px(80)}px;height:${px(20)}px`));
    assert.doesNotMatch(t, /right:|inset/);
  }
});

test('المحاذاة: start = يمين الورقة في RTL، end = يسارها، وتنعكس في LTR', () => {
  assert.equal(physicalAlign('start'), 'right');
  assert.equal(physicalAlign('end'), 'left');
  assert.equal(physicalAlign('center'), 'center');
  assert.equal(physicalAlign(undefined), 'right');
  assert.equal(physicalAlign('start', 'ltr'), 'left');
  assert.equal(physicalAlign('end', 'ltr'), 'right');
  const rtl = render(CANVAS);
  assert.match(boxTag(rtl, 'company'), /text-align:right/);
  assert.match(boxTag(rtl, 'title'), /text-align:center/);
  assert.match(boxTag(rtl, 'signatures'), /text-align:left/);
  assert.match(boxTag(rtl, 'logo'), /justify-content:flex-start;direction:ltr/); // end ⇒ يسار الورقة
  assert.match(boxTag(render(CANVAS, BLOCKS, null, 'ltr'), 'company'), /text-align:left/);
});

test('مربعات النصّ تقصّ (overflow:hidden)، ومربع QR لا يُقصّ ويتوسّطه الرمز فوق كل نصّ، وسمات خانته محفوظة', () => {
  const html = render(CANVAS);
  for (const id of ['logo', 'company', 'title', 'totals', 'signatures'] as const) assert.match(boxTag(html, id), /overflow:hidden/);
  const q = boxTag(html, 'qr');
  assert.match(q, /overflow:visible;display:flex;align-items:center;justify-content:center;background:#fff;z-index:1/);
  assert.match(html, /<div data-canvas-box="qr"[^>]*><div data-qr-value="ZATCA-TLV" data-qr-ec="L"><img alt="QR" src="data:QR"\/><\/div><\/div>/);
  // يُرسم آخر لوحته
  const footer = html.slice(html.indexOf('canvas-footer'));
  assert.ok(footer.indexOf('data-canvas-box="qr"') > footer.indexOf('data-canvas-box="signatures"'));
});

test('لا وسم data-pd ولا معالج خارج المصمّم؛ وداخله على اللوحتين وكل مربع مع إبراز المحدَّد', () => {
  const plain = render(CANVAS);
  assert.doesNotMatch(plain, /data-pd/);
  const html = render(CANVAS, BLOCKS, { active: 'box:qr' });
  assert.match(html, /data-section="canvas-header" data-copy-anchor="" style="[^"]*" data-pd="band:header"/);
  assert.match(html, /data-section="canvas-footer" style="[^"]*" data-pd="band:footer"/);
  for (const b of [...HEADER.boxes, ...FOOTER.boxes]) assert.match(html, new RegExp(`data-canvas-box="${b.id}" style="[^"]*" data-pd="box:${b.id}"`));
  assert.equal(html.match(/data-pd-active/g)?.length, 1);
  assert.match(html, /data-pd="box:qr" data-pd-active=""/);
});

test('مربعٌ بلا كتلة: غائب في الطباعة، وإطارٌ فارغ قابل للتحديد في المصمّم', () => {
  const blocks = { ...BLOCKS };
  delete blocks.title;
  assert.doesNotMatch(render(CANVAS, blocks), /data-canvas-box="title"/);
  assert.match(render(CANVAS, blocks, { active: null }), /<div data-canvas-box="title" style="[^"]*" data-pd="box:title"><\/div>/);
});

test('بلا لوحتين: السريان وحده حرفياً؛ ولوحة رأسٍ بلا تذييل', () => {
  assert.equal(render(canvasOf(null, null)), renderToStaticMarkup(FLOW));
  const onlyHeader = render(canvasOf(HEADER, null));
  assert.match(onlyHeader, /canvas-header/);
  assert.doesNotMatch(onlyHeader, /canvas-footer/);
  assert.ok(onlyHeader.endsWith(renderToStaticMarkup(FLOW)));
});

test('لا zoom ولا filter ولا object-fit في الورقة (html2canvas 1.4.1)، والقيم غير المنتهية لا تصل إلى CSS', () => {
  const html = render(CANVAS, BLOCKS, { active: 'band:header' });
  assert.doesNotMatch(html, /zoom|filter|object-fit/);
  const bad = canvasOf(bandR('header', 40, [{ ...box('company', 'header', 0, 0, 20, 10), px: { left: NaN, top: Infinity, width: 50, height: -Infinity } }]), null);
  const t = boxTag(render(bad), 'company');
  assert.doesNotMatch(t, /NaN|Infinity/);
  assert.match(t, /left:0;top:0;width:50px;height:0/);
});

test('canvasQrSidePx = min(w,h) لمربع QR، وnull إن سرى QR مع الإجماليات', () => {
  assert.equal(canvasQrSidePx(CANVAS), px(50));
  assert.equal(canvasQrSidePx(canvasOf(bandR('header', 80, [box('qr', 'header', 0, 0, 60, 48)]), null)), px(48));
  assert.equal(canvasQrSidePx(canvasOf(HEADER, null)), null);
  assert.equal(canvasQrSidePx(null), null);
});

test('canvasBoxLook: خطّ المربع ومحاذاته لـfontPx، بلا مسافات', () => {
  assert.deepEqual(canvasBoxLook(FOOTER.boxes[1]), { visible: true, align: 'start', fontPct: 120, spaceBeforeMm: 0, spaceAfterMm: 0 });
  assert.equal(canvasBoxLook({ align: 'center', fontPct: NaN }).fontPct, 100);
});

test('canvasOverflowIds: مربعات النصّ الفائضة وحدها، وQR لا يُعدّ', () => {
  const el = (id: string, sh: number, ch: number, sw = 10, cw = 10) => ({ getAttribute: (n: string) => (n === 'data-canvas-box' ? id : null), scrollHeight: sh, clientHeight: ch, scrollWidth: sw, clientWidth: cw });
  const root = { querySelectorAll: (sel: string) => { assert.equal(sel, '[data-canvas-box]'); return [el('company', 40, 20), el('title', 20, 20), el('qr', 400, 100), el('footer', 10, 10, 90, 40), el('totals', 21, 20)]; } };
  assert.deepEqual(canvasOverflowIds(root), ['company', 'footer']);
});

test('pdAttrs/pdProps: {} بلا سياق؛ ومع السياق وسمٌ ونقرةٌ تختار ولا تصعد', () => {
  assert.deepEqual(pdAttrs(null, 'items'), {});
  assert.deepEqual(pdProps(null, 'logo'), {});
  assert.deepEqual(pdAttrs({ active: null }, 'items'), { 'data-pd': 'items' });
  assert.deepEqual(pdAttrs({ active: 'logo' }, 'logo'), { 'data-pd': 'logo', 'data-pd-active': '' });
  assert.deepEqual(pdProps({ active: null }, 'box:qr'), { 'data-pd': 'box:qr' });
  const picked: string[] = [];
  let stopped = 0;
  const props = pdProps({ active: null, onPick: (s) => picked.push(s) }, 'band:footer') as { onClick: (e: { stopPropagation(): void }) => void };
  props.onClick({ stopPropagation: () => { stopped++; } });
  assert.deepEqual(picked, ['band:footer']);
  assert.equal(stopped, 1);
});

test('المربّع الأصغر يُطبع فوق الأكبر المتداخل معه (الشعار على بيانات المستند لا تغطّيه خلفيتها) — كالمصمّم، وQR آخراً', () => {
  // الترتيب المعياري يضع الشعار قبل بيانات المستند، فكان يُرسم تحتها فتخفيه خلفيتها في الطباعة
  const header = bandR('header', 46, [box('logo', 'header', 40, 20, 20, 20), box('docInfo', 'header', 14, 14, 92, 30), box('qr', 'header', 150, 2, 40, 40)]);
  const html = render(canvasOf(header, null), { ...BLOCKS, docInfo: createElement('div', { style: { background: '#EEF4FB' } }, 'بيانات الفاتورة') });
  const at = (id: CanvasBoxId): number => html.indexOf(`data-canvas-box="${id}"`);
  assert.ok(at('logo') > 0 && at('docInfo') > 0 && at('qr') > 0, 'المربعات مرسومة');
  assert.ok(at('logo') > at('docInfo'), 'الأصغر بعد الأكبر في الرسم');
  assert.ok(at('qr') > at('logo'), 'QR آخر لوحته دائماً');
});
