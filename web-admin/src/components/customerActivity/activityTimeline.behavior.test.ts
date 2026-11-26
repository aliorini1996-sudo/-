/**
 * «سجلّ العميل» — اختبارات سلوكية بالتركيب الحقيقي (React 18 createRoot + act) على DOM مصغّر في الذاكرة (بلا jsdom):
 * تجري التأثيرات (useEffect) والنقرات فعلاً — لا رسماً ساكناً ولا تعابير نمطية وحدها.
 *
 *   • ActivityTimeline: الجلب الأول، تبديل القسم وسباق الردود، «تحميل المزيد» بالمؤشّر ودمجه بلا تكرار، الفشل ودون اتصال
 *     وإعادة المحاولة، السجلّ الفارغ، والقراءة وحدها.
 *   • RepCustomerTimeline (تطبيق المندوب): GET ‎/customers/:id/activity عبر repApi (محوّل axios بديل — لا شبكة)، رسالة «لا اتصال»
 *     وإعادة المحاولة داخل الورقة، خارج النطاق، والعميل المضاف دون اتصال.
 *   • CustomerStudioModal (أرشيف العميل في اللوحة): السجلّ الثابت افتراضياً، وتبويب «الصور والوثائق» ما زال يُرسم ويفتح الشبكة.
 *   • RepApp.tsx (ثابت): أيقونة «السجل الزمني» بجوار «تعديل» في بطاقة العميل وتفتح الورقة.
 *
 * الاختبارات التي تبدأ بـ«BUG» تكشف عيباً قائماً — تُترك فاشلةً دليلاً حتى يُصلح.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import * as React from 'react';
import type { ActivityPage } from '../../lib/customerActivity';

process.env.TZ = 'Asia/Riyadh';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

// ═══════════════════ DOM مصغّر يكفي react-dom ═══════════════════

const ELEM = 1, TEXT = 3, COMMENT = 8, DOC = 9;
const HTML_NS = 'http://www.w3.org/1999/xhtml';
/* eslint-disable @typescript-eslint/no-explicit-any */
class FNode {
  nodeType: number; nodeName: string; ownerDocument: any; parentNode: any = null; childNodes: any[] = []; nodeValue: string | null = null;
  constructor(t: number, n: string, d: any) { this.nodeType = t; this.nodeName = n; this.ownerDocument = d; }
  get firstChild(): any { return this.childNodes[0] ?? null; }
  get lastChild(): any { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): any { const s = this.parentNode?.childNodes as any[] | undefined; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  get parentElement(): any { return this.parentNode && this.parentNode.nodeType === ELEM ? this.parentNode : null; }
  appendChild(c: any) { c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c: any, ref: any) {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c;
  }
  removeChild(c: any) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  get textContent(): string { return this.nodeType === TEXT ? (this.nodeValue ?? '') : this.nodeType === COMMENT ? '' : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) {
    if (this.nodeType === TEXT || this.nodeType === COMMENT) { this.nodeValue = v; return; }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  /** نصّ عقدة النصّ (goober في react-hot-toast يكتب أنماطه فيه) */
  get data(): string { return this.nodeValue ?? ''; }
  set data(v: string) { this.nodeValue = v; }
  addEventListener() { /* الأحداث تُستدعى من خصائص React مباشرة */ }
  removeEventListener() { /* — */ }
  contains(n: any) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
}
class FElement extends FNode {
  tagName: string; namespaceURI: string; attrs = new Map<string, string>(); style: any; onclick: any = null;
  constructor(tag: string, d: any, ns = HTML_NS) {
    super(ELEM, tag.toUpperCase(), d);
    this.tagName = ns === HTML_NS ? tag.toUpperCase() : tag; this.namespaceURI = ns;
    const st: Record<string, unknown> = {};
    this.style = Object.assign(st, { setProperty: (k: string, v: string) => { st[k] = v; }, removeProperty: (k: string) => { delete st[k]; } });
  }
  setAttribute(n: string, v: unknown) { this.attrs.set(n, String(v)); }
  setAttributeNS(_ns: string, n: string, v: unknown) { this.attrs.set(n, String(v)); }
  getAttribute(n: string) { return this.attrs.has(n) ? this.attrs.get(n)! : null; }
  removeAttribute(n: string) { this.attrs.delete(n); }
  hasAttribute(n: string) { return this.attrs.has(n); }
  /** نصٌّ خام فقط (وسم <style> في goober) — لا تحليل HTML */
  get innerHTML(): string { return this.textContent; }
  set innerHTML(v: string) { this.textContent = v; }
  /** قيمة الخانة/الخيار: ما كُتب خاصيةً، وإلا السمة، وإلا نصّ الخيار (كالمتصفّح) */
  private _value: string | null = null;
  get value(): string { return this._value ?? this.getAttribute('value') ?? (this.tagName === 'OPTION' ? this.textContent : ''); }
  set value(v: string) { this._value = v == null ? '' : String(v); }
  /** خيارات <select> (وداخل <optgroup>) — يقرؤها react-dom لضبط المختار */
  get options(): any[] { return walk(this, (x) => x !== this && x.tagName === 'OPTION'); }
  focus() { /* — */ }
  blur() { /* — */ }
}
class FDocument extends FNode {
  documentElement: any; body: any; head: any; activeElement: any = null;
  constructor() {
    super(DOC, '#document', null);
    this.documentElement = new FElement('html', this); this.head = new FElement('head', this); this.body = new FElement('body', this);
    this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body); this.appendChild(this.documentElement);
  }
  createElement(t: string) { return new FElement(t, this); }
  createElementNS(ns: string, t: string) { return new FElement(t, this, ns); }
  createTextNode(s: string) { const n = new FNode(TEXT, '#text', this); n.nodeValue = s; return n; }
  createComment(s: string) { const n = new FNode(COMMENT, '#comment', this); n.nodeValue = s; return n; }
}

const doc = new FDocument();
const g = globalThis as any;
const storage = new Map<string, string>();
g.window = g;
g.document = doc;
g.HTMLIFrameElement = class {};
g.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); }, clear: () => storage.clear(), key: () => null, get length() { return storage.size; },
};
g.sessionStorage = g.localStorage;
g.location = { pathname: '/app', search: '', hash: '', href: 'http://localhost/app', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
g.addEventListener = () => {}; g.removeEventListener = () => {};
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0); g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
g.IS_REACT_ACT_ENVIRONMENT = true;
let online = true;
try {
  Object.defineProperty(g.navigator, 'onLine', { configurable: true, get: () => online });
} catch {
  Object.defineProperty(g, 'navigator', { configurable: true, value: { userAgent: 'node', language: 'ar', get onLine() { return online; } } });
}

// import.meta.env (Vite) غير موجود في Node — كاختبار رأس «أرشيف العميل» (pages/customerNumberDesktop.test.ts)
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (url.includes('/web-admin/src/') && r.source != null) {
    const src = String(r.source);
    if (src.includes('import.meta.env')) return { ...r, source: src.replace(/import\\.meta\\.env/g, '({})') };
  }
  return r;
}`)}`);

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
/** يفرغ الوعود والمؤقّتات الصفرية داخل act (محوّل axios ومعترضاته سلسلة وعود) */
const settle = async () => { await act(async () => { for (let i = 0; i < 8; i++) await tick(); }); };

let reactDom: { createRoot: (c: any) => { render(el: unknown): void; unmount(): void } } | null = null;
async function mount(el: React.ReactElement) {
  reactDom ??= (await import('react-dom/client')) as any;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = reactDom!.createRoot(container);
  try {
    await act(async () => { root.render(el); await tick(); });
  } catch (e) {
    // تركيبٌ فاشل لا يُبقي جذراً حيّاً (ومؤقّتاته) بعد الاختبار
    await act(async () => { root.unmount(); }).catch(() => undefined);
    throw e;
  }
  return {
    container,
    rerender: async (next: React.ReactElement) => { await act(async () => { root.render(next); await tick(); }); },
    unmount: async () => { await act(async () => { root.unmount(); }); container.parentNode?.removeChild(container); },
  };
}
const walk = (n: any, pred: (x: any) => boolean, out: any[] = []): any[] => {
  if (pred(n)) out.push(n);
  for (const c of n.childNodes ?? []) walk(c, pred, out);
  return out;
};
const buttons = (root: any) => walk(root, (x) => x.tagName === 'BUTTON');
const button = (root: any, label: string) => {
  const b = buttons(root).find((x) => x.textContent.trim() === label) ?? buttons(root).find((x) => x.getAttribute('aria-label') === label)
    ?? buttons(root).find((x) => x.textContent.includes(label));
  assert.ok(b, `لا زرّ «${label}» — الأزرار: ${buttons(root).map((x) => x.textContent.trim() || x.getAttribute('aria-label')).join(' | ')}`);
  return b;
};
/** بطاقات البنود: <li> أبناء <ol> في ActivityList */
const cards = (root: any) => walk(root, (x) => x.tagName === 'LI' && x.parentNode?.tagName === 'OL');
const propsOf = (el: any) => el[Object.keys(el).find((k) => k.startsWith('__reactProps$'))!];
async function click(el: any) {
  await act(async () => {
    propsOf(el).onClick?.({ preventDefault() {}, stopPropagation() {}, currentTarget: el, target: el });
    await tick();
  });
}
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const it = (id: string, at: string, action = 'VISIT_RECORDED', extra: Record<string, unknown> = {}) =>
  ({ id, at, action, actor: { kind: 'REP', name: 'أحمد' }, refType: null, refId: null, refNo: null, amount: null, data: null, historical: false, ...extra });

async function timeline() {
  return (await import('./ActivityTimeline')).default;
}

// ═══════════════════ ActivityTimeline ═══════════════════

test('الجلب الأول: طلبٌ واحد بلا مؤشّر ولا قسم، هيكل التحميل ثم البنود مجمّعة بأيامها وسطر القفل', async () => {
  const ActivityTimeline = await timeline();
  const calls: unknown[][] = [];
  const d = deferred<ActivityPage>();
  const v = await mount(h(ActivityTimeline, { fetchPage: (b?: string, c?: string) => { calls.push([b, c]); return d.promise; }, accountingOn: true }));
  assert.deepEqual(calls, [[undefined, undefined]]);
  assert.equal(walk(v.container, (x) => x.getAttribute?.('aria-busy') === 'true').length, 1, 'هيكل التحميل');
  assert.ok(v.container.textContent.includes('سجل ثابت لا يمكن تعديله أو حذفه'));
  await act(async () => {
    d.resolve({ items: [it('a', '2026-03-01T09:00:00Z'), it('b', '2026-02-28T09:00:00Z', 'INVOICE_ISSUED', { amount: 115, refNo: 'INV-1' })] as never, nextBefore: null });
    await tick();
  });
  assert.equal(cards(v.container).length, 2);
  assert.equal(walk(v.container, (x) => x.tagName === 'SECTION').length, 2, 'مجموعة لكل يوم');
  assert.equal(calls.length, 1, 'جلبٌ مكرّر');
  assert.ok(!v.container.textContent.includes('تحميل المزيد'), 'زرّ «تحميل المزيد» بلا صفحةٍ تالية');
  await v.unmount();
});

test('زرّ القسم: يطلب القسم بلا مؤشّر، ويُعلَّم مختاراً، وردٌّ متأخّر للقسم السابق لا يكتب فوق القسم الحاليّ', async () => {
  const ActivityTimeline = await timeline();
  const pending = new Map<string, ReturnType<typeof deferred<ActivityPage>>>();
  const calls: unknown[][] = [];
  const fetchPage = (b?: string, c?: string) => { calls.push([b, c]); const d = deferred<ActivityPage>(); pending.set(c ?? 'all', d); return d.promise; };
  const v = await mount(h(ActivityTimeline, { fetchPage, accountingOn: true }));
  await click(button(v.container, 'التحصيل والمدفوعات'));
  assert.deepEqual(calls, [[undefined, undefined], [undefined, 'money']]);
  const tab = button(v.container, 'التحصيل والمدفوعات');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.equal(button(v.container, 'الكل').getAttribute('aria-selected'), 'false');
  await act(async () => { pending.get('money')!.resolve({ items: [it('m1', '2026-03-01T08:00:00Z', 'RECEIPT_ISSUED', { refNo: 'RC-MONEY' })] as never, nextBefore: null }); await tick(); });
  // ردّ «الكل» يصل متأخّراً — بنوده لا تظهر في قسم التحصيل
  await act(async () => { pending.get('all')!.resolve({ items: [it('x1', '2026-03-01T10:00:00Z', 'VISIT_RECORDED', { refNo: 'STALE' })] as never, nextBefore: 'SHOULD-NOT-SHOW' }); await tick(); });
  assert.ok(v.container.textContent.includes('RC-MONEY'));
  assert.ok(!v.container.textContent.includes('STALE'), 'ردٌّ متأخّر لقسمٍ سابق كتب فوق القسم الحاليّ');
  assert.ok(!v.container.textContent.includes('تحميل المزيد'), 'مؤشّرٌ متأخّر من قسمٍ سابق');
  // العودة إلى «الكل» جلبٌ جديد لا الردّ القديم
  await click(button(v.container, 'الكل'));
  assert.deepEqual(calls[2], [undefined, undefined]);
  await v.unmount();
});

test('«تحميل المزيد»: بمؤشّر الخادم وقسمه، النقر أثناء التحميل لا يكرّر الطلب، الدمج بلا تكرار، والزرّ يختفي بنهاية الصفحات', async () => {
  const ActivityTimeline = await timeline();
  const calls: unknown[][] = [];
  const more = deferred<ActivityPage>();
  const fetchPage = (b?: string, c?: string) => {
    calls.push([b, c]);
    if (!b) return Promise.resolve({ items: [it('a', '2026-03-01T10:00:00Z'), it('b', '2026-03-01T09:00:00Z')], nextBefore: '2026-03-01T09:00:00.000Z~100~b' } as never);
    return more.promise;
  };
  const v = await mount(h(ActivityTimeline, { fetchPage, accountingOn: true }));
  await click(button(v.container, 'الزيارات'));
  assert.equal(cards(v.container).length, 2);
  await click(button(v.container, 'تحميل المزيد'));
  assert.deepEqual(calls[calls.length - 1], ['2026-03-01T09:00:00.000Z~100~b', 'visits'], 'المؤشّر أو القسم لم يُمرَّر');
  const n = calls.length;
  await click(button(v.container, 'تحميل المزيد'));
  assert.equal(calls.length, n, 'نقرةٌ ثانية أثناء التحميل كرّرت الطلب');
  // الصفحة التالية تعيد بند الحدّ (b) — لا يتكرّر
  await act(async () => { more.resolve({ items: [it('b', '2026-03-01T09:00:00Z'), it('c', '2026-02-27T09:00:00Z')], nextBefore: null } as never); await tick(); });
  assert.equal(cards(v.container).length, 3, 'بندٌ مكرّر بعد الدمج');
  assert.ok(!v.container.textContent.includes('تحميل المزيد'), 'الزرّ باقٍ بعد آخر صفحة');
  await v.unmount();
});

test('فشل «تحميل المزيد»: يبقى ما عُرض، والزرّ «تعذر التحميل أعد المحاولة»، والنقر يعيد الطلب نفسه وينجح', async () => {
  const ActivityTimeline = await timeline();
  const calls: unknown[][] = [];
  let failNext = true;
  const fetchPage = async (b?: string, c?: string) => {
    calls.push([b, c]);
    if (!b) return { items: [it('a', '2026-03-01T10:00:00Z')], nextBefore: 'CUR' } as never;
    if (failNext) { failNext = false; throw new Error('Network Error'); }
    return { items: [it('z', '2026-02-01T10:00:00Z')], nextBefore: null } as never;
  };
  const v = await mount(h(ActivityTimeline, { fetchPage, accountingOn: true }));
  await click(button(v.container, 'تحميل المزيد'));
  assert.equal(cards(v.container).length, 1, 'ما عُرض اختفى بالفشل');
  await click(button(v.container, 'تعذر التحميل أعد المحاولة'));
  assert.deepEqual(calls.slice(1), [['CUR', undefined], ['CUR', undefined]]);
  assert.equal(cards(v.container).length, 2);
  await v.unmount();
});

test('فشل الصفحة الأولى: «تعذر تحميل سجل العميل» متصلاً، و«لا يتوفر سجل العميل دون اتصال بالإنترنت» دون اتصال — و«إعادة المحاولة» يعيد الجلب', async () => {
  const ActivityTimeline = await timeline();
  let attempts = 0;
  const fetchPage = async () => { attempts++; if (attempts <= 2) throw new Error('boom'); return { items: [it('ok', '2026-03-01T10:00:00Z')], nextBefore: null } as never; };
  const v = await mount(h(ActivityTimeline, { fetchPage, accountingOn: true }));
  assert.ok(v.container.textContent.includes('تعذر تحميل سجل العميل'));
  online = false;
  try {
    await click(button(v.container, 'إعادة المحاولة'));
    assert.equal(attempts, 2);
    assert.ok(v.container.textContent.includes('لا يتوفر سجل العميل دون اتصال بالإنترنت'), v.container.textContent);
  } finally { online = true; }
  await click(button(v.container, 'إعادة المحاولة'));
  assert.equal(attempts, 3);
  assert.equal(cards(v.container).length, 1);
  // الأقسام ما زالت تعمل بعد الاستعادة، وسطر القفل باقٍ في كل حال
  assert.ok(v.container.textContent.includes('سجل ثابت لا يمكن تعديله أو حذفه'));
  await v.unmount();
});

test('السجلّ الفارغ: «لا يوجد شيء في سجل هذا العميل بعد»، والقسم الفارغ: «لا يوجد شيء في هذا القسم»', async () => {
  const ActivityTimeline = await timeline();
  const v = await mount(h(ActivityTimeline, { fetchPage: async () => ({ items: [], nextBefore: null }), accountingOn: true }));
  assert.ok(v.container.textContent.includes('لا يوجد شيء في سجل هذا العميل بعد'));
  await click(button(v.container, 'الوثائق'));
  assert.ok(v.container.textContent.includes('لا يوجد شيء في هذا القسم'));
  await v.unmount();
});

test('«تحميل المزيد» من قسمٍ سابق يصل بعد تبديل القسم: يُهمَل فلا يختلط بقسمٍ آخر', async () => {
  const ActivityTimeline = await timeline();
  const more = deferred<ActivityPage>();
  const fetchPage = (b?: string, c?: string) => {
    if (b) return more.promise;
    if (c === 'docs') return Promise.resolve({ items: [it('d1', '2026-03-01T08:00:00Z', 'DOCUMENT_ADDED', { refNo: 'DOC-ONLY' })], nextBefore: null } as never);
    return Promise.resolve({ items: [it('a', '2026-03-01T10:00:00Z')], nextBefore: 'CUR' } as never);
  };
  const v = await mount(h(ActivityTimeline, { fetchPage, accountingOn: true }));
  await click(button(v.container, 'تحميل المزيد'));
  await click(button(v.container, 'الوثائق'));
  await act(async () => { more.resolve({ items: [it('late', '2026-02-01T10:00:00Z', 'INVOICE_ISSUED', { refNo: 'LATE-PAGE' })], nextBefore: 'CUR2' } as never); await tick(); });
  assert.ok(v.container.textContent.includes('DOC-ONLY'));
  assert.ok(!v.container.textContent.includes('LATE-PAGE'), 'صفحةٌ متأخّرة من «الكل» ظهرت في «الوثائق»');
  assert.equal(cards(v.container).length, 1);
  await v.unmount();
});

test('للقراءة وحدها في الـDOM الحيّ: لا خانة إدخال، والأزرار أقسامٌ و«تحميل المزيد» وحدها — بنودٌ من كل إجراء', async () => {
  const ActivityTimeline = await timeline();
  const { CUSTOMER_ACTIONS } = await import('../../lib/customerActivity');
  const items = CUSTOMER_ACTIONS.map((a, i) => it(`i${i}`, new Date(Date.UTC(2026, 2, 1) - i * 3_600_000).toISOString(), a, {
    amount: 10 + i, refNo: `R-${i}`, data: { note: 'ملاحظة', changes: [{ field: 'city', from: 'أ', to: 'ب' }], items: [{ productName: 'صنف', qty: 1 }] },
  }));
  const v = await mount(h(ActivityTimeline, { fetchPage: async () => ({ items, nextBefore: 'CUR' }) as never, accountingOn: true }));
  assert.equal(cards(v.container).length, CUSTOMER_ACTIONS.length);
  assert.equal(walk(v.container, (x) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(x.tagName) || x.getAttribute?.('contenteditable') != null).length, 0);
  const labels = buttons(v.container).map((b) => b.textContent.trim());
  assert.deepEqual(labels, ['الكل', 'الزيارات', 'المبيعات', 'المرتجعات', 'التحصيل والمدفوعات', 'الوثائق', 'بيانات العميل', 'أخرى', 'تحميل المزيد']);
  for (const card of cards(v.container)) {
    const handlers = walk(card, (x) => x.nodeType === ELEM).filter((x) => { const p = propsOf(x); return p && Object.keys(p).some((k) => /^on[A-Z]/.test(k)); });
    assert.equal(handlers.length, 0, 'بطاقة بندٍ تحمل معالج حدث');
  }
  await v.unmount();
});

test('النظام المحاسبي مطفأ في الـDOM الحيّ: لا رمز عملةٍ ولا مبلغ في أي بطاقة', async () => {
  const ActivityTimeline = await timeline();
  const items = [
    it('i', '2026-03-01T10:00:00Z', 'INVOICE_ISSUED', { amount: 4321.75, data: { taxTotal: 563.71, discount: 98.65 } }),
    it('r', '2026-03-01T09:00:00Z', 'RECEIPT_ISSUED', { amount: 2468.13, data: { allocations: [{ invoiceNo: 'INV-1', amount: 1357.91, settled: true }] } }),
    it('p', '2026-03-01T08:00:00Z', 'CUSTOMER_PRICE_SET', { data: { items: [{ productName: 'شاي', from: 3.17, to: 3.29 }] } }),
  ];
  const v = await mount(h(ActivityTimeline, { fetchPage: async () => ({ items, nextBefore: null }) as never, accountingOn: false }));
  const text = v.container.textContent;
  assert.ok(text.includes('إصدار فاتورة بيع') && text.includes('INV-1') && text.includes('شاي'));
  assert.ok(!text.includes('ر.س'), 'رمز العملة ظاهر');
  for (const n of ['4321', '٤٬٣٢١', '563', '٥٦٣', '2468', '٢٬٤٦٨', '1357', '١٬٣٥٧', '٣٫١٧', '٣٫٢٩', '3.17']) assert.ok(!text.includes(n), `${n} ظاهر`);
  await v.unmount();
});

// ═══════════════════ RepCustomerTimeline (تطبيق المندوب) ═══════════════════

type Req = { url: string; method: string; params: unknown; auth: unknown };
async function repEnv() {
  const { default: repApi } = await import('../../rep/repApi');
  const { default: RepCustomerTimeline } = await import('../../rep/RepCustomerTimeline');
  const reqs: Req[] = [];
  let reply: (cfg: any) => Promise<any> = async () => ({ items: [], nextBefore: null });
  (repApi.defaults as any).adapter = async (cfg: any) => {
    reqs.push({ url: cfg.url, method: cfg.method, params: cfg.params, auth: cfg.headers?.Authorization ?? cfg.headers?.get?.('Authorization') });
    const out = await reply(cfg);
    return { data: { success: true, data: out }, status: 200, statusText: 'OK', headers: {}, config: cfg, request: {} };
  };
  const httpError = (cfg: any, status: number) => Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true, config: cfg, response: { status, data: { success: false }, headers: {}, config: cfg },
  });
  const netError = (cfg: any) => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK', config: cfg });
  return { RepCustomerTimeline, reqs, setReply: (f: typeof reply) => { reply = f; }, httpError, netError };
}

test('ورقة المندوب: GET واحد إلى ‎/customers/:id/activity عبر repApi بجلسة المندوب، والصفحة الأولى تُسلَّم للقائمة بلا طلبٍ ثانٍ', async () => {
  const env = await repEnv();
  storage.set('rep_token', 'rep-test-token');
  env.setReply(async () => ({ items: [it('a', '2026-03-01T10:00:00Z', 'INVOICE_ISSUED', { refNo: 'INV-77', amount: 50 })], nextBefore: 'CUR-1' }));
  const v = await mount(h(env.RepCustomerTimeline, { customer: { id: 'c9', name: 'بقالة الحي', number: 4 }, accountingOn: true, onClose: () => {} }));
  await settle();
  assert.deepEqual(env.reqs.map((r) => [r.method, r.url, r.params]), [['get', '/customers/c9/activity', {}]], 'طلبٌ غير متوقّع أو مكرّر');
  assert.equal(env.reqs[0].auth, 'Bearer rep-test-token', 'الطلب بلا جلسة المندوب');
  const text = v.container.textContent;
  assert.ok(text.includes('السجل الزمني') && text.includes('بقالة الحي') && text.includes('#4'), text);
  assert.ok(text.includes('INV-77'));
  // «تحميل المزيد» ثم قسم: GET بالمعاملات نفسها التي يفهمها الخادم
  env.setReply(async () => ({ items: [it('b', '2026-02-01T10:00:00Z')], nextBefore: null }));
  await click(button(v.container, 'تحميل المزيد'));
  await settle();
  await click(button(v.container, 'المرتجعات'));
  await settle();
  assert.deepEqual(env.reqs.slice(1).map((r) => [r.method, r.url, r.params]), [
    ['get', '/customers/c9/activity', { before: 'CUR-1' }],
    ['get', '/customers/c9/activity', { category: 'returns' }],
  ]);
  assert.ok(env.reqs.every((r) => r.method === 'get'), 'طلب كتابةٍ من ورقة السجلّ');
  await v.unmount();
  storage.delete('rep_token');
});

test('ورقة المندوب دون اتصال: رسالة «لا يوجد اتصال بالإنترنت» وزرّ «اعد المحاولة» داخل الورقة — والإعادة تعرض السجلّ بطلبٍ واحد إضافي', async () => {
  const env = await repEnv();
  let fail = true;
  env.setReply(async (cfg) => { if (fail) throw env.netError(cfg); return { items: [it('a', '2026-03-01T10:00:00Z', 'VISIT_RECORDED', { refNo: 'BACK-ONLINE' })], nextBefore: null }; });
  let closed = 0;
  const v = await mount(h(env.RepCustomerTimeline, { customer: { id: 'c9', name: 'بقالة الحي' }, accountingOn: true, onClose: () => { closed++; } }));
  await settle();
  const text = v.container.textContent;
  assert.ok(text.includes('لا يوجد اتصال بالإنترنت'), text);
  assert.ok(text.includes('بقية التطبيق تعمل كالمعتاد'));
  assert.equal(walk(v.container, (x) => x.getAttribute?.('role') === 'status').length, 1);
  fail = false;
  await click(button(v.container, 'اعد المحاولة'));
  await settle();
  assert.ok(v.container.textContent.includes('BACK-ONLINE'));
  assert.equal(env.reqs.length, 2, `عدد الطلبات ${env.reqs.length}: الصفحة الأولى طُلبت مرّتين بعد الإعادة`);
  // الرجوع يغلق الورقة وحدها
  await click(button(v.container, 'رجوع'));
  assert.equal(closed, 1);
  await v.unmount();
});

test('ورقة المندوب دون اتصال لمندوبٍ مقيَّد بـ«اشتراط تفعيل الموقع»: القراءة لا يحرسها القفل — الرسالة «لا اتصال» لا «خارج النطاق»', async () => {
  const env = await repEnv();
  storage.set('rep_token', 'rep-test-token');
  storage.set('rep_user', JSON.stringify({ id: 'r1', requireLocationOn: true }));
  try {
    env.setReply(async (cfg) => { throw env.netError(cfg); });
    const v = await mount(h(env.RepCustomerTimeline, { customer: { id: 'c9', name: 'x' }, accountingOn: true, onClose: () => {} }));
    await settle();
    assert.equal(env.reqs.length, 1, 'القفل منع طلب القراءة أو كرّره');
    assert.ok(v.container.textContent.includes('لا يوجد اتصال بالإنترنت'), v.container.textContent);
    await v.unmount();
  } finally {
    storage.delete('rep_user');
    storage.delete('rep_token');
  }
});

test('ورقة المندوب: 404/403 «لا يمكنك عرض سجل هذا العميل»، و500 «تعذر تحميل السجل الزمني» — وكلاهما بإعادة محاولة', async () => {
  for (const [status, msg] of [[404, 'لا يمكنك عرض سجل هذا العميل'], [403, 'لا يمكنك عرض سجل هذا العميل'], [500, 'تعذر تحميل السجل الزمني']] as const) {
    const env = await repEnv();
    env.setReply(async (cfg) => { throw env.httpError(cfg, status); });
    const v = await mount(h(env.RepCustomerTimeline, { customer: { id: 'c9', name: 'x' }, accountingOn: true, onClose: () => {} }));
    await settle();
    assert.ok(v.container.textContent.includes(msg), `${status}: ${v.container.textContent}`);
    assert.ok(button(v.container, 'اعد المحاولة'));
    await v.unmount();
  }
});

test('ورقة المندوب: فشل تبديل القسم دون اتصال يُعرض داخل القائمة «لا يتوفر سجل العميل دون اتصال بالإنترنت» وما فوقه باقٍ', async () => {
  const env = await repEnv();
  env.setReply(async () => ({ items: [it('a', '2026-03-01T10:00:00Z')], nextBefore: null }));
  const v = await mount(h(env.RepCustomerTimeline, { customer: { id: 'c9', name: 'x' }, accountingOn: true, onClose: () => {} }));
  await settle();
  env.setReply(async (cfg) => { throw env.netError(cfg); });
  online = false;
  try {
    await click(button(v.container, 'المبيعات'));
    await settle();
    const text = v.container.textContent;
    assert.ok(text.includes('لا يتوفر سجل العميل دون اتصال بالإنترنت'), text);
    assert.ok(text.includes('السجل الزمني') && text.includes('سجل ثابت لا يمكن تعديله أو حذفه'), 'الورقة نفسها سقطت');
  } finally { online = true; }
  await v.unmount();
});

test('العميل المضاف دون اتصال (local-… أو _offline): لا طلب إطلاقاً، ورسالة «هذا العميل لم يرفع إلى الخادم بعد»', async () => {
  for (const customer of [{ id: 'local-123', name: 'جديد' }, { id: 'c-tmp', name: 'جديد', _offline: true }, { id: '', name: 'بلا معرّف' }]) {
    const env = await repEnv();
    const v = await mount(h(env.RepCustomerTimeline, { customer, accountingOn: true, onClose: () => {} }));
    await settle();
    assert.equal(env.reqs.length, 0, `${customer.id}: طُلب سجلّ عميلٍ لم يُرفع`);
    assert.ok(v.container.textContent.includes('هذا العميل لم يرفع إلى الخادم بعد'));
    await v.unmount();
  }
});

// ═══════════════════ CustomerStudioModal (أرشيف العميل في اللوحة) ═══════════════════

test('أرشيف العميل: «السجل الزمني» افتراضياً يقرأ ‎/customers/:id/activity، وتبويب «الصور والوثائق» يُرسم ويفتح الشبكة ثم يعود', async () => {
  storage.set('user', JSON.stringify({ id: 'u1', role: 'ADMIN', canDelete: true }));
  const { default: api } = await import('../../api/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { default: CustomerStudioModal } = await import('../CustomerStudioModal');
  const reqs: { method: string; url: string; params: unknown }[] = [];
  (api.defaults as any).adapter = async (cfg: any) => {
    reqs.push({ method: cfg.method, url: cfg.url, params: cfg.params });
    let data: unknown = null;
    if (cfg.url === '/company') data = { accountingEnabled: true };
    else if (cfg.url === '/customers/c1/studio') {
      data = { customer: { id: 'c1', name: 'بقالة النور', businessName: null }, items: [], visits: [], receiptsHidden: false,
        truncated: { visit: false, receipt: false }, limits: { perRequest: 10, perCustomer: 50, docCount: 0 } };
    } else if (cfg.url === '/customers/c1/activity') {
      data = { items: [it('a', '2026-03-01T10:00:00Z', 'RECEIPT_ISSUED', { refNo: 'RC-STUDIO', amount: 75 })], nextBefore: null };
    }
    return { data: { success: true, data }, status: 200, statusText: 'OK', headers: {}, config: cfg, request: {} };
  };
  // gcTime: 0 — لا مؤقّت جمعٍ لخمس دقائق يُبقي العملية حيّة بعد الاختبار
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const v = await mount(h(QueryClientProvider, { client: qc }, h(CustomerStudioModal, { customer: { id: 'c1', name: 'بقالة النور', number: 7 }, onClose: () => {} })));
  try {
  await settle();
  const activityReqs = reqs.filter((r) => r.url === '/customers/c1/activity');
  assert.deepEqual(activityReqs.map((r) => [r.method, r.params]), [['get', {}]]);
  let text = v.container.textContent;
  assert.ok(text.includes('سجل ثابت لا يمكن تعديله أو حذفه') && text.includes('RC-STUDIO'), 'السجلّ الثابت ليس العرض الافتراضي');
  assert.ok(text.includes('أين توقفنا مع العميل'), '«أين توقفنا» غاب');
  const gallery = button(v.container, 'الصور والوثائق');
  assert.ok(gallery.textContent.includes('(0)'), 'عدّاد الصور على التبويب');
  await click(gallery);
  await settle();
  text = v.container.textContent;
  assert.ok(text.includes('لا توجد صور أو وثائق لهذا العميل بعد'), text);
  for (const tab of ['الكل', 'الوثائق', 'صور الزيارات', 'مرفقات السندات']) assert.ok(button(v.container, tab), tab);
  assert.ok(!text.includes('سجل ثابت لا يمكن تعديله أو حذفه'), 'السجلّ ما زال ظاهراً في تبويب الصور');
  // الرفع في تبويب الصور (خانة الملف) — والسجلّ نفسه بلا خانة
  assert.ok(walk(v.container, (x) => x.tagName === 'INPUT' && x.getAttribute('type') === 'file').length >= 1);
  await click(button(v.container, 'السجل الزمني'));
  await settle();
  assert.ok(v.container.textContent.includes('RC-STUDIO'));
  assert.ok(reqs.every((r) => r.url !== '/customers/c1/activity' || r.method === 'get'), 'طلب كتابةٍ على السجلّ');
  } finally {
    await v.unmount();
    qc.clear();
  }
});

// ═══════════════════ RepApp.tsx: الأيقونة بجوار «تعديل» (ثابت) ═══════════════════

/** نهاية وسم JSX الفاتح من «<» — بتخطّي ما بين الأقواس والنصوص (onClick={() => …} فيه «>») — وهل هو مغلقٌ بنفسه */
function tagEnd(src: string, i: number): { end: number; selfClosing: boolean } {
  let depth = 0;
  let q: string | null = null;
  for (let k = i + 1; k < src.length; k++) {
    const ch = src[k];
    if (q) { if (ch === q && src[k - 1] !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return { end: k + 1, selfClosing: src[k - 1] === '/' };
  }
  throw new Error('وسمٌ بلا نهاية');
}
/** عنصر JSX من موضعه حتى وسم إغلاقه المطابق (عدّ <div> المتداخلة، والمغلق بنفسه لا يُعدّ) */
function elementAt(src: string, at: number, tag = 'div'): string {
  const open = new RegExp(`<${tag}[\\s>]`, 'g');
  const close = new RegExp(`</${tag}>`, 'g');
  let depth = 0;
  let i = at;
  for (;;) {
    open.lastIndex = i; close.lastIndex = i;
    const o = open.exec(src); const c = close.exec(src);
    assert.ok(c, 'وسمٌ بلا إغلاق');
    if (o && o.index < c!.index) {
      const t = tagEnd(src, o.index);
      if (!t.selfClosing) depth++;
      i = t.end;
      if (depth === 0) return src.slice(at, i);
      continue;
    }
    depth--; i = c!.index + c![0].length;
    if (depth === 0) return src.slice(at, i);
  }
}

test('RepApp: أيقونة «السجل الزمني» (History) في بطاقة العميل بجوار «تعديل» — في حاويتهما نفسها، قبله، وخارج شرط canEdit — وتفتح الورقة', () => {
  const app = read('rep', 'RepApp.tsx');
  assert.match(app, /^import \{[^}]*\bHistory\b[^}]*\} from 'lucide-react';$/m, 'History غير مستوردة من lucide-react');
  assert.equal([...app.matchAll(/\b(?:const|let|function|class)\s+History\b|import\s+History\b|\bas\s+History\b/g)].length, 0, 'History مُعرّفة بغير الأيقونة');
  assert.ok(app.includes("import RepCustomerTimeline from './RepCustomerTimeline';"));
  const start = app.indexOf('function CustomerDetail(');
  const fn = app.slice(start, app.indexOf('\nfunction ', start + 10));
  // البطاقة: الاسم ثم حاوية الأزرار في صفّها نفسه
  const nameAt = fn.indexOf('<p className="font-bold text-lg">{customer.name}</p>');
  assert.ok(nameAt > 0, 'اسم العميل في البطاقة');
  const rowAt = fn.lastIndexOf('<div className={`flex items-start justify-between gap-3', nameAt);
  assert.ok(rowAt > 0, 'صفّ البطاقة (الاسم وحاوية الأزرار)');
  const row = elementAt(fn, rowAt);
  assert.ok(row.includes('{customer.name}'), 'صفّ البطاقة');
  const groupAt = row.indexOf('<div className="flex-shrink-0 flex items-center gap-2">');
  assert.ok(groupAt > row.indexOf('{customer.name}'), 'حاوية الأزرار بعد الاسم في الصفّ نفسه');
  const group = elementAt(row, groupAt);
  const btns = [...group.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
  assert.equal(btns.length, 2, `الحاوية تجمع زرّين بالضبط (وجدت ${btns.length})`);
  assert.ok(btns[0].includes('<History size={15} />') && btns[0].includes('onClick={() => setTimelineOpen(true)}'), 'الأول ليس أيقونة السجلّ');
  assert.ok(btns[0].includes('type="button"') && btns[0].includes("aria-label={tr('السجل الزمني')}"), 'الأيقونة بلا type أو اسمٍ لقارئ الشاشة');
  assert.ok(btns[1].includes("{tr('تعديل')}") && btns[1].includes('onClick={onEdit}'), 'الثاني ليس «تعديل»');
  const beforeIcon = group.slice(0, group.indexOf(btns[0]));
  assert.doesNotMatch(beforeIcon, /\{[^}]*&&\s*\($/, 'الأيقونة داخل شرط');
  assert.ok(group.indexOf('{canEdit && (') > group.indexOf(btns[0]), '«تعديل» وحده تحت canEdit');
  // نقطة فتحٍ واحدة، والورقة بعلمي المحاسبة والضريبة وصلاحية كشف الحساب (C3)، والرجوع يغلقها بدالّةٍ ثابتة (C23: الورقة محفوظة)
  assert.equal([...fn.matchAll(/setTimelineOpen\(true\)/g)].length, 1);
  assert.ok(fn.includes('const closeTimeline = useCallback(() => setTimelineOpen(false), []);'));
  assert.ok(fn.includes('{timelineOpen && <RepCustomerTimeline customer={customer} accountingOn={accountingOn} canViewStatement={canViewStatement} taxOff={isTaxOff(company)} onClose={closeTimeline} />}'));
  assert.ok(fn.includes('useBackClose(timelineOpen, () => setTimelineOpen(false));'));
  // الورقة مطلقة الموضع فوق الملفّ: داخل جذر CustomerDetail لا داخل حاوية التمرير
  const rootAt = fn.indexOf('<div className="h-full flex flex-col bg-gray-50">');
  const scrollAt = fn.indexOf('overflow-y-auto', rootAt);
  const sheetAt = fn.indexOf('{timelineOpen && <RepCustomerTimeline');
  assert.ok(rootAt > 0 && sheetAt > rootAt && sheetAt < scrollAt, 'الورقة خارج جذر الملفّ أو داخل حاوية التمرير');
});
