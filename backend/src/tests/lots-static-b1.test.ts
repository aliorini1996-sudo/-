// «تتبّع اللوط» — حرّاس نصّية للحزمة B1 (المواصفة §٨.٣). نائبٌ سجّله الأساس (P0) في backend/package.json؛ تملكه B1.
import { test } from 'node:test';

test.todo('B1: erpPayload يستبعد lotTracked وlotTrackedSince (R4، §٥.٥)');
test.todo('B1: حذف الصنف يعدّ productLot ويؤرشف داخل معاملة بقفل FOR UPDATE');
test.todo('B1: حذف الشركة — حارس LOT_RECORDS_RETAINED (D31) وحذف جداول اللوط قبل الأصناف');
test.todo('B1: تبديل lotTracked بقفل FOR UPDATE ثم قفل اللوط، والحقبة عند كل انتقال إلى التفعيل');
