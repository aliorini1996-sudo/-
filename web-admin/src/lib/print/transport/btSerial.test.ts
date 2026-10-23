// النقل بالبلوتوث عبر Web Serial («إعدادات الطباعة» M3، التصميم §3.3 الخطوة 6): دفعات 512 تنتظر writer.ready، والتقدّم، والإغلاق
// بعد كل مهمة (وبعد الخطأ)، والإلغاء يكمل الأمر الجاري ثم يرسل أمر الإلغاء، وتصنيف الأخطاء برسالة عربية، وكشف الدعم.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_BYTES, SPP_UUID, isSppPort, linkPrinter, linkedPrinter, printerForJob, sendJob, serialApi, serialFailureOf,
  type SerialLike, type SerialPortLike,
} from './btSerial';
import { DIRECT_PRINT_MESSAGES, DirectPrintError } from '../printErrors';

interface Fake extends SerialPortLike { writes: number[][]; log: string[] }

function fakePort(opts: { openError?: unknown; writeErrorAt?: number; onWrite?: (n: number) => void } = {}): Fake {
  const writes: number[][] = [];
  const log: string[] = [];
  let open = false;
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (opts.writeErrorAt !== undefined && writes.length === opts.writeErrorAt) {
        const e = new Error('The device has been lost.'); e.name = 'NetworkError'; throw e;
      }
      writes.push(Array.from(chunk));
      opts.onWrite?.(writes.length);
    },
    close() { log.push('writer.close'); },
  });
  return {
    writes, log,
    async open(o) { log.push(`open:${o.baudRate}`); if (opts.openError) throw opts.openError; open = true; },
    async close() { log.push('close'); if (!open) throw new Error('not open'); open = false; },
    get writable() { return open ? writable : null; },
    getInfo: () => ({ bluetoothServiceClassId: SPP_UUID }),
  };
}
const noSleep = async () => undefined;
const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

test('دفعات 512 بايتاً بالترتيب، والتقدّم بعد كل دفعة، ثم إغلاق الكاتب والمنفذ (معدّل البود 9600 يُتجاهل على RFCOMM)', async () => {
  const port = fakePort();
  const progress: number[] = [];
  const r = await sendJob(port, { bytes: bytesOf(1300), marks: [1300] }, { onProgress: (f) => progress.push(f), sleep: noSleep });
  assert.equal(r, 'done');
  assert.deepEqual(port.writes.map((w) => w.length), [CHUNK_BYTES, CHUNK_BYTES, 1300 - 2 * CHUNK_BYTES]);
  assert.deepEqual(port.writes.flat(), Array.from(bytesOf(1300)));
  assert.deepEqual(progress, [512 / 1300, 1024 / 1300, 1]);
  assert.deepEqual(port.log, ['open:9600', 'writer.close', 'close']);
});

test('الإلغاء: يكمل حتى أقرب نهاية أمرٍ مكتمل ثم يرسل أمر الإلغاء — لا قطع في منتصف صورة', async () => {
  const ctrl = new AbortController();
  const port = fakePort({ onWrite: (n) => { if (n === 1) ctrl.abort(); } });
  const r = await sendJob(port, { bytes: bytesOf(3000), marks: [2, 700, 1800, 3000] }, { signal: ctrl.signal, cancelBytes: [0x1b, 0x40, 0x0c], sleep: noSleep });
  assert.equal(r, 'cancelled');
  // الدفعة الأولى 0..511 ثم إكمال الأمر حتى 700، ثم الإلغاء
  assert.deepEqual(port.writes.map((w) => w.length), [512, 700 - 512, 3]);
  assert.deepEqual(port.writes[2], [0x1b, 0x40, 0x0c]);
  assert.equal(port.log[port.log.length - 1], 'close');
});

test('الأخطاء: الفتح ⇒ «تعذر الاتصال» والكتابة ⇒ «انقطع الاتصال» — والمنفذ يُغلق في الحالين', async () => {
  const busy = Object.assign(new Error('Failed to open serial port.'), { name: 'NetworkError' });
  await assert.rejects(sendJob(fakePort({ openError: busy }), { bytes: bytesOf(10), marks: [10] }, { sleep: noSleep }),
    (e: unknown) => e instanceof DirectPrintError && e.kind === 'busy' && e.message === DIRECT_PRINT_MESSAGES.busy);
  const port = fakePort({ writeErrorAt: 1 });
  await assert.rejects(sendJob(port, { bytes: bytesOf(2000), marks: [2000] }, { sleep: noSleep }),
    (e: unknown) => e instanceof DirectPrintError && e.kind === 'disconnected');
  assert.equal(port.log[port.log.length - 1], 'close', 'المنفذ لا يبقى محجوزاً بعد الانقطاع');
});

test('تصنيف أخطاء Web Serial ورسائلها العربية', () => {
  const err = (name: string) => Object.assign(new Error(name), { name });
  assert.equal(serialFailureOf(err('NotFoundError'), 'choose'), 'notChosen');
  assert.equal(serialFailureOf(err('SecurityError'), 'choose'), 'security');
  assert.equal(serialFailureOf(err('InvalidStateError'), 'open'), 'busy');
  assert.equal(serialFailureOf(err('BreakError'), 'write'), 'disconnected');
  assert.equal(serialFailureOf(new DirectPrintError('unsupported'), 'write'), 'unsupported');
  assert.equal(DIRECT_PRINT_MESSAGES.unsupported, 'الطباعة المباشرة تتطلب Chrome 138 أو أحدث');
  assert.match(DIRECT_PRINT_MESSAGES.disconnected, /أعد تشغيل الطابعة وحاول/);
});

test('كشف الدعم: Web Serial في سياقٍ آمن وحده — وإلا «تتطلب Chrome 138»', async () => {
  const api: SerialLike = { requestPort: async () => fakePort(), getPorts: async () => [] };
  assert.equal(serialApi({ serial: api }, true), api);
  assert.equal(serialApi({ serial: api }, false), null, 'http لا يحمل Web Serial');
  assert.equal(serialApi({}, true), null, 'Samsung Internet وWebView');
  assert.equal(serialApi(undefined, true), null);
  await assert.rejects(printerForJob(null), (e: unknown) => e instanceof DirectPrintError && e.kind === 'unsupported');
  assert.equal(await linkedPrinter(null), null);
});

test('الربط: نافذة Chrome بمرشّح SPP، ثم نسيان المنافذ الأخرى — والمربوطة تُستعمل بلا نافذة', async () => {
  assert.ok(isSppPort({ bluetoothServiceClassId: SPP_UUID }));
  assert.ok(isSppPort({ bluetoothServiceClassId: 0x1101 }));
  assert.ok(isSppPort({ bluetoothServiceClassId: '0x1101' }));
  assert.ok(!isSppPort({ usbVendorId: 1 }));
  const chosen = fakePort();
  let forgot = 0;
  const other: SerialPortLike = { ...fakePort(), forget: async () => { forgot++; } };
  let asked: unknown = null;
  const api: SerialLike = {
    requestPort: async (o) => { asked = o; return chosen; },
    getPorts: async () => [other, chosen],
  };
  assert.equal(await linkPrinter(api), chosen);
  assert.deepEqual(asked, { filters: [{ bluetoothServiceClassId: SPP_UUID }], allowedBluetoothServiceClassIds: [SPP_UUID] });
  assert.equal(forgot, 1);
  // المربوطة من getPorts بلا نافذة
  let prompts = 0;
  const granted: SerialLike = { requestPort: async () => { prompts++; return chosen; }, getPorts: async () => [chosen] };
  assert.equal(await printerForJob(granted), chosen);
  assert.equal(prompts, 0);
  // إلغاء نافذة الاختيار ⇒ «لم تربط طابعة»
  const none: SerialLike = { requestPort: async () => { throw Object.assign(new Error('No port selected by the user.'), { name: 'NotFoundError' }); }, getPorts: async () => [] };
  await assert.rejects(printerForJob(none), (e: unknown) => e instanceof DirectPrintError && e.kind === 'notChosen');
});
