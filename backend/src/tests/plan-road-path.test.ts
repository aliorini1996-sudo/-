import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chunkWaypoints, planRoadPath, MAX_PLAN_STOPS } from '../services/planRoadPath';

// طلب المالك (٢١ نوفمبر ٢٠٢٦): خط السير المخطَّط على خريطة التتبّع يتبع الشوارع لا الخطوط المستقيمة

test('الدفعات تتشارك نقطة الوصل ولا تتجاوز السقف', () => {
  assert.deepEqual(chunkWaypoints([1, 2, 3], 14), [[1, 2, 3]]);
  const c = chunkWaypoints(Array.from({ length: 30 }, (_, i) => i), 14);
  assert.deepEqual(c.map(x => x.length), [14, 14, 4]);
  assert.equal(c[1][0], c[0][13]); assert.equal(c[2][0], c[1][13]);
  assert.deepEqual(chunkWaypoints([1]), []);
});

const P = (i: number) => ({ lat: 24.7 + i / 100, lng: 46.6 + i / 100 });

test('كل دفعةٍ تُوجَّه على الشوارع وتُوصل بلا تكرار نقطة الوصل، والمفتاح بالشركة', async () => {
  const keys: string[] = [];
  const fake = async (wps: { lat: number; lng: number }[], key?: string) => {
    keys.push(key!);
    // «طريق» بين أول الدفعة وآخرها بنقطةٍ وسطى
    const a = wps[0], b = wps[wps.length - 1];
    return [a, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 + 0.001 }, b];
  };
  const r = await planRoadPath(Array.from({ length: 20 }, (_, i) => P(i)), 'tenant-1', fake);
  assert.ok(r);
  assert.equal(r!.degraded, false);
  assert.equal(keys.length, 2);
  assert.ok(keys.every(k => k.startsWith('tenant-1:plan:')));
  assert.equal(r!.points.length, 5, 'دفعتان × ٣ نقاط − نقطة الوصل المكرّرة');
  assert.deepEqual(r!.points[0], P(0)); assert.deepEqual(r!.points[r!.points.length - 1], P(19));
});

test('تعذّر التوجيه ⇒ خطٌّ مستقيم بين المحطّات و degraded، وأقلّ من محطّتين ⇒ null', async () => {
  const r = await planRoadPath([P(0), P(1), P(2)], 't', async () => null);
  assert.deepEqual(r, { points: [P(0), P(1), P(2)], degraded: true });
  assert.equal(await planRoadPath([P(0)], 't', async () => null), null);
  const thrown = await planRoadPath([P(0), P(1)], 't', async () => { throw new Error('x'); });
  assert.equal(thrown!.degraded, true);
  // ما بعد السقف يبقى مستقيماً معلَناً
  const many = await planRoadPath(Array.from({ length: MAX_PLAN_STOPS + 5 }, (_, i) => P(i)), 't', async (w) => w);
  assert.equal(many!.degraded, true);
  assert.deepEqual(many!.points[many!.points.length - 1], P(MAX_PLAN_STOPS + 4));
});

test('مصدر: /rep-routes/mine يعيد roadPath للإدارة وحدها بـ?shape=1', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'routes', 'repRoutes.ts'), 'utf8');
  assert.match(src, /const roadPath = !isRep && req\.query\.shape === '1'/);
  assert.match(src, /\.\.\.\(roadPath !== undefined \? \{ roadPath \} : \{\}\)/);
});
