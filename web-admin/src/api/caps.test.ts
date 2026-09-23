// قدرات الحزمة (ZATCA المرحلة الثانية، نقد الخطة 1): الترويسة تُرسَل من **كل** عملاء المنصّة في الإصدار نفسه —
// لوحة الإدارة و`/m` (api/client.ts) وتطبيق المندوب (rep/repApi.ts). لو نقصت من أحدهم ردّ الخادم 426 على كل فاتورة منه.
// نصّي على المصدر (لا axios ولا متصفّح) + سلوك قارئ القائمة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAP_ZATCA2, FS_CAPS, FS_CAPS_HEADER, FS_CAPS_VALUE, capsInclude } from './caps';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

test('اسم الترويسة وقيمتها', () => {
  assert.equal(FS_CAPS_HEADER, 'X-FS-Caps');
  assert.equal(CAP_ZATCA2, 'zatca2');
  assert.ok(FS_CAPS.includes(CAP_ZATCA2));
  assert.equal(FS_CAPS_VALUE, FS_CAPS.join(','));
  assert.ok(capsInclude(FS_CAPS_VALUE, CAP_ZATCA2), 'القيمة المُرسَلة لا تُعلن zatca2');
});

test('قارئ القائمة: فواصل ومسافات وفواصل منقوطة وحالة الأحرف، ولا مطابقة جزئية', () => {
  for (const v of ['zatca2', 'ZATCA2', 'x,zatca2', 'x zatca2', 'x; zatca2 ;y', ' zatca2 ']) {
    assert.ok(capsInclude(v, 'zatca2'), `فشل في «${v}»`);
  }
  for (const v of ['', 'zatca', 'zatca22', 'xzatca2', 'zatca2x', null, undefined]) {
    assert.equal(capsInclude(v as string | null | undefined, 'zatca2'), false, `طابق خطأً «${String(v)}»`);
  }
});

test('عميلا axios كلاهما يرسل الترويسة من المصدر المشترك', () => {
  for (const f of ['api/client.ts', 'rep/repApi.ts']) {
    const s = read(f);
    assert.match(s, /from '\.\.?\/(api\/)?caps'/, `${f}: لا يستورد قائمة القدرات`);
    assert.match(s, /\[FS_CAPS_HEADER\]:\s*FS_CAPS_VALUE/, `${f}: الترويسة غير مضبوطة على نسخة axios`);
    // على نسخة axios نفسها لا على نداءٍ بعينه: كل نداء من الحزمة يحملها (ومنه GET /invoices/:id للطباعة)
    const create = s.slice(s.indexOf('axios.create('), s.indexOf('});', s.indexOf('axios.create(')));
    assert.match(create, /FS_CAPS_HEADER/, `${f}: الترويسة خارج axios.create`);
  }
});

test('لا نسخة axios ثالثة بلا قدرات في مسارات الفواتير', () => {
  // أيّ نسخة أخرى تُنشأ لاحقاً يجب أن تمرّ على api/caps.ts — هذا الحارس يمسك إنشاءها
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist'].includes(e.name)) walk(p, out); }
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const creators = walk(SRC).filter(p => /axios\.create\(/.test(fs.readFileSync(p, 'utf8')));
  const rel = creators.map(p => path.relative(SRC, p).split(path.sep).join('/')).sort();
  // منصّتان مستقلّتان لا تُصدران فواتير ولا تقرآنها: بوابة السفير (/ax) ومنصّة الصيد (/hx)
  assert.deepEqual(rel, ['affiliate/api.ts', 'api/client.ts', 'hunter/HunterApp.tsx', 'rep/repApi.ts'],
    `نسخ axios تغيّرت — إن كانت الجديدة تمسّ الفواتير فأضف إليها الترويسة: ${rel.join('، ')}`);
  for (const f of ['affiliate/api.ts', 'hunter/HunterApp.tsx']) {
    assert.doesNotMatch(read(f), /\/invoices\b/, `${f} صار يمسّ الفواتير — يلزمه إعلان القدرات`);
  }
});
