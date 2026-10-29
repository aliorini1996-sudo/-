// «تتبّع اللوط» — الاستيراد الافتتاحي والتراجع عنه (المواصفة §٨.٢ lots-import). نائبٌ سجّله الأساس (P0) في backend/package.json؛
// تملكه الحزمة B3 (routes/import.ts، services/importLedger.ts، services/lotsWarehouse.ts).
import { test } from 'node:test';

test.todo('B3: رموز الصفوف LOT_REQUIRED وLOT_DATES_INVALID وLOT_EXPIRY_REQUIRED وLOT_DATES_MISMATCH');
test.todo('B3: ملفٌ بلا أعمدة لوط يعطي البصمة نفسها');
test.todo('B3: الكتابة — lockLotProducts ثم entryId ثم resolveOrCreateLot بمصدر OPENING_IMPORT وsourceEntryId');
test.todo('B3: التراجع — قفل الأصناف قبل أي فحص (ن١-١١)، والمنع حين استُعملت التشغيلات، وحذف اليتيم مع LotEvent DELETE');
