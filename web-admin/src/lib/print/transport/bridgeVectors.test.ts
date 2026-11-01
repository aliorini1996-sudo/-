// عقد الحمولة بين الويب والتطبيق: المتّجهات الذهبية نفسها التي يفكّها PrintPayloadTest.kt (ملفّ حزمة أندرويد، يُقرأ هنا
// قراءةً فقط). كل متّجهٍ يُفكّ هنا إلى الحقول نفسها أو إلى رمز الرفض نفسه، وكل متّجهٍ سليم يُعاد ترميزه بترميزه:
// الخام حرفاً بحرف، والمضغوط برأسه نفسه ومحتواه نفسه — فلا يفترق المُرمِّز عن المُفكِّك في أيّ طرف.
// للتطوير قبل وصول حزمة أندرويد: FS_PRINT_VECTORS=<مسار نسخة الملفّ>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgePayloadError, decodeBridgePayload, encodeBridgePayload, fromBase64Url, type BridgeEncoding, type DecodedBridgeJob } from './bridgePayload';
import {
  MAX_CANCEL_BYTES, MAX_INNER_BYTES, MAX_JOB_BYTES, MAX_LABEL_BYTES, MAX_MARKS, MAX_PAYLOAD_CHARS, PAYLOAD_FORMAT_VERSION,
  PAYLOAD_HEADER_BYTES,
} from './bridgeContract';

const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = process.env.FS_PRINT_VECTORS
  || path.join(SRC, '..', '..', 'android-rep', 'app', 'src', 'test', 'resources', 'print_payload_vectors.json');

type Payload = string | { prefix: string; repeat: string; count: number };
interface VectorJob {
  kind: string; slow: boolean; chunkBytes: number; pauseMs: number; closeGraceMs: number;
  cancelHex: string; label: string; marks: number[]; bytes: { hex: string } | { zeros: number };
}
interface Vector { name: string; expect: string; encoding?: BridgeEncoding; payload: Payload; job?: VectorJob; note?: string }
interface Fixture { format: string; version: number; constants: Record<string, number>; vectors: Vector[] }

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;
const payloadOf = (p: Payload) => (typeof p === 'string' ? p : p.prefix + p.repeat.repeat(p.count));
const bytesOf = (b: VectorJob['bytes']) => ('hex' in b ? Uint8Array.from(Buffer.from(b.hex, 'hex')) : new Uint8Array(b.zeros));
const hex = (a: readonly number[]) => Buffer.from(a).toString('hex');

function assertJob(d: DecodedBridgeJob, want: VectorJob, name: string) {
  assert.equal(d.kind, want.kind, name);
  assert.equal(d.slow, want.slow, name);
  assert.equal(d.chunkBytes, want.chunkBytes, name);
  assert.equal(d.pauseMs, want.pauseMs, name);
  assert.equal(d.closeGraceMs, want.closeGraceMs, name);
  assert.equal(hex(d.cancel), want.cancelHex, name);
  assert.equal(d.label, want.label, name);
  assert.deepEqual(d.marks, want.marks, name);
  assert.ok(Buffer.from(d.bytes).equals(Buffer.from(bytesOf(want.bytes))), `${name}: bytes`);
}

test('الملفّ: الصيغة والثوابت = ثوابت bridgeContract.ts', () => {
  assert.equal(fixture.format, 'fieldsa-print-payload-vectors');
  assert.equal(fixture.version, 1);
  assert.deepEqual(fixture.constants, {
    FORMAT_VERSION: PAYLOAD_FORMAT_VERSION, HEADER_BYTES: PAYLOAD_HEADER_BYTES, MAX_PAYLOAD_CHARS, MAX_INNER_BYTES, MAX_JOB_BYTES,
    MAX_MARKS, MAX_LABEL_BYTES, MAX_CANCEL_BYTES,
  });
  assert.equal(fixture.vectors.length, 42);
  assert.equal(fixture.vectors.filter((v) => v.expect === 'OK').length, 10);
  // كل رمز رفضٍ ممثَّل
  const codes = new Set(fixture.vectors.map((v) => v.expect));
  for (const c of ['TOO_LONG', 'BAD_BASE64', 'BAD_HEADER', 'BAD_VERSION', 'BAD_ENCODING', 'BAD_LENGTH', 'INFLATE_FAILED', 'LENGTH_MISMATCH', 'BAD_CRC', 'BAD_LAYOUT', 'BAD_MARKS']) {
    assert.ok(codes.has(c), c);
  }
});

test('كل متّجه يُفكّ إلى حقوله أو إلى رمز رفضه بالضبط (ترتيب الفحص §A.3.6)', async () => {
  for (const v of fixture.vectors) {
    let got = 'OK';
    let d: DecodedBridgeJob | null = null;
    try { d = await decodeBridgePayload(payloadOf(v.payload)); } catch (e) {
      assert.ok(e instanceof BridgePayloadError, `${v.name}: ${String(e)}`);
      got = e.code;
    }
    assert.equal(got, v.expect, v.name);
    if (v.expect === 'OK') assertJob(d as DecodedBridgeJob, v.job as VectorJob, v.name);
  }
});

test('كل متّجهٍ سليم يُعاد ترميزه بترميزه: الخام حرفاً بحرف، والمضغوط برأسه ومحتواه', async () => {
  for (const v of fixture.vectors.filter((x) => x.expect === 'OK')) {
    const want = v.job as VectorJob;
    const mine = await encodeBridgePayload({
      kind: want.kind as 'escpos' | 'escp24' | 'tspl', bytes: bytesOf(want.bytes), marks: want.marks,
      cancel: Array.from(Buffer.from(want.cancelHex, 'hex')), slow: want.slow, label: want.label,
      chunkBytes: want.chunkBytes, pauseMs: want.pauseMs, closeGraceMs: want.closeGraceMs,
    }, { encoding: v.encoding });
    const theirs = payloadOf(v.payload);
    if (v.encoding === 'raw') {
      assert.equal(mine, theirs, v.name);
    } else {
      assert.deepEqual(fromBase64Url(mine).subarray(0, PAYLOAD_HEADER_BYTES), fromBase64Url(theirs).subarray(0, PAYLOAD_HEADER_BYTES), `${v.name}: header`);
      assertJob(await decodeBridgePayload(mine), want, `${v.name}: re-encoded`);
    }
  }
});
