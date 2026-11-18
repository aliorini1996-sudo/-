import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NO_CAMERA_HINT, NO_CAMERA_MSG, cameraCaptureCrashes } from './appCamera';
import { PHRASES } from '../i18n/strings';

// وكيل تطبيق «إدارة» على الآيفون كما يبنيه WebView.swift في فرع ios-admin-app
const ADMIN_10 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1 FieldSalesAdmin';
const SRC = path.resolve(process.cwd(), 'src');
const src = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('تطبيق الإدارة 1.0.x على الآيفون بلا إذن كاميرا ⇒ لا تصوير، والإصدار الحامل FSCam يعيده', () => {
  assert.equal(cameraCaptureCrashes(ADMIN_10), true);
  assert.equal(cameraCaptureCrashes(`${ADMIN_10} FSCam/1`), false);
  assert.equal(cameraCaptureCrashes(`${ADMIN_10} FSCam/2`), false);
});

test('غير تطبيق الإدارة لا يتأثّر: تطبيق المندوب وسفاري وأندرويد وسطح المكتب (ويندوز وElectron) والوكيل الفارغ', () => {
  for (const ua of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1 FieldSales',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    // تطبيق سطح المكتب (Electron) يُلحق اسمه بشرطة الإصدار — ليس غلاف الآيفون
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) FieldSalesAdmin/1.0.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36',
    '',
  ]) assert.equal(cameraCaptureCrashes(ua), false, ua);
  assert.equal(cameraCaptureCrashes('x FieldSalesAdminX'), false);
});

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []);

test('كل خانة صورٍ في /m محروسة: capture خلف cameraCaptureCrashes، وخانة الاستديو بتلميح NO_CAMERA_HINT', () => {
  const files = walk(path.join(SRC, 'm'));
  assert.ok(files.length > 10);
  let images = 0;
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SRC, f);
    if (!/<input[^>]*type="file"[^>]*accept="image\//.test(s)) continue;
    images++;
    assert.match(s, /cameraCaptureCrashes\(\)/, rel);
    assert.match(s, /NO_CAMERA_HINT/, rel);
    if (s.includes('capture=')) assert.match(s, /NO_CAMERA_MSG/, rel);
  }
  assert.ok(images >= 2, 'MPurchaseAttachments وإيصال الإيداع في MSalesReps');
});

test('أزرار التصوير في المكوّنات المشتركة محروسة كذلك (سطح المكتب والمندوب لا تتأثّر)، والنصّان مترجمان', () => {
  for (const rel of ['m/MPurchaseAttachments.tsx', 'components/PurchaseAttachmentsPicker.tsx', 'components/CustomerDocsPicker.tsx',
    // صينية مستندات «المحاسب الذكي AI» — مشتركةٌ بين الويب و/m (compact)، فتطبيق الإدارة 1.0.x على الآيفون يمرّ منها
    'components/aiAccountant/docs/AttachTray.tsx']) {
    const s = src(rel);
    assert.match(s, /cameraCaptureCrashes\(\)/, rel);
    assert.match(s, /NO_CAMERA_MSG/, rel);
    assert.equal((s.match(/capture="environment"/g) ?? []).length, 1, rel);
  }
  for (const key of [NO_CAMERA_MSG, NO_CAMERA_HINT]) {
    const p = PHRASES[key];
    assert.ok(p && p.en && p.fr && p.tr && p.zh, key);
    assert.ok(!p.fr.includes("'"), key);
  }
});

/** خانات الملفات في JSX: الوسم `<input … />` كاملاً — السهم `=>` في معالجٍ داخله لا يقطعه كما يقطع `[^>]*` */
const fileInputs = (s: string) => [...s.matchAll(/<input\b[\s\S]*?\/>/g)].map(m => m[0]).filter(t => /\btype="file"/.test(t));
const acceptOf = (tag: string) => /\baccept="([^"]*)"/.exec(tag)?.[1];

test('صينية مستندات المحاسب الذكي: تصويرٌ واحد محروس، والاستديو صورٌ بتلميح NO_CAMERA_HINT تحته، وخانة PDF لا تقبل إلا PDF', () => {
  const s = src('components/aiAccountant/docs/AttachTray.tsx');
  const inputs = fileInputs(s);
  assert.equal(inputs.length, 3, 'ثلاث خانات كبقيّة المنتقيات: تصوير، من الاستديو، ملف PDF');
  for (const t of inputs) assert.ok(acceptOf(t) !== undefined, `accept نصٌّ حرفيّ يُقرأ هنا: ${t}`);

  const camera = inputs.filter(t => t.includes('capture='));
  assert.equal(camera.length, 1, 'خانة تصويرٍ واحدة');
  assert.match(camera[0], /capture="environment"/);
  assert.equal(acceptOf(camera[0]), 'image/*');

  const gallery = inputs.filter(t => !t.includes('capture=') && /^image\//.test(acceptOf(t) ?? ''));
  assert.equal(gallery.length, 1, 'الاستديو صورٌ بلا capture');
  assert.doesNotMatch(acceptOf(gallery[0]) ?? '', /pdf/i);

  const pdf = inputs.filter(t => /pdf/i.test(acceptOf(t) ?? ''));
  assert.equal(pdf.length, 1, 'خانة PDF واحدة لا تشاركها الصور');
  const tokens = (acceptOf(pdf[0]) ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  assert.ok(tokens.includes('application/pdf'), tokens.join(','));
  assert.ok(tokens.every(x => x === 'application/pdf' || x === '.pdf'), `خانة PDF تقبل غيره: ${tokens.join(',')}`);
  assert.ok(!pdf[0].includes('capture='));

  // الرسالة على زرّ التصوير (الحارس العامّ أعلاه)، والتلميح يُرسم بعد خانة الاستديو — تحته لا فوقه
  assert.match(s, /cameraCaptureCrashes\(\)/);
  assert.ok(s.lastIndexOf('NO_CAMERA_HINT') > s.indexOf(gallery[0]), 'NO_CAMERA_HINT تحت خانة الاستديو');
});
