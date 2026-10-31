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
12. **«الوحدة الرئيسية» عرضٌ وتعريفٌ وإدخالٌ افتراضي فقط** (`Product.primaryUnitId`، بلا مفتاح أجنبي عمداً).
    - لا يدخل أي جمعٍ ولا تقريبٍ ولا XML ولا حمولة ERP ولا LOT: الحساب الداخلي لا ينقلب. القارورة هي `unit/basePrice`،
      والكرتون صفّ `ProductUnit` بمعامل ٢٤ يشير إليه `primaryUnitId`. لا كسور (١/٢٤) في المخزون ولا الأسعار ولا الضريبة.
      يحرسه اختبار ثابت (`primary-unit-static.test.ts`): الاسم غائب عن `invoiceCalc` و`erpPayload` و`returnLinks`
      و`warehouseCost` و`lotsDb` و`lotsVan` و`lotsInvoice` و`ubl/xml`، وعن أجسام `toBase` و`baseQtyOf` و`unitFields`
      و`unitPriceOf` و`refundAmount` و`pickLineUnit` و`resolveLineUnit`.
    - **غياب `unitId` = الأساس دائماً**، ولو كانت الرئيسية كرتوناً: في API والأوف‑لاين والاستيراد. لا يفسّر الخادم بنداً
      بالرئيسية أبداً، وإلا صار كل جسم `{productId, qty}` قديم كراتين صامتة (×٢٤).
    - القراءة عبر `primaryUnitOf(p)` وحدها: معرّفٌ غائب أو لا يطابق وحدة أو موقوف أو بمعامل غير صحيح أو خارج ٢..`MAX_UNIT_FACTOR`
      ⇒ `null` ⇒ سلوك ما قبل الميزة حرفياً (تكافؤ الإطفاء I1).
    - العرض: `formatQty(baseQty, units, unit, primary)` يقف عند الرئيسية («52 كرتون و2 قارورة»، والصفر «0 كرتون»، وما دونها
      «5 قارورة»)، أو `productQtyText(baseQty, product)`. بلا رئيسية الناتج حرفياً كما كان. والمجاميع عبر أصناف مختلفة
      تبقى بالأساس موسومةً «بالوحدات الصغرى» حين في المجموع صنفٌ له رئيسية.
    - `unitChoices(p)[0]` يبقى الأساس دائماً. الرئيسية تتميّز بالافتراض (`defaultChoice`) وإبراز رقاقتها. وفي تطبيق المندوب
      قيد الوحدة من «قيود المندوب» يغلب الرئيسية (مقيّد بالصغرى ⇒ الافتراض الصغرى)، و«الكبرى» في تلك القيود تبقى الوحدات
      الأكبر من الأساس أيّاً كانت الرئيسية.
    - كائن الصنف في كل ردّ JSON يحمل دائماً `primaryUnitId` و`baseConvertedAt` (و`null` حين لا قيمة). وحمولة ERP تُسقطهما
      (`PRODUCT_DISPLAY_ONLY_KEYS` من `services/baseConversions.ts`)، فتبقى `payloadVersion 3` كما هي.
    - النصوص: كلمة «الأساس» لا تظهر في نصٍّ جديد للمستخدم ولا في نصٍّ يظهر لصنفٍ له رئيسية (المالك يسمّي الكرتون
      «المنتج الأساسي»): اسم الوحدة نفسه أو «الوحدة الصغرى». الرموز والحقول في API لا تتغيّر.
13. **كل كاتب لكمية أو سعر مرتبط بوحدة الأساس يقارن الأساس الذي حُلّت عليه مدخلاته بالأساس تحت قفل صفّ الصنف.**
    - المستندات والمخزون وأسعار العميل والاستيراد: `FOR KEY SHARE` عبر `lockBases` (`services/baseGuard.ts`)، أو
      `locked.units` من `lockLotProducts` في مسار LOT. إعدادات الصنف: `FOR UPDATE` (`lockProduct`) أو `FOR NO KEY UPDATE`
      (`lockProductForEdit` في `PUT /products/:id`، فلا ينتظر الفواتير).
    - كل قفل `FOR KEY SHARE` على `products` في مسار كتابة يأخذ `lock_timeout = LOT_LOCK_TIMEOUT` محلياً ثم يستعيده (I10)،
      وكل معاملة تفاعلية جديدة فيها `lockBases` تأخذ `BASE_GUARD_TX = { maxWait: 10_000, timeout: 20_000 }`.
    - هوية الأساس بالاسم، فكل مقارنة تمرّ من `baseNameKey(s) = String(s ?? '').trim().slice(0, 64)` على الطرفين.
    - **عقد الرموز:**

      | الحالة | الرمز |
      |---|---|
      | كاش قديم في مسار حيّ (`baseUnitName` ≠ أساس الصنف قبل المعاملة) | `400 UNIT_INVALID` |
      | سباق مع تحويل في كاتب مستند أو مخزون أو سعر عميل أو استيراد | `PRODUCT_UNITS_CHANGED`: `409` حيّاً، و`503` لإعادة الرفع |
      | انتظار قفل تحويل طويل، أو `55P03`/`40P01`/`P2028` | `503 PRODUCT_UNITS_BUSY` (وفي مسارات LOT: `LOT_BUSY`) |
      | كتابة إعداد صنف من نموذج قديم (الصنف، الوحدات، الشرائح، التحويل) | `409 BASE_UNIT_CHANGED` |
      | الرئيسية تغيّرت أو غير صالحة أو قيد الاستعمال | `409 PRIMARY_UNIT_CHANGED` / `400 PRIMARY_UNIT_INVALID` / `409 PRIMARY_UNIT_IN_USE` |
      | مفتاح API يكتب على صنف `baseConvertedAt ≠ null` بلا الأساس الصريح (D19) | `400 BASE_UNIT_REQUIRED` |
      | اسم أساس متقاعد (ظهر `fromUnit` في تحويلٍ بمعامل > ١ لهذا الصنف) | `409 BASE_NAME_RETIRED` |
      | استيراد بعمود وحدة فارغ لصنف له رئيسية صالحة أو تاريخ تحويل (D17) | خطأ صفّ `PRICE_UNIT_REQUIRED` / `QTY_UNIT_REQUIRED` |
      | رفض التحويل | `403 CONVERT_BASE_INTERACTIVE_ONLY` / `OWNER_ONLY` / `ROLE_FORBIDDEN` / `SCOPED_USER` / `FORBIDDEN`؛ `409 CONVERT_BASE_ERP_ACK` / `CONVERT_BASE_API_ACK` |

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
  **وبعد «الوحدة الرئيسية»** (القاعدتان ١٢ و١٣) يُضاف إلى التحويل:
  - اسمه في الواجهة «إضافة وحدة فرعية أصغر». الحارس `convertBaseRefusalFor(req)` قبل `convertBaseSchema.parse` حرفياً
    (`services/convertBaseAccess.ts`)، بالترتيب: مفتاح API ⇒ `403 CONVERT_BASE_INTERACTIVE_ONLY` دائماً (ولو أصدره المالك)؛
    جلسة المالك ✓؛ بوابة الإطلاق `CONVERT_BASE_OPEN_TO_COMPANY` (في الكود، `false` حتى المرحلة ٥) أو علم الشركة
    `Tenant.convertBaseOpen` (افتراضه `false`، يقلبه المالك لكل شركة) مغلقة ⇒ `OWNER_ONLY`؛ دور غير `ADMIN`/`MANAGER` أو حساب
    موقوف ⇒ `ROLE_FORBIDDEN`؛ مقيّد النطاق ⇒ `SCOPED_USER`؛ `false` في أيٍّ من `canManageProducts` و`canManageVanStock`
    و`canManageInvoices` ⇒ `FORBIDDEN`. بلا عمود صلاحية جديد (قرار المالك). والواجهة تقرأ `user.canConvertBase`
    و`convertBaseRefusalCode` من `adminPermissionFields` (الدخول والانتحال والتسجيل و`/me`).
  - `keepOldBaseAsPrimary` (افتراضه `true`): الوحدة التي صارتها الوحدة القديمة تصير الرئيسية حين لا رئيسية للصنف، فلا يتغيّر
    عرضه ولا إدخاله. ورئيسيةٌ قائمة (طبلية) تبقى بمعرّفها ومعاملها مضروباً بـF.
  - الخطوة ٤ تضرب أيضاً `minQty/maxQty` الشرائح بـF.
  - `dryRun`: لا معاملة ولا قفل ولا كتابة — عدّ بشروط WHERE نفسها، و`erpLinked` و`apiKeys: {write, readOnly}` و`primaryAfter`.
  - `acknowledgeErp` يلزم حين الشركة مربوطة بـERP (`409 CONVERT_BASE_ERP_ACK`)، و`acknowledgeApi` حين لها مفتاح نشط
    استُعمل في آخر ٣٠ يوماً (`409 CONVERT_BASE_API_ACK`، بعد إقرار ERP).
  - اسم أساس جديد ظهر `fromUnit` في تحويلٍ سابق بمعامل > ١ لهذا الصنف ⇒ `409 BASE_NAME_RETIRED` (يُسأل السجلّ حين
    `baseConvertedAt ≠ null` وحده).
  - في المعاملة نفسها: صفٌّ واحد في `ProductBaseConversion` (`fromUnit, toUnit, factor, fromUnitId, convertedAt, convertedBy`)
    و`Product.baseConvertedAt = now`، والردّ يحمل `converted.conversionId`.
  - `markConverting` قبل المعاملة و`unmarkConverting` في `finally` (`services/baseGuard.ts`): إسراعٌ يردّ به إصدار المرحلة
    الثانية `503` قبل الـmutex. القفل بمهلته هو الضامن.
- `POST /products` الموسَّع: `units[]` و`primaryUnitName` و`basePrice` الاختياري. **التفرّع على `primaryUnitName` وحده**:
  جسمٌ بلا `primaryUnitName` (ولو فيه `units` منسوخة من ردّ `GET`) يمرّ بالمسار القديم حرفياً ويُتجاهل فيه `units`. ومعه:
  الصنف ووحداته و`primaryUnitId` في معاملة واحدة، سعر الكرتون صريحاً على وحدته، و`basePrice` الغائب
  = `derivedBasePrice(سعر الرئيسية، معاملها)` = `roundHalfUp(p ÷ f, 4)` (16.33 ÷ 8 = 2.0413) — مثل الخطوة ٥ في التحويل ومثل
  الاستيراد. اسمٌ ليس من `units` ⇒ `400 PRIMARY_UNIT_INVALID`.
- `PUT /products/:id/primary-unit` `{unitId: string | null, expectedPrimaryUnitId?}`: علمٌ لا مال، بلا قفل تاريخ ولا ترحيل.
  تحت `lockProduct`: مفتاح `expectedPrimaryUnitId` حاضر ويخالف الحالي ⇒ `409 PRIMARY_UNIT_CHANGED`؛ وحدةٌ ليست نشطة من وحدات
  الصنف بمعامل صحيح ≥ ٢ ⇒ `400 PRIMARY_UNIT_INVALID`. `@updatedAt` يتحرّك. مفاتيح API مسموح لها.
- الوحدات: `POST /products/:id/units` + `makePrimary`؛ إيقاف الرئيسية (`PUT … {isActive:false}`) أو حذفها ⇒ `409 PRIMARY_UNIT_IN_USE`
  إلا مع `clearPrimary: true` (في الجسم) أو `?clearPrimary=1` (للحذف). وكتّاب الوحدات الثلاثة و`price-tiers` يقبلون
  `expectedBaseName` (`409 BASE_UNIT_CHANGED`؛ والحذف بلا جسم يقرؤه من الاستعلام `?expectedBaseName=`)، و`price-tiers` يقبل
  `expectedPrimary: {id, factor}` (`409 PRIMARY_UNIT_CHANGED`). هذه المسارات و`primary-unit` تقفل بـ`lockProduct` (`FOR UPDATE`
  بلا `lock_timeout`): خلف تحويلٍ طويل تنتظر حتى تنقضي معاملة Prisma (500 بلا كتابة)، لا `503 PRODUCT_UNITS_BUSY`.
- `PUT /products/:id`: `expectedBaseName` و`primaryUnit` (رقعة الرئيسية ذرّياً). `primaryUnitId` في الجسم يُتجاهل. جسمٌ يمسّ
  `basePrice` أو `unit` أو `primaryUnit` يُكتب تحت `lockProductForEdit` (`503 PRODUCT_UNITS_BUSY` بعد ٥ ثوانٍ)، وإعادة تسمية
  الأساس تكتب صفّ سجلٍّ بمعامل ١ (لا يحرّك `baseConvertedAt`) فتبقى سلسلة إعادة الرفع متّصلة.
- **D19 — مفاتيح API بعد تحويل:** لصنف `baseConvertedAt ≠ null`، كل كتابة بمفتاح تعتمد على الأساس تتطلّب `expectedBaseName`
  (إعدادات الصنف) أو `baseUnitName` (بنود المستندات والمخزون وصفوف أسعار العميل وإعادة وسم LOT)، وإلا `400 BASE_UNIT_REQUIRED`.
  الأصناف التي لم تُحوَّل، وتطبيق المندوب ولوحة الإدارة، لا يتأثّرون.
- `GET /products/customer-prices/:customerId` يردّ `{productId, price, unit}`: `unit` أساس الصنف لحظة القراءة، فيعيد الجهاز
  أساس كاش الأسعار بعد تحويل (`rebaseCustPrices`).
- جسم البنود (`POST /invoices`، تحميل السيارة، وارد المستودع، طلب البضاعة): `unitId?` لكل بند، و`baseUnitName?`
  (أساس الصنف كما رآه العميل، يُقارن حيّاً ثم تحت القفل). وكذلك `POST /invoices/:id/credit-note` (`lines[].baseUnitName`، ولا
  يُقبل `unitFactor` من الجسم أبداً) و`PUT /customers/:id/prices` و`POST /lots/relabel`.
- `GET /invoices/:id/returnable`: لكل بند بيع: `unitName, unitFactor, soldBase, returnedBase, returnableBase,
  lineTotal, refundPerBase` ومعها `product.units` و`product.unit`.
- المزامنة: `primaryUnitId` و`baseConvertedAt` مكشوفان في مورد `products` (`services/apiSync.ts`). لا مورد لسجلّ التحويلات
  في هذه الجولة. التوثيق للمتكاملين: `web-admin/src/lib/apiDocsCatalog.ts` (مقدمة الأصناف: «بعد تحويل وحدة صنف»).

## سجلّ التحويلات وإعادة الرفع (D16)
- `ProductBaseConversion` شاهد الخادم: صفٌّ بمعامل F > ١ تحويلٌ (كرتون ⇒ قارورة)، وبمعامل ١ إعادة تسمية للأساس.
  `fromUnitId` الوحدة التي أنشأها التحويل باسم `fromUnit`، بلا FK: يبقى شاهداً ولو حُذفت أو أعيدت تسميتها.
- **I8:** صنف `baseConvertedAt = null` ⇒ لا استعلام على `product_base_conversions` أبداً. السجلّ يُقرأ في إعادة الرفع
  (`X-FS-Replay`) وحدها، لأصناف المستند المحوَّلة.
- الدوال النقية في `services/baseConversions.ts`: `chainFrom` (من آخر صفٍّ `fromUnit = devBase` حتى الأساس الحالي، والمعامل
  = ΠF)، و`conversionsSince` (ما وقع بعد لحظة المستند، بهامش ساعة الجهاز `REPLAY_CLOCK_MARGIN_MS` = ١٠ دقائق)،
  و`rebaseCandidates` و`pickByPrice` (±`PRICE_MATCH_TOL` = ٢٥٪) و`pickByFactor`.
- `resolveLineUnit` في إعادة الرفع، والإشارات **بالترتيب** — المستند **لا يُحجز** أبداً (انحراف مقصود عن `PRODUCT_UNITS_REVIEW`،
  لأن الحجز بلا أداة حلّ يُبقي مستنداً سُلّمت بضاعته معلّقاً إلى الأبد):
  - **(A) لقطة بأساس قديم:** السلسلة من السجلّ ⇒ المعامل × ΠF، ووحدة التسعير بـ`fromUnitId` (ولو موقوفة) إن طابق معاملها.
    بلا سلسلة ⇒ الاستدلال بالاسم كما قبل السجلّ (حال الأصناف المحوَّلة قبل هذا النشر).
  - **(B) بلا أي لقطة:** إشارة السعر أولاً (المرشّح الوحيد الذي يقع سعر البند ضمن ±٢٥٪ من مرجعه؛ النوافذ لا تتداخل لأن كل
    معامل ≥ ٢)، وإلا الساعة (`clientCreatedAt` مقابل `convertedAt`) مع `notice: 'AMBIGUOUS'`. و`CLOCK_DISAGREES` حين يحسمها
    السعر وتخالفه الساعة.
  - **(C) لقطة بمعامل بلا أساس:** إشارة المعامل (يساوي المعامل الحالي ⇒ لا ضرب؛ يساوي `devFactor × Π_{i≥k} F_i` لـk واحد ⇒
    ذلك الضرب، فلا يُضرب كرتون ٢٤ مرتين فيصير ٥٧٦)، وإلا الساعة مع `AMBIGUOUS`.
  - بندٌ يحمل `notice` ⇒ إشعار إدارة واحد لكل `clientRef` بعد الالتزام (best-effort خارج المعاملة).
  - تلميحات LOT في بندٍ أُعيد أساسه تُضرب بمعامل إعادة الأساس نفسه (`scaleLotHint`)، فيبقى Σ صفوف التوزيع = `baseQty` (I9).
- الأصناف المحوَّلة بجلسة المالك قبل هذا النشر بلا صفوف سجلّ: الاستدلال بالاسم كما كان. ملؤها لاحقاً بسكربت
  `backfillBaseConversions.ts` (افتراضه `--dry-run`) بإذن المالك وحده، وليس من هذه الجولة.
- **`GlMoveLine.quantity` لا يُضرب** في التحويل: القيود المرحَّلة لا تُعدَّل، وكمياتها كما رُحِّلت بوحدة لحظتها.

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
5. **«الوحدة الرئيسية» وإكمال حماية التحويل** (فرع `feature/primary-unit`، المواصفة `primary_unit_spec.md`): القاعدتان ١٢ و١٣
   وسجلّ التحويلات أعلاه. البوابة `CONVERT_BASE_OPEN_TO_COMPANY` تبقى `false` حتى معيار القلب كله: اختبارات §3 و§8 خضراء
   مع `tsc` في الحزمتين، وتعطيل كل حارس يُفشل اختباره (مسجّلاً بنداً بنداً)، ولا نتيجة حرجة أو عالية مفتوحة، و`REVIEW.md` يسجّل
   إغلاق العنقود. بعد النشر يقلب المالك `convertBaseOpen` لشركة واحدة أولاً من صفحة المنصّة.
   **ترتيب النشر الملزم:** `db push` إضافي بإذن المالك وفحص الأعمدة قبل دمج الكود إلى الفرع الذي يتتبّعه Render (أو إطفاء
   `autoDeploy` مؤقتاً بإذنه)، لأن Prisma Client الجديد يختار الأعمدة الجديدة في كل استعلام أصناف وشركات.
