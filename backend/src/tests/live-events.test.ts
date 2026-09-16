import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  subscribe, publishInvoicesChanged, sseFrame, liveListenerCount, MAX_PER_TENANT,
} from '../services/liveEvents';

/**
 * التحديث اللحظيّ لعمود «المدفوع» (قرار المالك): أيّ سند يصدره مندوب أو إداريّ
 * أو دفعةٌ إلكترونية على فاتورة ⇒ كل شاشة مفتوحة لتلك الشركة تعيد قراءتها لحظتها.
 *
 * الحرّاس: عزل الشركات في البثّ، وأن كل مسارٍ يغيّر مدفوع فاتورة يبثّ بعد
 * التزام معاملته — مسارٌ يُنسى يعيد الخلل نفسه لذلك المصدر وحده بصمت.
 */

const B = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(B, 'src', p), 'utf8');

function sink() {
  const frames: string[] = [];
  return { frames, write: (c: string) => { frames.push(c); return true; } };
}

test('إطار SSE: سطر الحدث ثم البيانات ثم سطرٌ فارغ', () => {
  assert.equal(sseFrame('invoices', { a: 1 }), 'event: invoices\ndata: {"a":1}\n\n');
});

test('البثّ يصل مستمعي الشركة وحدها — لا تسرّب بين الشركات', () => {
  const a = sink(); const b = sink(); const other = sink();
  const ua = subscribe('T-live-1', a, 'u1')!;
  const ub = subscribe('T-live-1', b, 'u2')!;
  const uo = subscribe('T-live-2', other, 'u3')!;
  publishInvoicesChanged('T-live-1');
  assert.equal(a.frames.length, 1);
  assert.equal(b.frames.length, 1);
  assert.equal(other.frames.length, 0, 'حدث شركةٍ وصل شركةً أخرى');
  assert.match(a.frames[0], /^event: invoices\n/);
  ua(); ub(); uo();
  assert.equal(liveListenerCount('T-live-1'), 0);
});

test('الحمولة بلا بيانات أعمال — الشاشة تعيد القراءة بصلاحياتها هي', () => {
  const s = sink();
  const u = subscribe('T-live-3', s, 'u1')!;
  publishInvoicesChanged('T-live-3');
  const data = JSON.parse(s.frames[0].split('\n')[1].slice('data: '.length));
  assert.deepEqual(Object.keys(data), ['at'], 'الحدث يحمل ما قد لا يحقّ لمستمعٍ مقيَّد النطاق رؤيته');
  u();
});

test('إلغاء التسجيل مرّتين آمن، ومستمعٌ مات لا يُسقط البثّ على البقيّة', () => {
  const dead = { write: () => { throw new Error('socket closed'); } };
  const live = sink();
  const ud = subscribe('T-live-4', dead, 'u1')!;
  const ul = subscribe('T-live-4', live, 'u2')!;
  assert.doesNotThrow(() => publishInvoicesChanged('T-live-4'));
  assert.equal(live.frames.length, 1, 'مقبسٌ ميّت قطع البثّ عن مستمعٍ حيّ');
  ud(); ud(); ul();
  assert.equal(liveListenerCount('T-live-4'), 0);
});

test('سقف الاتصالات لكل شركة', () => {
  const offs: (() => void)[] = [];
  for (let i = 0; i < MAX_PER_TENANT; i++) offs.push(subscribe('T-live-5', sink(), `u${i}`)!);
  assert.equal(subscribe('T-live-5', sink(), 'extra'), null);
  offs.forEach(f => f());
  assert.equal(liveListenerCount('T-live-5'), 0);
});

test('شركة بلا مستمعين أو معرّف فارغ لا تفعل شيئاً', () => {
  assert.doesNotThrow(() => publishInvoicesChanged('T-nobody'));
  assert.doesNotThrow(() => publishInvoicesChanged(undefined));
});

/** كل مسارٍ يغيّر مدفوع فاتورة يبثّ — وبعد انتهاء معاملته */
function assertPublishAfter(src: string, anchor: string, marker: RegExp, label: string) {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `${label}: تعذّر إيجاد المسار`);
  const body = src.slice(i);
  const pub = body.search(/publishInvoicesChanged\(/);
  const m = body.search(marker);
  assert.ok(pub > 0 && m > 0, `${label}: لا بثّ لحظيّ`);
  assert.ok(pub < m, `${label}: البثّ بعد الردّ أو خارج المسار`);
  const tx = body.lastIndexOf('$transaction', pub);
  const txEnd = body.lastIndexOf('});', pub);
  assert.ok(tx < 0 || txEnd > tx, `${label}: البثّ داخل المعاملة — قبل الالتزام`);
}

test('إصدار السند وإلغاؤه يبثّان', () => {
  const r = read('routes/receipts.ts');
  assert.match(r, /import \{ publishInvoicesChanged \} from '\.\.\/services\/liveEvents'/);
  assertPublishAfter(r, "router.post('/'", /res\.status\(201\)\.json/, 'إصدار السند');
  assertPublishAfter(r, "router.patch('/:id/cancel'", /res\.json\(\{ success: true, data: updated \}\)/, 'إلغاء السند');
});

test('الفاتورة الجديدة وإلغاؤها يبثّان', () => {
  const r = read('routes/invoices.ts');
  assertPublishAfter(r, "router.post('/'", /res\.status\(201\)\.json\(\{ success: true, data: invoice \}\)/, 'إصدار الفاتورة');
  assertPublishAfter(r, "router.patch('/:id/cancel'", /res\.json\(\{ success: true, data: updated \}\)/, 'إلغاء الفاتورة');
});

test('الدفعة الإلكترونية واستردادها يبثّان — مصدرٌ لا شاشة له', () => {
  const p = read('services/paylink.ts');
  const confirm = p.slice(p.indexOf('export async function confirmLinkPayment'), p.indexOf('export async function reverseLinkPayment'));
  assert.match(confirm, /publishInvoicesChanged\(link\.tenantId\);\s*return \{ ok: true, state: 'paid'/, 'تأكيد الدفع الإلكتروني لا يبثّ');
  const reverse = p.slice(p.indexOf('export async function reverseLinkPayment'));
  assert.match(reverse, /publishInvoicesChanged\(link\.tenantId\);\s*return \{ ok: true, state: 'refunded' \}/, 'الاسترداد لا يبثّ');
});

test('القناة مصادَق عليها، ولا يحبسها الضغط، ومسجَّلة خلف محدّد المعدّل', () => {
  const route = read('routes/live.ts');
  assert.match(route, /router\.get\('\/stream', authenticate,/, 'القناة بلا مصادقة');
  assert.match(route, /'Cache-Control', 'no-cache, no-transform'/, 'بلا no-transform يحبس compression الإطارات');
  assert.match(route, /'Content-Type', 'text\/event-stream/);
  assert.match(route, /req\.on\('close', close\)/, 'اتصالٌ مغلق لا يُلغى تسجيله — تسرّب مستمعين');
  const index = read('index.ts');
  const limiter = index.indexOf("app.use('/api', apiLimiter);");
  const live = index.indexOf("app.use('/api/live', liveRouter);");
  assert.ok(limiter > 0 && live > limiter, 'القناة غير مسجّلة أو قبل محدّد المعدّل');
});

/* ═══ خادم HTTP حقيقيّ: الإطارات تعبر compression لحظتها، والانقطاع أثناء المصادقة لا يسرّب ═══ */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import compression from 'compression';
import { liveStreamHandler } from '../routes/live';

function liveApp(authDelayMs: number, tenantId: string) {
  const app = express();
  app.use(compression());
  app.get('/stream', (req, _res, next) => {
    setTimeout(() => {
      (req as unknown as { user: unknown }).user = { id: 'u1', role: 'ADMIN', name: 'x', tenantId };
      next();
    }, authDelayMs);
  }, (req, res) => liveStreamHandler(req as never, res));
  const server = http.createServer(app);
  return new Promise<{ server: http.Server; port: number }>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

test('HTTP: «ready» ثم حدث الفواتير يصلان فوراً عبر compression — لا يُحبسان في مخزن الضغط', async () => {
  const tid = 'T-http-1';
  const { server, port } = await liveApp(0, tid);
  const chunks: string[] = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/stream', headers: { 'Accept-Encoding': 'gzip' } });
  const res = await new Promise<http.IncomingMessage>(r => req.on('response', r));
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['content-encoding'], undefined, 'القناة مضغوطة — الإطارات تُحبس حتى يمتلئ المخزن');
  res.setEncoding('utf8');
  res.on('data', (c: string) => chunks.push(c));
  const waitFor = async (re: RegExp) => {
    for (let i = 0; i < 100; i++) { if (re.test(chunks.join(''))) return true; await new Promise(r => setTimeout(r, 10)); }
    return false;
  };
  assert.ok(await waitFor(/event: ready\n/), 'لم يصل «ready»');
  assert.equal(liveListenerCount(tid), 1);
  publishInvoicesChanged(tid);
  assert.ok(await waitFor(/event: invoices\n/), 'حدث الفواتير لم يصل خلال ثانية');
  req.destroy();
  for (let i = 0; i < 100 && liveListenerCount(tid) > 0; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(liveListenerCount(tid), 0, 'اتصالٌ أُغلق بقي مسجَّلاً');
  await new Promise(r => server.close(r));
});

test('HTTP: عميلٌ انقطع أثناء المصادقة البطيئة لا يبقى مستمعاً معلّقاً', async () => {
  const tid = 'T-http-2';
  const { server, port } = await liveApp(250, tid);
  const req = http.get({ host: '127.0.0.1', port, path: '/stream' });
  req.on('error', () => { /* الإلغاء المتعمّد */ });
  await new Promise(r => setTimeout(r, 60));
  req.destroy();                                   // يُلغى قبل انتهاء «المصادقة»
  await new Promise(r => setTimeout(r, 450));      // وصل المعالج بعد الإغلاق
  assert.equal(liveListenerCount(tid), 0, 'تسرّب: مستمعٌ لمقبسٍ ميّت لن يُلغى تسجيله أبداً');
  await new Promise(r => server.close(r));
});
