import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { trustProxy, isCloudflareIp, CLOUDFLARE_RANGES } from '../middleware/trustProxy';

// إصلاح ٢١ نوفمبر ٢٠٢٦ (طلب المالك): req.ip كان عنوان حافة Cloudflare فتقاسمت الشبكات حدود الدخول لكل IP

test('عناوين Cloudflare تُعرف (من السجلات الحيّة) وغيرها لا', () => {
  for (const ip of ['172.71.147.3', '172.68.234.201', '104.22.66.3', '162.158.1.1', '::ffff:172.71.146.144', '2606:4700::1'])
    assert.equal(isCloudflareIp(ip), true, ip);
  for (const ip of ['5.42.200.10', '10.0.0.5', '127.0.0.1', '2001:db8::1', '', 'abc', undefined])
    assert.equal(isCloudflareIp(ip as string), false, String(ip));
  assert.ok(CLOUDFLARE_RANGES.length >= 20);
});

async function ipFor(xff: string | null): Promise<string> {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/ip', (req, res) => { res.send(req.ip); });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/ip`, { headers: xff ? { 'x-forwarded-for': xff } : {} });
    return await res.text();
  } finally { server.close(); }
}

test('req.ip = المستخدم الحقيقي خلف Cloudflare، والتزوير بتجاوز Cloudflare لا ينفع', async () => {
  // المستخدم ← Cloudflare (يضيف المستخدم) ← Render (يضيف حافة Cloudflare) ← الخادم (القفزة الأولى المحلية هنا)
  assert.equal(await ipFor('5.42.200.10, 172.71.147.3'), '5.42.200.10');
  // تزويرٌ يسبق المستخدم يُتجاهل — Cloudflare يُلحق العنوان الحقيقي يميناً
  assert.equal(await ipFor('1.2.3.4, 5.42.200.10, 172.71.147.3'), '5.42.200.10');
  // تجاوز Cloudflare (onrender.com مباشرةً) مع X-Forwarded-For مزوّر: يتوقّف عند العنوان الذي أضافه Render
  assert.equal(await ipFor('1.2.3.4, 9.9.9.9'), '9.9.9.9');
  // بلا ترويسة: القفزة الأولى نفسها
  assert.match(await ipFor(null), /127\.0\.0\.1/);
});

test('مصدر: index.ts يستعمل trustProxy لا الرقم 1', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'index.ts'), 'utf8');
  assert.match(src, /app\.set\('trust proxy', trustProxy\);/);
  assert.doesNotMatch(src, /app\.set\('trust proxy', 1\)/);
});
