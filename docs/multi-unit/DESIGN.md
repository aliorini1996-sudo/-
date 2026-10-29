# الوحدات المتعددة للصنف — عقد التصميم

> المرجع الواحد لكل من ينفّذ جزءاً من الميزة. أي انحراف عنه يُكتب هنا أولاً.

## المشكلة
صنفٌ يُباع بالكرتون (٢٤ حبة)، ثم يُرجَع منه حبّة واحدة. للصنف اليوم وحدة واحدة،
فإرجاع «١» = كرتون كامل (خطأ ٢٤ ضعفاً)، و«٠٫٠٤١٧» يُفسد المخزون والتقارير بالكسور.

## المبدأ
- لكل صنف **وحدة أساس** = أصغر ما يُباع منه (`Product.unit`، وسعرها `Product.basePrice`).
- ووحدات أكبر في `ProductUnit` بمعامل تحويل **صحيح موجب** (`factor` = عدد وحدات الأساس فيها) وسعرٍ اختياري.
- كل صفٍّ يحمل كمية يحمل **لقطة** وحدته: `unitName` و`unitFactor` (افتراض ١ = الأساس).
- `baseQty` = `qty × unitFactor` — **عمود مشتقّ تحرسه القاعدة** بمُطلِق (`scripts/backfillBaseQty.ts`):
  يُحسب عند كل إدراج وتحديث، فلا يكون فارغاً ولا قديماً حتى لو كتبت النسخة القديمة أثناء النشر.

## القواعد الذهبية (لكل منفّذ)
1. **كل جمعٍ أو مقارنةٍ لكمية = بالأساس.** في الذاكرة: `baseQtyOf(row)` من `services/units.ts`
   (أو `web-admin/src/lib/units.ts`). في تجميعات القاعدة: `_sum: { baseQty: true }` بدل `_sum: { qty: true }`.
   مستحيلٌ أن يبقى `qty` خاماً في جمعٍ يخلط صفوفاً قد تختلف وحداتها.
2. **`qty` يبقى بوحدة الصفّ** كما كتبه المستخدم وكما يُطبع. لا تُحوِّل `qty` إلى الأساس قبل حساب
   الفاتورة (`invoiceCalc`) — وإلا اختلف تقريب الورقة المطبوعة أوف‑لاين عن سجلّ الخادم.
3. **الأسعار على الصفوف (`unitPrice`, `unitCost`) لوحدة الصفّ.** السعر/التكلفة لوحدة الأساس = القيمة ÷ `unitFactor`.
4. `Product.basePrice` و`CustomerPrice.price` و`PriceTier.price` **لوحدة الأساس**. سعر وحدةٍ ما:
   `unitPriceOf(unit, basePrice)` (سعرها المحدَّد، وإلّا الأساس × المعامل). سعر العميل لوحدة = سعره × المعامل.
5. `PriceTier.baseMinQty/baseMaxQty` حدود الشريحة **بالأساس** (والعمودان القديمان `minQty/maxQty` للعرض القديم).
   عند كتابة شريحة: اكتب الاثنين.
6. **كتابة صفٍّ ذي كمية**: `...unitFields(qty, { name, factor })` من `services/units.ts` (يعطي qty وunitName وunitFactor وbaseQty).
   الخادم **يحلّ** المعامل من `ProductUnit` بمعرّفها (`unitId` في الجسم) — لا يثق برقمٍ يرسله العميل.
   `unitId` غائب أو لا يخصّ الصنف ⇒ وحدة الأساس بمعامل ١ (سلوك ما قبل الميزة).
7. **إعادة الرفع أوف‑لاين (`X-FS-Replay`)**: لا يُرفض مستند لأن وحدته أُوقفت أو تغيّر معاملها بعد إصداره
   على الجهاز. إن حمل الجسم `unitName/unitFactor` (لقطة الجهاز) تُقبل بعد التحقق أنها كانت للصنف.
8. **العرض**: كمية مخزون/تقرير بالأساس ⇒ `formatQty(baseQty, product.units, product.unit)` = «٢ كرتون و٣ حبة».
   بند مستند ⇒ `qty` + `unitName ?? product.unit` (اللقطة لا وحدة الصنف الحالية — وحدة الصنف صارت الأساس).
9. **المرتجع المرتبط ببند بيع**: المتاح والمقارنة بالأساس (`services/returnLinks.ts`). وسعره يحسبه **الخادم**
   من البند المباع: `refundAmount(line, returnBase, alreadyReturnedBase)` — فرق تراكميَّين مقرَّبين،
   فـ٢٤ حبة فرادى = قيمة البند تماماً (لا ١٠٫٠٨). لا يثق بسعر مرتجعٍ مرتبط من العميل.
10. **ZATCA**: رمز وحدة البند (`InvoiceItem.unitCode`) من `ProductUnit.unitCode`، وإلا رمز الصنف، وإلا PCE.
    الكمية والسعر في XML بوحدة البند (متّسقان). الإشعار الدائن على بند كرتون بالحبة: كميته وسعره بوحدة الإشعار
    والمتاح بالأساس.
11. **لا تحرّر** `web-admin/src/i18n/strings.ts` ولا `backend/package.json` ولا `web-admin/src/api/client.ts`
    ولا `web-admin/src/types/index.ts` ولا `prisma/schema.prisma` — أعِد ما تحتاجه في تقريرك ويُدمج مركزياً.

## عقد الـAPI
- `GET /products`, `GET /products/:id`: يُرفق `units: ProductUnit[]` (النشطة والموقوفة، مرتّبة `sortOrder` ثم المعامل).
- `POST /products/:id/units` `{name, factor, price?, unitCode?}` → 201. يتحقق بـ`unitProblem`. صلاحية `canManageProducts`.
- `PUT /products/:id/units/:unitId` `{name?, factor?, price?, unitCode?, isActive?, sortOrder?}`.
- `DELETE /products/:id/units/:unitId` — حذف فعلي (الصفوف تحمل لقطتها فلا ينكسر تاريخ).
- `POST /products/:id/convert-base` `{newBaseName, factor, expectedBaseName, basePrice?}` — داخل معاملة بقفل صفّ الصنف:
  1. `409` إن `product.unit !== expectedBaseName` (يمنع التحويل المزدوج).
  2. صفوف الصنف في الجداول الأربعة: `unitName = COALESCE(unitName, oldUnit)`، `unitFactor = unitFactor × F`
     (والمُطلِق يعيد حساب `baseQty`). **الأرقام المطبوعة لا تتغيّر.**
  3. وحدات الصنف القائمة: `factor × F`. ووحدةٌ جديدة باسم الوحدة القديمة، معامل F، **بسعرها القديم** (`oldBasePrice`)،
     ورمزها الضريبي = رمز الصنف.
  4. `CustomerPrice.price ÷ F` و`PriceTier.price ÷ F` و`baseMinQty/baseMaxQty × F` (لوحدة الأساس الجديدة —
     سعر الكرتون للعميل يبقى كما هو حين يُضرب في المعامل).
  5. `Product.unit = newBaseName`، `Product.basePrice = basePrice ?? round4(oldBasePrice ÷ F)`.
  والوحدة الافتراضية في البيع بعد التحويل = الوحدة الأكبر (الكرتون)، فلا يتغيّر عمل المندوب اليومي.
- جسم البنود (`POST /invoices`، تحميل السيارة، وارد المستودع، طلب البضاعة): `unitId?` لكل بند.
- `GET /invoices/:id/returnable`: لكل بند بيع: `unitName, unitFactor, soldBase, returnedBase, returnableBase,
  lineTotal, refundPerBase` ومعها `product.units` و`product.unit`.

## قرارات أثناء التنفيذ
- **وحدةٌ غير صالحة في مسارٍ حيّ ⇒ 400 `UNIT_INVALID`** (unitId لصنفٍ آخر أو موقوف أو لشركة أخرى). الصمت والقراءة
  بالأساس يحمّلان كرتوناً على أنه حبة. **إعادة الرفع أوف‑لاين وحدها** تقبل لقطة الجهاز (القاعدة ٧).
- `WarehouseEntryItem.unitCost` لوحدة السطر كما في فاتورة المورّد؛ وتكلفة الأساس = القيمة ÷ المعامل **بلا تقريب عند
  القراءة** (`unitCostPerBase` في `services/warehouseCost.ts`). و`avgCost`/`stockValue` في المستودع لوحدة الأساس.
- `VanLoadItem.suggestedQty/expectedQty` تُخزَّن **بالأساس دائماً**.
- طلب البضاعة سطرٌ واحد لكل صنف (المفتاح الفريد): أسطر الصنف بوحدةٍ واحدة تُجمع بها، وبوحداتٍ مختلفة تصير سطراً بالأساس.
  وفي تعديل الإدارة: `unitId` **غائب = وحدة سطر المندوب**، و`null` = الأساس صراحةً.
- مجاميع ملخّص السيارات عبر الأصناف (`totalRemaining`…) بوحدات الأساس.
- حمولة ERP/Odoo (payloadVersion 3): البند **بوحدة الأساس** وسعره ÷ المعامل مقرَّباً لأعلى لخانتين، والمطبوع في `lineUnit`
  (انظر رأس `services/erpPayload.ts`). تحويل وحدة أساس صنف لا يعيد كتابة فاتورة مرحَّلة في Odoo.

## المراحل
1. **الأساس** (✅ ‏47ce81a + إصلاح baseQty nullable والمُطلِق): `units.ts`، المخطّط، `returnLinks`، مسار الإصدار.
2. **التنفيذ الموزّع**: ZATCA والإشعارات، المخزون والتكلفة، التقارير والدفاتر، واجهة الأصناف والتحويل،
   التكاملات، تطبيق المندوب، لوحة الويب، تطبيق الجوال.
3. **الدمج المركزي**: الترجمات، تسجيل الاختبارات، الفحص الكامل.
4. **المراجعة العدائية** (مالٌ ومخزون) ثم الإصلاح ثم النشر بإذن المالك.
