// حمولة جسر الطباعة v1: CRC32 وbase64url وقصّ الوسم على حدود الحروف، والترميز ذهاباً وإياباً بكل ترميز، واختيار 'auto'
// (المضغوط إن قصُر وإلا الخام)، والرفض: الكبير TOO_LARGE والمختلّ BAD_INPUT — قبل أيّ فتحٍ للتطبيق.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BridgePayloadError, buildInner, crc32, decodeBridgePayload, encodeBridgePayload, fromBase64Url, streamCompressor, toBase64Url,
  utf8Truncate, type BridgeJob,
} from './bridgePayload';
import { IOS_MAX_PAYLOAD_CHARS, MAX_INNER_BYTES, MAX_JOB_BYTES, MAX_LABEL_BYTES, MAX_MARKS, MAX_PAYLOAD_CHARS } from './bridgeContract';
import { CHUNK_BYTES, CLOSE_GRACE_MS, SLOW_LINK_PAUSE_MS } from './btSerial';

const enc = new TextEncoder();
const job = (over: Partial<BridgeJob> = {}): BridgeJob => ({
  kind: 'escpos', bytes: Uint8Array.from([0x1b, 0x40, 0x0a, 0x0a]), marks: [2, 4], cancel: [0x1b, 0x40], slow: false, label: 'فاتورة INV-1', ...over,
});
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'OK'; } catch (e) { assert.ok(e instanceof BridgePayloadError, String(e)); return e.code; }
};
/** بايتات عشوائية حتمية (لا تنضغط) */
function noise(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}

test('crc32 = java.util.zip.CRC32 (متّجه المعيار)', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('base64url ذهاباً وإياباً لأطوالٍ %3 = 0/1/2 — بلا حشو ولا + /', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 255, 256, 257, 70000]) {
    const b = noise(n, n + 1);
    const s = toBase64Url(b);
    assert.doesNotMatch(s, /[+/=]/);
    assert.equal(s, Buffer.from(b).toString('base64url'), `n=${n}`);
    if (n > 0) assert.deepEqual(fromBase64Url(s), b);
  }
});

test('fromBase64Url يرفض الفارغ و+ و= وطولاً %4 == 1', () => {
  for (const s of ['', '+AAA', 'AAA=', 'AAAA=', 'AAAAA', 'AB/C', 'AB C']) {
    assert.throws(() => fromBase64Url(s), (e: unknown) => e instanceof BridgePayloadError && e.code === 'BAD_BASE64', JSON.stringify(s));
  }
});

test('utf8Truncate لا يقطع حرفاً: عربية ورمز تعبيري على الحدّ', () => {
  const s = 'ب'.repeat(79) + '😀x'; // 158 + 4 + 1
  const t = utf8Truncate(s, MAX_LABEL_BYTES);
  assert.equal(t.length, 158);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(t), 'ب'.repeat(79));
  for (let max = 0; max <= 12; max++) {
    const u = utf8Truncate('أ😀ب✓', max);
    assert.ok(u.length <= max);
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(u), `max=${max}`);
  }
  assert.equal(utf8Truncate('abc', 160).length, 3);
});

test('الوسم يُقصّ بصمت إلى 160 بايتاً ويُشذَّب', async () => {
  const d = await decodeBridgePayload(await encodeBridgePayload(job({ label: '  ' + 'ف'.repeat(200) + '  ' }), { encoding: 'raw' }));
  assert.equal(d.label, 'ف'.repeat(80));
});

test('ذهاباً وإياباً: raw وdeflate-raw وdeflate وauto — الحقول كلها والافتراضات من btSerial.ts', async () => {
  const bytes = noise(3000);
  const j = job({ kind: 'escp24', bytes, marks: [0, 100, 2999, 3000], cancel: [0x1b, 0x40, 0x0c], slow: true, label: 'سند قبض ✓ 😀' });
  for (const encoding of ['raw', 'deflate-raw', 'deflate', 'auto'] as const) {
    const d = await decodeBridgePayload(await encodeBridgePayload(j, { encoding }));
    assert.equal(d.kind, 'escp24');
    assert.equal(d.slow, true);
    assert.equal(d.chunkBytes, CHUNK_BYTES);
    assert.equal(d.pauseMs, SLOW_LINK_PAUSE_MS);
    assert.equal(d.closeGraceMs, CLOSE_GRACE_MS);
    assert.deepEqual(d.cancel, [0x1b, 0x40, 0x0c]);
    assert.equal(d.label, 'سند قبض ✓ 😀');
    assert.deepEqual(d.marks, [0, 100, 2999, 3000]);
    assert.deepEqual(d.bytes, bytes, encoding);
  }
  const t = await decodeBridgePayload(await encodeBridgePayload(job({ kind: 'tspl', cancel: [], chunkBytes: 64, pauseMs: 0, closeGraceMs: 5000 })));
  assert.deepEqual([t.kind, t.cancel, t.chunkBytes, t.pauseMs, t.closeGraceMs], ['tspl', [], 64, 0, 5000]);
});

test("auto: الخام لمهمةٍ صغيرة لا ينفعها الضغط، وdeflate-raw لمهمة 10 ك.ب أغلبها أصفار، والخام بلا ضاغط", async () => {
  const header = async (s: string) => fromBase64Url(s)[4];
  assert.equal(await header(await encodeBridgePayload(job())), 0);
  const zeros = new Uint8Array(10_000); zeros[5] = 0x1b;
  const big = job({ bytes: zeros, marks: [10_000] });
  const auto = await encodeBridgePayload(big);
  assert.equal(await header(auto), 1);
  const raw = await encodeBridgePayload(big, { compress: null });
  assert.equal(await header(raw), 0);
  assert.ok(auto.length < raw.length / 10);
  // ضاغطٌ يرفض deflate-raw ⇒ deflate؛ ضاغطٌ يرفضهما ⇒ خام
  const real = streamCompressor()!;
  const onlyZlib = async (d: Uint8Array, f: 'deflate-raw' | 'deflate') => { if (f === 'deflate-raw') throw new TypeError('unsupported'); return real(d, f); };
  assert.equal(await header(await encodeBridgePayload(big, { compress: onlyZlib })), 2);
  assert.equal(await header(await encodeBridgePayload(big, { compress: async () => { throw new TypeError('x'); } })), 0);
  assert.deepEqual((await decodeBridgePayload(auto)).bytes, zeros);
});

test('TOO_LARGE: مهمةٌ فوق MAX_JOB_BYTES، وحمولةٌ فوق MAX_PAYLOAD_CHARS (150000 بايت عشوائية)', async () => {
  const huge = new Uint8Array(MAX_JOB_BYTES + 1);
  assert.equal(await codeOf(encodeBridgePayload(job({ bytes: huge, marks: [huge.length] }))), 'TOO_LARGE');
  const rnd = noise(150_000);
  assert.equal(await codeOf(encodeBridgePayload(job({ bytes: rnd, marks: [rnd.length] }), { encoding: 'raw' })), 'TOO_LARGE');
  assert.equal(await codeOf(encodeBridgePayload(job({ bytes: rnd, marks: [rnd.length] }))), 'TOO_LARGE');
  // والحدّ نفسه مقبول: 147421 صفراً خاماً = 196608 محرفاً بالضبط (متّجه payload_at_cap_raw)
  const atCap = await encodeBridgePayload({ ...job(), bytes: new Uint8Array(147_421), marks: [147_421], cancel: [], label: '' }, { encoding: 'raw' });
  assert.equal(atCap.length, MAX_PAYLOAD_CHARS);
});

test('maxChars (تطبيق الآيفون): الغياب = MAX_PAYLOAD_CHARS كما كان، وسقفٌ أكبر يقبل إطاراً خاماً أكبر — وحدّا المهمة والداخل باقيان', async () => {
  const zeros = (n: number) => ({ ...job(), bytes: new Uint8Array(n), marks: [n], cancel: [], label: '' });
  // الحدّ الافتراضيّ بالضبط: بلا maxChars ومعه = MAX_PAYLOAD_CHARS سواء، وبايتٌ واحد فوقه يُرفض
  assert.equal((await encodeBridgePayload(zeros(147_421), { encoding: 'raw' })).length, MAX_PAYLOAD_CHARS);
  assert.equal((await encodeBridgePayload(zeros(147_421), { encoding: 'raw', maxChars: MAX_PAYLOAD_CHARS })).length, MAX_PAYLOAD_CHARS);
  assert.equal(await codeOf(encodeBridgePayload(zeros(147_422), { encoding: 'raw' })), 'TOO_LARGE');
  // سقف الآيفون: 300 ألف بايت عشوائية خاماً تمرّ، وما فوق السقف يُرفض
  const rnd = noise(300_000);
  const big = await encodeBridgePayload(job({ bytes: rnd, marks: [rnd.length] }), { encoding: 'raw', maxChars: IOS_MAX_PAYLOAD_CHARS });
  assert.ok(big.length > MAX_PAYLOAD_CHARS && big.length <= IOS_MAX_PAYLOAD_CHARS, String(big.length));
  assert.equal(fromBase64Url(big)[4], 0, 'خام');
  assert.equal(await codeOf(encodeBridgePayload(job({ bytes: rnd, marks: [rnd.length] }), { encoding: 'raw' })), 'TOO_LARGE');
  assert.equal(await codeOf(encodeBridgePayload(job({ bytes: rnd, marks: [rnd.length] }), { encoding: 'raw', maxChars: 100_000 })), 'TOO_LARGE');
  // MAX_JOB_BYTES وMAX_INNER_BYTES لا يرفعهما maxChars
  const huge = new Uint8Array(MAX_JOB_BYTES + 1);
  assert.equal(await codeOf(encodeBridgePayload(job({ bytes: huge, marks: [huge.length] }), { encoding: 'raw', maxChars: 1e9 })), 'TOO_LARGE');
  const maxJob = new Uint8Array(MAX_JOB_BYTES);
  const marks = Array.from({ length: MAX_MARKS }, (_, i) => Math.round(((i + 1) * MAX_JOB_BYTES) / MAX_MARKS));
  assert.ok(MAX_JOB_BYTES + MAX_MARKS * 3 + 40 <= MAX_INNER_BYTES, 'الداخل يتسع لأكبر مهمة');
  assert.equal(typeof (await encodeBridgePayload({ ...job(), bytes: maxJob, marks, cancel: [], label: '' }, { encoding: 'raw', maxChars: 1e9 })), 'string');
});

test('BAD_INPUT: علامات فارغة أو غير تصاعدية أو آخرها ليس الطول، وإلغاءٌ فوق 16، ومهمةٌ فارغة', () => {
  const bad = (j: BridgeJob) => assert.throws(() => buildInner(j), (e: unknown) => e instanceof BridgePayloadError && e.code === 'BAD_INPUT');
  bad(job({ marks: [] }));
  bad(job({ marks: [2, 2, 4] }));
  bad(job({ marks: [3, 2, 4] }));
  bad(job({ marks: [2] }));
  bad(job({ marks: [2, 5] }));
  bad(job({ marks: [-1, 4] }));
  bad(job({ cancel: new Array(17).fill(0x1b) }));
  bad(job({ cancel: [256] }));
  bad(job({ bytes: new Uint8Array(0), marks: [0] }));
  bad(job({ chunkBytes: 0 }));
  bad(job({ kind: 'zpl' as unknown as BridgeJob['kind'] }));
  assert.doesNotThrow(() => buildInner(job({ marks: [0, 4], cancel: new Array(16).fill(0) })));
});

test('auto: المضغوط بطول الداخل نفسه لا يُستعمل (أقصر حصراً)، وضاغطٌ يرمي متزامناً ⇒ التالي', async () => {
  const header = (s: string) => fromBase64Url(s)[4];
  const inner = buildInner(job()).length;
  const sameLength = async (d: Uint8Array) => new Uint8Array(d.length);
  assert.equal(header(await encodeBridgePayload(job(), { compress: sameLength })), 0, 'مساوٍ ⇒ خام');
  const shorter = async (d: Uint8Array, f: 'deflate-raw' | 'deflate') => (f === 'deflate-raw' ? new Uint8Array(inner - 1) : new Uint8Array(0));
  assert.equal(header(await encodeBridgePayload(job(), { compress: shorter })), 1, 'أقصر ببايتٍ ⇒ مضغوط');
  // رميٌ متزامن (المُنشئ نفسه) لا وعدٌ مرفوض
  const syncThrow = ((d: Uint8Array, f: 'deflate-raw' | 'deflate') => { if (f === 'deflate-raw') throw new TypeError('ctor'); return streamCompressor()!(d, f); });
  const zeros = new Uint8Array(10_000);
  assert.equal(header(await encodeBridgePayload(job({ bytes: zeros, marks: [10_000] }), { compress: syncThrow })), 2);
});

test('CompressionStream في الصفحة: غائبٌ ⇒ خام، ومُنشئٌ يرفض deflate-raw (Chrome 80–102) ⇒ deflate، ويرفضهما ⇒ خام', async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = Object.getOwnPropertyDescriptor(g, 'CompressionStream');
  const Real = g.CompressionStream as new (f: string) => CompressionStream;
  const header = (s: string) => fromBase64Url(s)[4];
  const big = job({ bytes: new Uint8Array(10_000), marks: [10_000] });
  const put = (v: unknown) => Object.defineProperty(g, 'CompressionStream', { value: v, configurable: true, writable: true });
  try {
    put(undefined);
    assert.equal(streamCompressor(), null);
    assert.equal(header(await encodeBridgePayload(big)), 0);
    put(class { constructor(f: string) { if (f === 'deflate-raw') throw new TypeError('format'); return new Real(f); } });
    const z = await encodeBridgePayload(big);
    assert.equal(header(z), 2);
    assert.deepEqual((await decodeBridgePayload(z)).bytes, big.bytes);
    put(class { constructor() { throw new TypeError('format'); } });
    assert.equal(header(await encodeBridgePayload(big)), 0);
  } finally {
    if (saved) Object.defineProperty(g, 'CompressionStream', saved); else delete g.CompressionStream;
  }
});
