// «تتبّع اللوط» — حرّاس نصّية للحزمة B4 (المواصفة §٨.٣). نائبٌ سجّله الأساس (P0) في backend/package.json؛ تملكه B4.
import { test } from 'node:test';

test.todo('B4: POST /van-stock/loads: قفل الدلو ثم lockLotProducts( ثم assertOutAvailable ثم planVanMovementInTx ثم createLoad');
test.todo('B4: مسار التحميل لا يستدعي دوال اللوط إلا داخل شرط العلم (R1)، ونداء vanLoad.create واحد');
