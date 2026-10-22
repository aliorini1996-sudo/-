import test from 'node:test';
import assert from 'node:assert/strict';
import { readLiveReps, FULL_LIVE_EVERY_MS, _resetLiveReads } from './trackingLive';

// الخريطة تُقرأ عند كل حدث «locations» (كل ١٠ث على الأكثر): المواقع وحدها بين قراءتين كاملتين كل دقيقة، فلا يُقرأ عدّاد
// زيارات اليوم (أثقل ما في المسار) كل ثوانٍ — ويُكمَل من القراءة السابقة.

type R = { id: string; lastLat: number; visitsToday?: number };

test('أول قراءة كاملة، وما بعدها خلال دقيقة خفيفةٌ يُكمَل عدّادها، وبعد دقيقة كاملة', async () => {
  _resetLiveReads();
  const calls: boolean[] = [];
  const full: R[] = [{ id: 'a', lastLat: 1, visitsToday: 3 }, { id: 'b', lastLat: 2, visitsToday: 0 }];
  const get = async (lite: boolean): Promise<R[]> => {
    calls.push(lite);
    return lite ? [{ id: 'a', lastLat: 1.5 }, { id: 'b', lastLat: 2.5 }, { id: 'c', lastLat: 9 }] : full;
  };
  const t0 = 1_000_000;
  const first = await readLiveReps('k', undefined, get, t0);
  assert.deepEqual(first, full);
  const second = await readLiveReps('k', first, get, t0 + 10_000);
  assert.deepEqual(second, [{ id: 'a', lastLat: 1.5, visitsToday: 3 }, { id: 'b', lastLat: 2.5, visitsToday: 0 }, { id: 'c', lastLat: 9, visitsToday: 0 }]);
  await readLiveReps('k', second, get, t0 + FULL_LIVE_EVERY_MS);
  assert.deepEqual(calls, [false, true, false]);
});

test('خادمٌ أقدم يتجاهل lite فيعيد العدّاد — يؤخذ كما جاء، والشاشتان لكلٍّ ذاكرتها', async () => {
  _resetLiveReads();
  const rows: R[] = [{ id: 'a', lastLat: 1, visitsToday: 7 }];
  const prev: R[] = [{ id: 'a', lastLat: 1, visitsToday: 2 }];
  await readLiveReps('web', undefined, async () => rows, 0);
  assert.deepEqual(await readLiveReps('web', prev, async () => rows, 1_000), rows);
  let lite: boolean | null = null;
  await readLiveReps('m', prev, async (l) => { lite = l; return rows; }, 1_000);
  assert.equal(lite, false, 'شاشة الجوال لم تقرأ كاملةً بعد');
});
