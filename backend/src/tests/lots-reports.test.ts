// «تتبّع اللوط» — التقارير (المواصفة §٨.٢ lots-reports). نائبٌ سجّله الأساس (P0) في backend/package.json؛ تملكه الحزمة B8
// (routes/reports.ts).
import { test } from 'node:test';

test.todo('B8: GET /reports/lot-sales — المباع والمرتجع والصافي وعدد العملاء لكل لوط، بنطاق المستخدم');
test.todo('B8: withLots=1 في تقرير المرتجعات');
