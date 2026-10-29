// «تتبّع اللوط» — حرّاس نصّية للحزمة B5 (المواصفة §٨.٣). نائبٌ سجّله الأساس (P0) في backend/package.json؛ تملكه B5.
import { test } from 'node:test';

test.todo('B5: جرد كتّاب invoiceItem — أي موضع جديد يُفشل الاختبار حتى يعيد التوزيع تحت القفل (§٤.١٥)');
test.todo('B5: مواضع invoice.create الثلاثة تدمج invoiceItemLotColumns بعد linkedExpiry');
test.todo('B5: مسار الإصدار لا يستدعي دوال اللوط إلا داخل شرط العلم (R1)، وغير المتتبَّع بلا خيار مهلة جديد');
test.todo('B5: stampInvoiceExpiry يرشّح بـexpiresAt == null');
test.todo('B5: acquireLotQueue قبل withNumberRetry ويُحرَّر في finally');
