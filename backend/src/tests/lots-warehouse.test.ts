// «تتبّع اللوط» — وارد المستودع وتسوياته (المواصفة §٨.٢ lots-warehouse). نائبٌ سجّله الأساس (P0) في backend/package.json؛
// تملكه الحزمة B3 (services/lotsWarehouse.ts، routes/warehouse.ts).
import { test } from 'node:test';

test.todo('B3: الوارد لصنف متتبَّع يلزمه lotId أو lotNumber (LOT_REQUIRED)، والانتهاء إلزامي مع الصلاحية');
test.todo('B3: الوارد إلى لوطٍ موقوف مقبول بتحذير LOT_INTO_BLOCKED');
test.todo('B3: تسوية النقص بالتجميع (D26) تحت القفل، وpickOutSources على المستودع');
test.todo('B3: غير المتتبَّع والميزة المطفأة كما هما حرفياً (warehouse.test.ts:51-54 ناجح)');
test.todo('B3: الردّ 201 وGET /entries يضمّان lot حين الميزة مفعّلة، وGET /warehouse/vans بـlotQuarantined وlotHeld');
