// جسر الطباعة إلى تطبيق فيلد سيلز على الآيفون: المصافحة والربط والإرسال بحمولة FSP v1 خاماً بسقف الآيفون، والتقدّم لهذه المهمة
// وحدها، والإلغاء رسالةٌ واحدة، وكل رمزٍ من التطبيق إلى صنفه ورسالته بلا سببٍ تقنيّ — ببيئةٍ محقونة (IosEnv) بلا DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browserIosEnv, failureForCode, iosHello, iosLinkedPrinter, iosPick, iosPrinterForJob, iosSystemPrint, iosSystemPrintAvailable,
  isIosWrapper, readIosBridgeVersion, sendViaIos, type IosEnv, type IosProgress,
} from './iosBridge';
import { decodeBridgePayload, encodeBridgePayload, fromBase64Url, type BridgeJob } from './bridgePayload';
import { IOS_BRIDGE_VERSION, IOS_JOB_ID_RE, IOS_MAX_JOB_BYTES, IOS_MAX_PAYLOAD_CHARS, MAX_PAYLOAD_CHARS } from './bridgeContract';
import { DIRECT_PRINT_MESSAGES, DirectPrintError, type DirectPrintFailure } from '../printErrors';
import type { DirectUi } from '../../../rep/printDirect';

type Reply = unknown | ((msg: Record<string, unknown>) => unknown);

/** بيئة مزيّفة: الردّ لكل op (قيمة أو دالة، وError يُرفض به الوعد)، والرسائل المرسلة، ومستمعو التقدّم */
function fakeEnv(replies: Record<string, Reply>, jobId = 'Job_0123456789ab') {
  const posted: Array<Record<string, unknown>> = [];
  const listeners = new Set<(d: IosProgress) => void>();
  const env: IosEnv = {
    post: async (msg) => {
      posted.push(msg);
      const r = replies[msg.op as string];
      const v = typeof r === 'function' ? await (r as (m: Record<string, unknown>) => unknown)(msg) : r;
      if (v instanceof Error) throw v;
      return v;
    },
    onProgress: (f) => { listeners.add(f); return () => { listeners.delete(f); }; },
    jobId: () => jobId,
  };
  const emit = (d: IosProgress) => { for (const f of [...listeners]) f(d); };
  return { env, posted, listeners, emit };
}

const HELLO = (printer: { name: string } | null, busy = false) => ({ v: 1, app: '1.1.0', build: '7', auth: 'allowed', printer, busy, caps: ['print', 'pick', 'cancel', 'systemPrint'] });
const job = (over: Partial<BridgeJob> = {}): BridgeJob => ({
  kind: 'tspl', bytes: Uint8Array.from([0x53, 0x49, 0x5a, 0x45, 0x0d, 0x0a, 0x43, 0x4c, 0x53]), marks: [6, 9], cancel: [0x1b, 0x21, 0x52], slow: true, label: 'فاتورة INV-7', ...over,
});
const ui = (over: Partial<DirectUi> = {}): DirectUi & { progress: Array<[string, number]> } => {
  const progress: Array<[string, number]> = [];
  return { pageLabel: (n, m) => `${n}/${m}`, onProgress: (phase, f) => progress.push([phase, f]), progress, ...over };
};
const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'OK'; } catch (e) { assert.ok(e instanceof DirectPrintError, String(e)); return e.kind; }
};
function noise(n: number, seed = 11): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}

test('(1) hello صالح ⇒ الطابعة المحفوظة باسمها؛ وبلا طابعة ⇒ شاشة الاختيار (pick) ثم اسمها', async () => {
  const a = fakeEnv({ hello: HELLO({ name: 'RPP04' }) });
  assert.deepEqual(await iosHello(a.env), { v: 1, auth: 'allowed', printer: { name: 'RPP04' }, busy: false, caps: ['print', 'pick', 'cancel', 'systemPrint'] });
  assert.deepEqual(await iosPrinterForJob(a.env), { via: 'fs-ios', name: 'RPP04' });
  assert.deepEqual(await iosLinkedPrinter(a.env), { via: 'fs-ios', name: 'RPP04' });
  assert.deepEqual(a.posted, [{ op: 'hello', v: IOS_BRIDGE_VERSION }, { op: 'hello', v: IOS_BRIDGE_VERSION }, { op: 'hello', v: IOS_BRIDGE_VERSION }]);

  const b = fakeEnv({ hello: HELLO(null), pick: { ok: true, printer: { name: 'XP-80' } } });
  assert.deepEqual(await iosPrinterForJob(b.env), { via: 'fs-ios', name: 'XP-80' });
  assert.deepEqual(b.posted.map((m) => m.op), ['hello', 'pick']);
  assert.deepEqual(b.posted[1], { op: 'pick' });
  assert.equal(await iosLinkedPrinter(b.env), null);
});

test('(2) إغلاق شاشة الاختيار أو لا طابعة ⇒ pickPrinter؛ وطباعةٌ جارية ⇒ printing قبل أيّ اختيار', async () => {
  assert.equal(await kindOf(iosPick(fakeEnv({ pick: { ok: false, code: 'picker_cancelled' } }).env)), 'pickPrinter');
  assert.equal(await kindOf(iosPrinterForJob(fakeEnv({ hello: HELLO(null), pick: { ok: false, code: 'picker_cancelled' } }).env)), 'pickPrinter');
  assert.equal(await kindOf(iosPick(fakeEnv({ pick: { ok: false, code: 'bt_off' } }).env)), 'btOff');
  assert.equal(await kindOf(iosPick(fakeEnv({ pick: new Error('did not respond') }).env)), 'failed');
  const busy = fakeEnv({ hello: HELLO(null, true), pick: { ok: true, printer: { name: 'x' } } });
  assert.equal(await kindOf(iosPrinterForJob(busy.env)), 'printing');
  assert.deepEqual(busy.posted.map((m) => m.op), ['hello'], 'لا pick أثناء طباعةٍ جارية');
});

test('(3) مصافحةٌ بإصدارٍ أقدم أو ناقصة ⇒ appUpdateIos (دعوة App Store)؛ ورفض الوعد ⇒ failed؛ وlinkedPrinter لا يرمي', async () => {
  for (const bad of [{ ...HELLO(null), v: 0 }, { ...HELLO(null), v: '1' }, { ...HELLO(null), busy: 'no' }, { ...HELLO(null), caps: 'print' },
    { ...HELLO(null), printer: 'RPP04' }, null, undefined, 'hello', 42, [1]]) {
    assert.equal(await kindOf(iosHello(fakeEnv({ hello: bad }).env)), 'appUpdateIos', JSON.stringify(bad));
    assert.equal(await kindOf(iosPrinterForJob(fakeEnv({ hello: bad }).env)), 'appUpdateIos');
    assert.equal(await iosLinkedPrinter(fakeEnv({ hello: bad }).env), null);
  }
  assert.equal(await kindOf(iosHello(fakeEnv({ hello: new Error('forbidden') }).env)), 'failed');
  assert.equal(await iosLinkedPrinter(fakeEnv({ hello: new Error('forbidden') }).env), null);
  assert.equal(DIRECT_PRINT_MESSAGES.appUpdateIos, 'لتفعيل الطباعة المباشرة حدث تطبيق فيلد سيلز من App Store');
});

test('(4) sendViaIos يرسل {op:print, job, payload}: معرّفٌ صالح، وحمولةٌ خام تُفكّ إلى المهمة نفسها', async () => {
  const f = fakeEnv({ print: { ok: true, outcome: 'done' } });
  const j = job();
  assert.equal(await sendViaIos({ via: 'fs-ios', name: 'RPP04' }, j, ui(), f.env), 'done');
  assert.equal(f.posted.length, 1);
  const msg = f.posted[0];
  assert.deepEqual(Object.keys(msg).sort(), ['job', 'op', 'payload']);
  assert.equal(msg.op, 'print');
  assert.match(msg.job as string, IOS_JOB_ID_RE);
  const payload = msg.payload as string;
  assert.equal(fromBase64Url(payload)[4], 0, 'ترميزٌ خام (بايت الرأس 4 = 0)');
  assert.equal(payload, await encodeBridgePayload(j, { encoding: 'raw' }), 'الحمولة نفسها التي يحملها رابط أندرويد خاماً');
  const d = await decodeBridgePayload(payload);
  assert.equal(d.kind, 'tspl');
  assert.deepEqual(d.bytes, j.bytes);
  assert.deepEqual(d.marks, [6, 9]);
  assert.deepEqual(d.cancel, [0x1b, 0x21, 0x52]);
  assert.equal(d.slow, true);
  assert.equal(d.label, 'فاتورة INV-7');
});

test('(5) سقف الآيفون: 300 ألف بايت خاماً (فوق سقف أندرويد) تُرسل، وبلا maxChars يرفضها رابط أندرويد', async () => {
  const rnd = noise(300_000);
  const j = job({ kind: 'escpos', bytes: rnd, marks: [100_000, 300_000], slow: false });
  const f = fakeEnv({ print: { ok: true, outcome: 'done' } });
  assert.equal(await sendViaIos({ via: 'fs-ios', name: null }, j, ui(), f.env), 'done');
  const payload = f.posted[0].payload as string;
  assert.ok(payload.length > MAX_PAYLOAD_CHARS && payload.length <= IOS_MAX_PAYLOAD_CHARS, String(payload.length));
  await assert.rejects(encodeBridgePayload(j), (e: unknown) => (e as { code?: string }).code === 'TOO_LARGE');
});

test('(6) مهمةٌ فوق IOS_MAX_JOB_BYTES ⇒ tooLarge بلا أيّ رسالة إلى التطبيق؛ والإلغاء قبل الإرسال ⇒ cancelled بلا رسالة', async () => {
  const f = fakeEnv({ print: { ok: true, outcome: 'done' } });
  const big = new Uint8Array(IOS_MAX_JOB_BYTES + 1);
  assert.equal(await kindOf(sendViaIos({ via: 'fs-ios', name: null }, job({ bytes: big, marks: [big.length] }), ui(), f.env)), 'tooLarge');
  assert.equal(f.posted.length, 0);
  // الحدّ نفسه مقبول
  const edge = new Uint8Array(IOS_MAX_JOB_BYTES);
  assert.equal(await sendViaIos({ via: 'fs-ios', name: null }, job({ bytes: edge, marks: [edge.length] }), ui(), f.env), 'done');
  assert.equal(f.posted.length, 1);
  const c = new AbortController();
  c.abort();
  const g = fakeEnv({ print: { ok: true, outcome: 'done' } });
  assert.equal(await sendViaIos({ via: 'fs-ios', name: null }, job(), ui({ signal: c.signal }), g.env), 'cancelled');
  assert.equal(g.posted.length, 0);
});

test('(7) التقدّم: أحداث هذه المهمة وحدها بالترتيب، ومهمةٌ أخرى تُهمل، والاشتراك يُزال بعد الردّ', async () => {
  let fx: ReturnType<typeof fakeEnv> | null = null;
  const f = fakeEnv({
    print: (msg: Record<string, unknown>) => {
      const id = msg.job as string;
      fx!.emit({ job: id, sent: 0, total: 9 });
      fx!.emit({ job: 'Other_job_12345', sent: 5, total: 10 });
      fx!.emit({ job: id, sent: 3, total: 9 });
      fx!.emit({ job: id, sent: 9, total: 9 });
      fx!.emit({ job: id, sent: 1, total: 0 });
      return { ok: true, outcome: 'done' };
    },
  });
  fx = f;
  const u = ui();
  assert.equal(await sendViaIos({ via: 'fs-ios', name: null }, job(), u, f.env), 'done');
  assert.deepEqual(u.progress, [['send', 0], ['send', 0], ['send', 3 / 9], ['send', 1]]);
  assert.equal(f.listeners.size, 0, 'أُزيل المستمع');
  // وبعد رفضٍ أيضاً
  const r = fakeEnv({ print: new Error('x') });
  assert.equal(await kindOf(sendViaIos({ via: 'fs-ios', name: null }, job(), ui(), r.env)), 'failed');
  assert.equal(r.listeners.size, 0);
});

test('(8) الإلغاء أثناء الإرسال ⇒ {op:cancel, job} مرّةً واحدة، وردّ التطبيق cancelled ⇒ \'cancelled\'', async () => {
  const c = new AbortController();
  let release: (v: unknown) => void = () => undefined;
  const f = fakeEnv({ print: () => new Promise((resolve) => { release = resolve; }), cancel: { ok: true } });
  const p = sendViaIos({ via: 'fs-ios', name: null }, job(), ui({ signal: c.signal }), f.env);
  await new Promise((r) => setTimeout(r, 0));
  c.abort();
  c.signal.dispatchEvent(new Event('abort')); // حدثٌ ثانٍ لا يرسل cancel ثانياً
  release({ ok: true, outcome: 'cancelled' });
  assert.equal(await p, 'cancelled');
  const id = f.posted[0].job;
  assert.deepEqual(f.posted.slice(1), [{ op: 'cancel', job: id }]);
  // إلغاءٌ بعد الردّ لا يُرسل شيئاً
  c.signal.dispatchEvent(new Event('abort'));
  assert.equal(f.posted.length, 2);
});

test('(9) كل رمزٍ من التطبيق إلى صنفه (§C.5) — والردّ ok:false برمزه يرمي الصنف نفسه', async () => {
  const table: Array<[unknown, DirectPrintFailure]> = [
    ['bt_off', 'btOff'], ['bt_denied', 'btDenied'], ['no_printer', 'pickPrinter'], ['picker_cancelled', 'pickPrinter'],
    ['not_found', 'busy'], ['connect', 'busy'], ['disconnected', 'disconnected'], ['interrupted', 'interrupted'],
    ['busy', 'printing'], ['too_large', 'tooLarge'], ['bt_unsupported', 'failed'], ['bad_payload', 'failed'],
    ['nope', 'failed'], [undefined, 'failed'], [42, 'failed'], ['toString', 'failed'], ['__proto__', 'failed'],
  ];
  for (const [code, kind] of table) {
    assert.equal(failureForCode(code), kind, String(code));
    const f = fakeEnv({ print: { ok: false, code, detail: 'BAD_CRC' } });
    assert.equal(await kindOf(sendViaIos({ via: 'fs-ios', name: null }, job(), ui(), f.env)), kind, String(code));
  }
  // ردٌّ بلا ok ⇒ failed؛ وok:true بنتيجةٍ مجهولة ⇒ done
  assert.equal(await kindOf(sendViaIos({ via: 'fs-ios', name: null }, job(), ui(), fakeEnv({ print: undefined }).env)), 'failed');
  assert.equal(await sendViaIos({ via: 'fs-ios', name: null }, job(), ui(), fakeEnv({ print: { ok: true } }).env), 'done');
});

test('(10) رفض الوعد (forbidden / bad_request / did not respond) ⇒ failed', async () => {
  for (const m of ['forbidden', 'bad_request', 'did not respond']) {
    assert.equal(await kindOf(sendViaIos({ via: 'fs-ios', name: null }, job(), ui(), fakeEnv({ print: new Error(m) }).env)), 'failed', m);
  }
});

test('(11) iosSystemPrintAvailable: المفتاح والمعالج والعلامة بـsystemPrint — وiosSystemPrint يرمي «print frame» عند التعذّر', async () => {
  const handler = { postMessage: () => Promise.resolve({ ok: true }) };
  const win = (marker: unknown, h: unknown = handler) => ({ webkit: { messageHandlers: { fsPrint: h } }, __fsIosBridge: marker });
  assert.equal(iosSystemPrintAvailable(win({ v: 1, caps: ['print', 'systemPrint'] })), true);
  assert.equal(iosSystemPrintAvailable(win({ v: 1, caps: ['print', 'systemPrint'] }), false), false, 'مفتاح الويب مطفأ');
  assert.equal(iosSystemPrintAvailable(win({ v: 1, caps: ['print', 'pick'] })), false, 'بلا systemPrint');
  assert.equal(iosSystemPrintAvailable(win({ v: 1 })), false);
  assert.equal(iosSystemPrintAvailable(win(undefined)), false, 'بلا علامة');
  assert.equal(iosSystemPrintAvailable(win({ v: 1, caps: ['systemPrint'] }, {})), false, 'معالجٌ بلا postMessage');
  assert.equal(iosSystemPrintAvailable(undefined), false);
  assert.equal(iosSystemPrintAvailable({ webkit: { messageHandlers: { print: handler } } }), false, 'تطبيق 1.0');
  assert.equal(iosSystemPrintAvailable(), false, 'Node');

  const ok = fakeEnv({ systemPrint: { ok: true, outcome: 'dismissed' } });
  await iosSystemPrint('<html></html>', 80, 'INV-1', ok.env);
  assert.deepEqual(ok.posted, [{ op: 'systemPrint', html: '<html></html>', widthMm: 80, name: 'INV-1' }]);
  for (const r of [{ ok: false, code: 'print_unavailable' }, new Error('forbidden'), undefined]) {
    await assert.rejects(iosSystemPrint('<p>', 58, '', fakeEnv({ systemPrint: r }).env), (e: unknown) => e instanceof Error && e.message === 'print frame');
  }
});

test('readIosBridgeVersion وisIosWrapper: المعالج والعلامة معاً؛ والتطبيق بوكيله أو كعكته', () => {
  const h = { postMessage() { return Promise.resolve(); } };
  assert.equal(readIosBridgeVersion({ webkit: { messageHandlers: { fsPrint: h } }, __fsIosBridge: { v: 1, caps: [] } }), 1);
  assert.equal(readIosBridgeVersion({ webkit: { messageHandlers: { fsPrint: h } }, __fsIosBridge: { v: 3 } }), 3);
  assert.equal(readIosBridgeVersion({ webkit: { messageHandlers: { fsPrint: h } } }), null);
  assert.equal(readIosBridgeVersion({ webkit: { messageHandlers: { fsPrint: h } }, __fsIosBridge: { v: 1.5 } }), null);
  assert.equal(readIosBridgeVersion({ __fsIosBridge: { v: 1 } }), null);
  assert.equal(readIosBridgeVersion({ webkit: { messageHandlers: { other: h } }, __fsIosBridge: { v: 1 } }), null);
  assert.equal(readIosBridgeVersion(undefined), null);
  assert.equal(readIosBridgeVersion(), null, 'Node بلا window');
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  assert.equal(isIosWrapper(`${IPHONE} FieldSales`, ''), true);
  assert.equal(isIosWrapper(IPHONE, 'a=1; app-platform=iOS App Store; b=2'), true);
  assert.equal(isIosWrapper(IPHONE, 'app-platform=iOS%20App%20Store'), true);
  assert.equal(isIosWrapper(IPHONE, ''), false);
  assert.equal(isIosWrapper(`${IPHONE} FieldSalesX`, 'app-platform=Android'), false);
  assert.equal(isIosWrapper('FieldSales', ''), false, 'وكيلٌ فارغ إلا الاسم');
});

test('browserIosEnv: بلا معالج يُرفض الوعد، ومعرّف المهمة صالحٌ وعشوائيّ', async () => {
  const env = browserIosEnv();
  await assert.rejects(env.post({ op: 'hello' }));
  const ids = new Set(Array.from({ length: 50 }, () => env.jobId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, IOS_JOB_ID_RE);
});

test('معرّف مهمةٍ غير صالح من البيئة يُستبدل بمعرّفٍ صالح، والتقدّم محصورٌ بين 0 و1، واسمٌ فارغ = بلا اسم', async () => {
  // jobId خارج ^[A-Za-z0-9_-]{8,64}$ ⇒ التطبيق كان سيرفضه bad_request — فيُولَّد غيره، والتقدّم والإلغاء بالمعرّف الجديد
  let fx: ReturnType<typeof fakeEnv> | null = null;
  const f = fakeEnv({
    print: (msg: Record<string, unknown>) => {
      const id = msg.job as string;
      fx!.emit({ job: id, sent: 12, total: 9 });
      fx!.emit({ job: id, sent: -3, total: 9 });
      return { ok: true, outcome: 'done' };
    },
  }, 'bad id!');
  fx = f;
  const u = ui();
  assert.equal(await sendViaIos({ via: 'fs-ios', name: null }, job(), u, f.env), 'done');
  assert.match(f.posted[0].job as string, IOS_JOB_ID_RE);
  assert.notEqual(f.posted[0].job, 'bad id!');
  assert.deepEqual(u.progress, [['send', 0], ['send', 1], ['send', 0]]);
  // اسم طابعةٍ من مسافاتٍ فقط ⇒ name: null (الشاشة تقول «الطابعة مربوطة» بلا اسم)
  const blank = fakeEnv({ hello: HELLO({ name: '   ' }) });
  assert.deepEqual(await iosLinkedPrinter(blank.env), { via: 'fs-ios', name: null });
  assert.deepEqual(await iosPrinterForJob(blank.env), { via: 'fs-ios', name: null });
  assert.deepEqual(await iosPick(fakeEnv({ pick: { ok: true, printer: { name: '' } } }).env), { via: 'fs-ios', name: null });
});
