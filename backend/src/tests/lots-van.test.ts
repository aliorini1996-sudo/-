// «تتبّع اللوط» — حركات السيارة (المواصفة §٨.٢ lots-van). نائبٌ سجّله الأساس (P0) في backend/package.json؛ تملكه الحزمة B4
// وتستبدل بالبنود المعلّقة اختباراتها فوق Prisma مزيّف (services/lotsVan.ts، routes/vanStock.ts).
import { test } from 'node:test';

test.todo('B4: التحميل بالمستودع (viaWarehouse = true) وبدونه (D4، viaWarehouse = false)');
test.todo('B4: D18 — التحميل قبل وارد التشغيلة يُرفض');
test.todo('B4: المندوب في شركة بلا مستودع ⇒ LOT_REQUIRED «تحميل الأصناف المتتبَّعة يتم من لوحة الإدارة»');
test.todo('B4: التنزيل بمصدر واحد (تلقائي) وبأكثر من مصدر (LOT_REQUIRED بالقائمة)');
test.todo('B4: الإزالة تحت قفل الدلو ثم قفل اللوط، وassertOutAvailable بعد أول pg_advisory_xact_lock');
test.todo('B4: إتلاف المنتهي غير المباع بوسم EXPIRED_UNSOLD_DESTROY');
test.todo('B4: السيارة المحذوفة (D30) — UNLOAD إداري غير مقيّد بلوطات صريحة');
test.todo('B4: suggestAccuracy — تحميل بلوطين يعطي الدقة نفسها (D2)');
test.todo('B4: GET /van-stock/lot-balances — المندوب سيارته، والإداري بالنطاق، والمطفأ LOTS_NOT_ALLOWED');
