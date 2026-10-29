// «تتبّع اللوط» — فواتير المرحلة الأولى (المواصفة §٨.٢ lots-invoices). نائبٌ سجّله الأساس (P0) في backend/package.json؛
// تملكه الحزمة B5 (services/lotsInvoice.ts، routes/invoices.ts، services/invoiceExpiry.ts).
import { test } from 'node:test';

test.todo('B5: البيع للمندوب والإدارة والمفتاح (الصريح للإدارة والمفتاح، ويُهمل للمندوب حيّاً)');
test.todo('B5: تجاهل canSellWithoutStock للمتتبَّع وحده؛ غير المتتبَّع على القاعدة القديمة حرفياً');
test.todo('B5: يوم الخادم في المسار الحيّ (D23)');
test.todo('B5: الإعادة بالطبقات والتلميح، والحجز للمراجعة 409 LOT_REPLAY_HELD مع إشعارٍ واحد لكل clientRef');
test.todo('B5: المرتجع المرتبط بالترتيب الهجين، وختم expirySaleInvoiceId');
test.todo('B5: المرتجع الحرّ (المندوب غير معروف؛ الإدارة صريح) وختمه قبل المعاملة');
test.todo('B5: إلغاء المرتجع (المسمّى والفارغ، I1 وI2) وrestock إلى false');
test.todo('B5: ClientRefRace يصير 200 بالفاتورة القائمة');
test.todo('B5: LotError بالرمز، و55P03 يصير 503 LOT_BUSY');
test.todo('B5: الختم اللاحق يتخطّى البنود المختومة (expiresAt != null)');
