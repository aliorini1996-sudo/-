// «تتبّع اللوط» — إصدار المرحلة الثانية والإشعار الدائن (المواصفة §٨.٢ lots-phase2). نائبٌ سجّله الأساس (P0) في
// backend/package.json؛ تملكه الحزمة B6 (routes/invoicesZatca.ts، routes/invoicesNotes.ts، routes/invoicesZatcaDeps.ts).
import { test } from 'node:test';

test.todo('B6: precheck قبل openIssuanceSigning — ما سيُرفض حتماً لا يُوقَّع');
test.todo('B6: allocateInTx داخل createInvoice قبل afterDocument (ترتيب stampInTx محفوظ)');
test.todo('B6: الإشعار الدائن يرث من الأصل المقفل بـvanKey مندوب الإشعار');
test.todo('B6: الإشعار المدين بلا توزيع (بنوده بلا صنف)');
test.todo('B6: اختبارات الفرع القائمة تنجح بلا حقن lots');
