// «تتبّع اللوط» — موجّه /api/lots (المواصفة §٨.٢ lots-api). نائبٌ سجّله الأساس (P0) في backend/package.json؛ تملكه الحزمة B2
// (routes/lots.ts، services/lotsRelabel.ts، services/lotsTrace.ts).
import { test } from 'node:test';

test.todo('B2: الحرّاس بالترتيب — authenticate، رفض SALES_REP، requireLots، canManageVanStock');
test.todo('B2: LOT_SCOPED_USER لمدّ الانتهاء وتغيير الحالة، وLOT_REASON_REQUIRED');
test.todo('B2: D27 — لا تسمية ولا إعادة تصنيف من موقوف أو منتهٍ');
test.todo('B2: المسارات الثابتة قبل /:id');
test.todo('B2: LotEvent يُكتب لكل تغيير');
test.todo('B2: التتبّع STRICT يُدرج صافي الصفر، وBROAD بنافذة رصيد الصنف');
test.todo('B2: /lots/products/tracking — دفعات ١٠٠ بأقفال مرتّبة، وneedsAttention بالسالب وغير المسمّى');
