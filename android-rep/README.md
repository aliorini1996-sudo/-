# تطبيق المندوب على أندرويد (net.fieldsa.twa)

## ما هذا المشروع

هذا المجلد هو **المصدر الدائم** لتطبيق «FieldSales - فيلد سيلز» للمندوب على Google Play (المعرّف `net.fieldsa.twa`).
التطبيق غلاف TWA (Trusted Web Activity) يفتح `https://fieldsa.net/rep`، ومعه وحدتان أصليتان:
- **الطباعة المباشرة بالبلوتوث** (جسر الطباعة): تطبع صفحة المندوب على طابعة البلوتوث المقترنة حين لا يتيح المتصفح Web Serial.
- **التحصيل بالبطاقة** عبر NearPay (SoftPOS)، أي يلمس العميل بطاقته بجوال المندوب. تُبنى مع رمز NearPay وحده (الخطوة ٣).

- وُلّد المشروع مرة واحدة بـ Bubblewrap 1.25.0، ثم صار يُعدَّل هنا يدوياً. **لا يُعاد توليده بـ Bubblewrap بعد اليوم**، لأن `bubblewrap update` يكتب فوق `build.gradle` و`AndroidManifest.xml` فيمحو وحدة الدفع.
- `twa-manifest.json` باقٍ للمرجع فقط.
- كل تغيير في النسخة أو الألوان أو الأذونات يكون في `app/build.gradle` و`app/src/main/AndroidManifest.xml` مباشرة.

| الملف | ما فيه |
|---|---|
| `build.gradle` | Kotlin، ومستودع NearPay الخاص (يقرأ الرمز من `nearpayToken`) |
| `app/build.gradle` | الحِزم، وBuildConfig (`API_BASE` و`WEB_BASE`)، والتوقيع من متغيرات البيئة، وR8، و`cardPayBuild` (الوحدة مع الرمز وحده) |
| `app/proguard-rules.pro` | قواعد R8 لوحدة NearPay |
| `app/src/main/AndroidManifest.xml` | أذونات NearPay، ونشاط `CardPayActivity` على الرابط `fieldsapay://cardpay`، وأذونات البلوتوث ونشاط `PrintActivity` على `fieldsaprint://print` و`fieldsaprint://printer` |
| `app/src/printonly/AndroidManifest.xml` | بلا رمز NearPay وحده: يُزيل من البيان المدمج نشاط التحصيل وأذوناته الستّ وميزة NFC (`tools:node="remove"`) |
| `app/src/main/java/net/fieldsa/twa/cardpay/CardPayActivity.kt` | شاشة الدفع ومسارها |
| `app/src/main/java/net/fieldsa/twa/cardpay/LaunchApi.kt` | استبدال رمز التسليم: `POST https://api.fieldsa.net/api/card-payments/launch` |
| `app/src/main/java/net/fieldsa/twa/cardpay/NearpaySession.kt` | **الملف الوحيد** الذي يستعمل رموز NearPay |
| `app/src/main/java/net/fieldsa/twa/LauncherActivity.java` | من Bubblewrap، ومعدّل: يُسقط `?cardpay=` من العنوان حين تُفتح المهمّة من قائمة التطبيقات الأخيرة، فلا تُعرض نتيجة دفعٍ قديم؛ ويضيف `fsbridge=1.<المفتاح>` لجسر الطباعة |
| `app/src/main/java/net/fieldsa/twa/print/BridgeContract.kt` | ثوابت العقد مع الويب، حرفياً كـ`web-admin/src/lib/print/transport/bridgeContract.ts` (يحرسها `bridgeContract.test.ts`) |
| `app/src/main/java/net/fieldsa/twa/print/PrintPayload.kt` | فكّ حمولة الطباعة v1 وفحصها (JVM خالص) |
| `app/src/main/java/net/fieldsa/twa/print/PrintWriteLoop.kt` | حلقة الكتابة بالدفعات والإلغاء الآمن، نظير `sendJob` في الويب |
| `app/src/main/java/net/fieldsa/twa/print/BluetoothPrinter.kt` | الاتصال بالطابعة (RFCOMM/SPP) والكتابة والإغلاق |
| `app/src/main/java/net/fieldsa/twa/print/PrinterStore.kt` | الطابعة المختارة ومفتاح الثقة لهذا التثبيت |
| `app/src/main/java/net/fieldsa/twa/print/PrintActivity.kt` | شاشة الطباعة ومسارها |
| `app/src/test/…/print/*Test.kt` و`app/src/test/resources/print_payload_vectors.json` | اختبارات JVM على المتجهات الذهبية نفسها التي يختبر بها الويب مُرمِّزه |

## كيف تعمل وحدة التحصيل بالبطاقة

1. يضغط المندوب «تحصيل بالبطاقة» في صفحة العميل، فيُنشئ الخادم عملية ورمز تسليم لمرة واحدة صالحاً عشر دقائق.
2. تفتح الصفحة `fieldsapay://cardpay?t=<الرمز>`. الرابط لا يحمل مبلغاً ولا فاتورة.
   - Chrome لا يفتح التطبيق إلا بإيماءة مستخدم حديثة: إن تأخر ردّ الخادم ثوانيَ طلبت الصفحة نقرة ثانية على الزرّ نفسه.
3. **قبل أن يُرسل الرمز** يطلب التطبيق أذونات الموقع الدقيق وحالة الهاتف (بعد شاشة إفصاح وزرّ «متابعة»)، ويتأكد أن في الجوال NFC وأنه يعمل.
   - استبدال الرمز يحجز الفاتورة عشر دقائق على الخادم، فلا يُستهلك على جوالٍ لن يقرأ بطاقة.
4. يستبدل التطبيق الرمز من الخادم بتفاصيل العملية: المبلغ بالهللات، ورقم الفاتورة، ونقطة البيع، واسم المندوب، وJWT صالح ٣٠٠ ثانية، ورقم مشروع Google Cloud.
5. يشغّل NearPay ويدخل نقطة البيع بـ JWT.
6. يرى المندوب اسمه وآخر أرقام نقطة البيع والشركة والعميل والمبلغ، ثم يضغط «ابدأ التحصيل»، ويقرّب العميل بطاقته.
   - لا يبدأ الدفع بعد ٨ دقائق من الاستبدال: يعود التطبيق تلقائياً ليسأل الخادم.
   - «إعادة المحاولة» داخل التطبيق لا تظهر إلا إذا أُغلق القارئ ولم تُلمس بطاقة قط. بعد أي قراءة أو فشل إرسال يعود التطبيق والخادم يحكم.
7. الرجوع إلى الويب:
   - بعد استبدال الرمز، **أياً كانت النتيجة**: `https://fieldsa.net/rep?cardpay=<معرّف العملية>`.
   - قبل إرسال الرمز (رفض إذن، لا NFC، رجوع): `/rep?cardpay=aborted`، فتمحو الصفحة العملية المحفوظة عندها.
   - بعد إرسال الرمز بلا ردّ صالح: `/rep` وحدها، والصفحة تفتح العملية المحفوظة عندها وتسأل الخادم.
   - الجوال ليس مصدر الحقيقة: الخادم يسأل NearPay بمفتاحه، ويُصدر سند القبض إن وافقت بالمبلغ ونقطة البيع نفسيهما.
8. الرمز وJWT لا يُسجَّلان ولا يُحفظان على الجوال.
   - إن ماتت العملية في منتصف الدفع لا يُستبدل الرمز ثانية: يعود التطبيق إلى الويب ليحكم الخادم.
   - شاشة دفعٍ واحدة في كل مرة: رابطٌ ثانٍ أثناء شراءٍ جارٍ يُظهر الأولى ولا يُستبدل رمزه. وإن لم يُرسل رمز الأولى بعد ترجع إلى الويب. وإن استُبدل ولم يبدأ شراء فلا تُخصم إلا بتأكيد من شاشة تنبيه («أكمل هذه العملية» أو «رجوع»). الرابط التالف أو المكرر لا يمسّها.
   - الرجوع التلقائي بعد النتيجة أو المهلة لا يقع والشاشة في الخلفية: يُؤجَّل حتى تعود إلى الواجهة.

## الطباعة المباشرة عبر التطبيق

حين يختار المندوب «بلوتوث مباشر» على أندرويد:
- إن أتاح المتصفح Web Serial (Chrome 138 فأحدث) تطبع الصفحة بنفسها كما كانت.
- وإلا تسلّم الصفحة الأمر إلى هذا التطبيق، فيطبعه `PrintActivity` على الطابعة المقترنة، ثم ينتهي ويعود المندوب إلى صفحته كما تركها. لا إعادة تحميل.

كيف يصل الأمر:
1. كل إطلاقٍ للتطبيق يضيف إلى عنوان الصفحة `fsbridge=1.<المفتاح>` (`LauncherActivity.appendPrintBridge`).
   - المفتاح سرٌّ عشوائي لهذا التثبيت (١٢٨ بتّاً)، يُنشأ أول مرة ويُحفظ في `PrinterStore`.
   - الصفحة تحفظه عندها وتحذفه من العنوان فوراً.
2. ترمّز الصفحة بايتات الطباعة نفسها (التي كان Web Serial سيرسلها) في **حمولة v1**: base64url لإطار `FSP` فيه الطول وCRC32، مضغوطاً deflate إن صغر به.
3. تفتح الصفحة `intent://print?k=<المفتاح>&p=<الحمولة>#Intent;scheme=fieldsaprint;package=net.fieldsa.twa;end` بنقرة المندوب.
   - بلا `S.browser_fallback_url`: الصفحة لا تُنقل أبداً. ونسخة قديمة من التطبيق أو تطبيقٌ غير مثبّت ⇒ يفتح Chrome صفحته في Google Play.
   - حدّ الحمولة ١٩٦٬٦٠٨ حرفاً (حدّ Binder). ما فوقه ترفضه الصفحة قبل الإرسال وتقترح «نظام الطباعة في الجهاز».
4. يفكّ التطبيق الحمولة ويفحصها كلها (`PrintPayload`)، ثم:
   - مفتاحٌ يطابق مفتاح التثبيت ⇒ يطبع بلا نقرة.
   - بلا مفتاح أو بمفتاحٍ آخر (تبويب متصفح، أو أول طباعة بعد التحديث قبل فتح التطبيق، أو أي موقعٍ آخر) ⇒ شاشة تأكيد فيها اسم المستند والطابعة و«اطبع».
5. الطابعة: المقترنة وحدها (لا بحث عن أجهزة جديدة). أول مرة يختارها المندوب من قائمة، وتُحفظ.
   - «تغيير الطابعة» في التطبيق، أو «ربط الطابعة» في الصفحة (`fieldsaprint://printer`).
6. أندرويد 12 فأحدث يطلب إذن «الأجهزة القريبة» (`BLUETOOTH_CONNECT`) بعد شاشة إفصاح ونقرة «متابعة».
   - لا `BLUETOOTH_SCAN` ولا موقع للطباعة.
   - أندرويد 11 فأقدم: `BLUETOOTH` يُمنح مع التثبيت.
7. أمرٌ واحد في كل مرة. الرجوع أثناء الطباعة يوقفها عند نهاية أمرٍ مكتمل ثم يرسل أمر الإلغاء.
   - لا طباعة تلقائية بعد موت العملية ولا من قائمة التطبيقات الأخيرة: تظهر «توقفت الطباعة قبل أن تكتمل» و«إعادة الطباعة».
   - شاشة الطباعة مهمّةٌ مستقلة لا تظهر في القائمة الأخيرة ولا تُحفظ على القرص.

الحمولة والعقد: `BridgeContract.kt` نظير `bridgeContract.ts` في الويب. والمتجهات الذهبية `app/src/test/resources/print_payload_vectors.json` يختبرها الطرفان:
- `PrintPayloadTest` هنا.
- `bridgeVectors.test.ts` في الويب.
- إعادة توليدها عملٌ مقصود: سكربت المرجع ثم اختبارات الطرفين معاً.

### تجربة بطابعة مقترنة

1. اقرن الطابعة من إعدادات البلوتوث في الجوال.
2. ثبّت نسخة التصحيح `app/build/outputs/apk/debug/app-debug.apk` (الخطوة ٦، «تحقّق التصحيح»).
3. افتح تطبيق المندوب ← «تغيير» ← «بلوتوث مباشر» ← اطبع فاتورة.
   - المتوقَّع: إذن «الأجهزة القريبة» مرةً، ثم اختيار الطابعة مرةً، ثم «جارٍ الطباعة» بالنسبة، ثم «تمت الطباعة»، ثم تعود الصفحة كما هي.
4. جرّب أيضاً:
   - من تبويب Samsung Internet أو Chrome (لا من التطبيق): تظهر شاشة التأكيد قبل الطباعة.
   - البلوتوث مطفأ: «تشغيل البلوتوث».
   - رفض الإذن، ثم رفضه نهائياً: «منح الإذن» ثم «فتح إعدادات التطبيق».
   - «تغيير الطابعة».
   - الرجوع في منتصف طباعة A4 طويلة على MIP480: تتوقف الورقة عند نهاية أمر وتُخرج.
   - فاتورة MIP480 من صفحتين أو ثلاث على جوال سامسونج متوسط (حدّ الحمولة).

## قائمة التفعيل بالترتيب

> لا تُنفَّذ خطوة البناء ولا الرفع إلا بإذن صريح من المالك.

### ٠. الخادم والويب قبل أي نسخة من التطبيق

انشر `backend/` و`web-admin/` من 096534e أو أحدث على Render، وتأكد أنهما حيّان قبل تثبيت أي نسخة فيها `CardPayActivity`:

- الوحدة ترجع إلى `/rep?cardpay=aborted` حين تُترك قبل إرسال رمزها. الويب الأقدم يعامل `aborted` معرّف عملية فيسأل عنه الخادم ويظهر خطأ.
- رفض الإصدار والاستبدال بـ503 حين يغيب ضبط الوحدة (الخطوة ٤)، و`repName` في الحمولة، لا يوجدان إلا في الخادم الأحدث.
- فحص سريع بعد النشر **وأنت داخلٌ بحساب مندوب** (في تطبيق المندوب أو Chrome على الجوال نفسه، لا متصفحٍ بلا جلسة مندوب): افتح `https://fieldsa.net/rep?cardpay=aborted`. الويب الجديد لا يُظهر أي نافذة؛ الأقدم يُظهر «جار التحقق من الدفع» ثم خطأ.
- أقدم التزامٍ يكفي: 096534e (المجلد موجود منذ b66ebe9 لكن بلا معالجة `aborted`).

### ١. مشروع Google Cloud وربطه بـ Play Integrity

NearPay تشترط Play Integrity. الخطوات من توثيقها:

1. افتح [Google Cloud Console](https://console.cloud.google.com)، وأنشئ مشروعاً جديداً أو اختر مشروعاً قائماً.
2. خذ **رقم المشروع** (Project number، أرقام فقط، لا Project ID) من لوحة المشروع أو من إعداداته.
3. في Play Console افتح تطبيق Field Sales، ثم **Protected with Play** («محمي بواسطة Play»).
   - هذا مسار وثيقة Google الحالية (Play Integrity API › Setup، آخر تحديث ١٦ أكتوبر ٢٠٢٦).
   - توثيق NearPay يذكر المسار الأقدم **Release ← App integrity**، ويقول هو نفسه إن المسار قد يتغير.
4. بجانب **Play Integrity API** اضغط **Get started**، ثم **Link Cloud project**، واختر المشروع من الخطوة 1.
   - تُفعَّل Play Integrity API في المشروع تلقائياً عند الربط.

### ٢. شهادة توقيع التطبيق بصيغة PEM إلى NearPay

التطبيق يستعمل توقيع Google Play (Play App Signing)، فالشهادة التي تراها الأجهزة هي **شهادة توقيع التطبيق** عند Google، لا مفتاح الرفع.

1. افتح المسار: Play Console ← **Release ← Setup ← App signing**.
   - في الواجهة الأحدث تجده تحت «سلامة التطبيق»، في تبويب «توقيع التطبيق».
2. تحت **App signing key certificate** اضغط **Download certificate**، فيُنزَّل الملف `deployment_cert.der`.
3. حوّل الملف إلى PEM (`openssl` يأتي مع Git for Windows):
   ```
   openssl x509 -inform DER -in deployment_cert.der -out fieldsales_app_signing.pem
   ```
   أو بأداة JDK وحدها في PowerShell:
   ```powershell
   keytool -printcert -rfc -file deployment_cert.der | Out-File -Encoding ascii fieldsales_app_signing.pem
   ```
   - لا تستعمل `>` في Windows PowerShell 5.1: يكتب الملف UTF-16 فلا تقرؤه NearPay ولا openssl.
4. تحقّق من الملف قبل إرساله. هذا الأمر يجب أن يطبع سطر `subject=`:
   ```
   openssl x509 -in fieldsales_app_signing.pem -noout -subject
   ```
5. أرسل إلى NearPay ثلاثة أشياء:
   - ملف PEM.
   - اسم الحزمة `net.fieldsa.twa`.
   - طلب رمز مستودع Maven (Private-Token).

الشهادة عامة ولا كلمة مرور فيها. لا ترسل ملف keystore ولا كلمات مروره أبداً. ملفات `.pem` و`.der` مستثناة من المستودع.

### ٣. رمز Maven من NearPay على جهاز البناء وحده

ضع الرمز في ملف المستخدم `%USERPROFILE%\.gradle\gradle.properties`، وهو خارج المستودع، في سطرٍ واحد:

```
nearpayToken=<الرمز من NearPay>
```

في PowerShell (الرمز يُقرأ مخفياً فلا يبقى في سجل الأوامر، والملف يُكتب ASCII بلا BOM):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gradle" | Out-Null
$s = Read-Host "NearPay token" -AsSecureString
$t = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
Add-Content -Encoding ascii -Path "$env:USERPROFILE\.gradle\gradle.properties" -Value "`r`nnearpayToken=$t"
Remove-Variable s, t
```

- Gradle يقرأ الملف ISO-8859-1: ملفٌ UTF-16 أو UTF-8 بـBOM (ما يكتبه `>` و`Out-File -Encoding utf8` في PowerShell 5.1) يُفسد أول مفتاح فيه.
- إن حرّرته بالمفكرة فاحفظه «UTF-8» لا «UTF-8 with BOM».
- البديل: متغير البيئة `ORG_GRADLE_PROJECT_nearpayToken`.
- لا يُكتب الرمز في `gradle.properties` الذي داخل المشروع، ولا في أي ملف يُلتزم به.
- الرمز اختياري للبناء:
  - **مع الرمز**: التطبيق بجسر الطباعة **ووحدة التحصيل بالبطاقة** كما كانت حرفياً (البيان والمصادر والتبعيات نفسها).
  - **بلا رمز**: يُبنى التطبيق بجسر الطباعة **بلا** وحدة التحصيل، ويطبع Gradle السطر `nearpayToken not set: building WITHOUT the card-pay module …`.
    - تُستثنى مصادر `net.fieldsa.twa.cardpay` من الترجمة وتبعيتا NearPay، ويُزال نشاطها وأذوناتها من البيان المدمج (`app/src/printonly/AndroidManifest.xml`).
    - رابط `fieldsapay://cardpay` حينها لا يجد نشاطاً، فيتبع Chrome بديل الخادم (`?cardpay=unsupported`).
    - إصدارٌ بلا رمز في Play يعني أن `CARD_PAY_APP_READY` يبقى غير مضبوط (الخطوة ٨) حتى يُنشر إصدارٌ بالرمز.

### ٤. رقم مشروع Google Cloud على Render

في خدمة `dsd-backend` على Render أضف المتغير:

```
NEARPAY_GCP_PROJECT_NUMBER=<رقم المشروع من الخطوة ١ — أرقام فقط>
```

- بدونه، أو بدون مفتاح JWT (`NEARPAY_JWT_PRIVATE_KEY` و`NEARPAY_CLIENT_UUID`)، لا يظهر زر «تحصيل بالبطاقة».
- وبعد نشر الخطوة ٠ يرفض الخادم الإصدار والاستبدال (503) قبل أن يُستهلك أي رمز، فلا تُحجز فاتورة.
- الرقم موجب بلا حروف ولا يزيد على ١٨ خانة (Project number دائماً كذلك)، وغيره يُعامل كغيابه.
- الوحدة لا تنفّذ الدخول برمز التحقق (OTP).

### ٥. قبل أول بناء: مطابقة الوحدة مع حزمة NearPay

✅ **تمّت المطابقة (١ نوفمبر ٢٠٢٦)** بعد وصول الرمز، على `terminalsdk-release-0.2.6.aar` نفسه من مستودع NearPay:
- صار `:app:compileReleaseKotlin` يترجم الوحدة بلا خطأ. هذه ترجمة Kotlin فقط، لا apk ولا aab.
- **أسطر الاستيراد** مكتوبة في رأس `NearpaySession.kt`. الأصناف في `io.nearpay.terminalsdk` وفروعها: `data.dto` و`listeners` و`listeners.failures`.
- **قاعدة `proguard-rules.pro`** (`io.nearpay.**`) صحيحة، والحزمة تحمل `proguard.txt` خاصاً بها.
- **التوقيعات الفعلية:**
  - `onSendTransactionCompleted(PurchaseResponse)`.
  - مبلغ `purchase` من نوع `long`.
  - `JWTLoginData(jwt)` موجود.
  - `ReadCardListener` بطرائقه الاثنتي عشرة، و`onVasCaptured` اختياري.
- **نسخة Kotlin:** بيانات Kotlin في الحزمة يقرؤها Kotlin 2.2.20 بلا شكوى.
- **في الحزمة نفسها** فشلٌ اسمه `DuplicateInFlightIntent` في `ReadCardFailure` و`SendTransactionFailure`. الوحدة تحرس عمليةً جارية بالـintentUUID نفسه، ويبقى سؤال الإعادة بعد إغلاق القارئ (أدناه) قائماً.
- **مستودع NearPay فيه نسخ أحدث:** 0.2.7 و0.2.8. نبقى على 0.2.6 الموثّقة حتى تقول NearPay غير ذلك.
- **أذونات تضيفها الحزمة إلى التطبيق:** الموقع و`READ_PHONE_STATE` وNFC. تدخل في بيانات «أمان البيانات» على Play.

**أسئلة لـ NearPay قبل الإنتاج** (التوثيق لا يجيب عنها):
   - هل يُقبل `purchase` ثانٍ بالـ intentUUID نفسه بعد أن أغلق المستخدم القارئ قبل تقريب أي بطاقة؟ أم تصير النيّة «ملغاة» (5012)؟ وإن قُبل ووافق، فهل تصير حالة النيّة في Accounts API «approved» (حالة آخر معاملة) أم تبقى «cancelled»؟
     - التطبيق يعيد على النيّة نفسها عمداً: خصمٌ ثانٍ خفيّ يقع حينها على النيّة نفسها فيوقفه الخادم للمراجعة، أما نيّة جديدة فكانت ستُقيَّد سنداً ثانياً.
     - إن رفضت NearPay الإعادة عاد التطبيق إلى الويب والخادم يحكم، ولا يُحبس المندوب.
   - الدليل الأمريكي يذكر `taxPercentage` و`surchargeAmount` للشراء («The SDK adds amount * taxPercentage / 10000 plus surchargeAmount»). التطبيق لا يمرّرهما. هل افتراضهما صفر في السعودية؟ أي إضافة تجعل مبلغ النيّة غير مبلغ الفاتورة، فيوقف الخادم السند للمراجعة.
   - التطبيق يبني `TerminalSDK` جديداً لكل شاشة دفع ولا يحرّره (لا دالة تحرير موثّقة)، والبدء السريع يقول «create a single instance». هل هذا مقبول؟ وإن لم يكن، كيف تُربط النسخة الواحدة بنشاطٍ جديد؟ (هل يكفي `getTerminal(activity, uuid)`؟)

### ٦. البناء (بإذن المالك فقط)

المتطلبات:
- JDK 17.
- Android SDK فيه platform 36.
- إما `ANDROID_HOME`، أو `local.properties` فيه `sdk.dir` (مستثنى من المستودع).

النسخة الحالية `versionCode 7` و`versionName "1.2.1"` (في `app/build.gradle`، و`twa-manifest.json` للمرجع):
- 3 هو المنشور في Play، و4 بُني ثم حُذف، و5 لم يُنشر قط، و6 (1.2.0: جسر الطباعة) سبقها.
- 1.2.1: نصوص شاشة التحصيل بلا اسم مزوّد الدفع (طلب المالك) — «مزوّد الدفع» و«نقطة البيع»، وبيئة الاختبار «عملية تجريبية»؛ يحرسها `ProviderNameGuardTest`. شاشات حزمة المزوّد نفسها خارج سيطرتنا.
- كل رفعٍ لاحق يرفع `versionCode`.

**تحقّق التصحيح** (ترجمة واختبارات JVM وحزمة debug فقط — لا توقيع إصدار، ولا keystore، ولا aab، ولا رفع). من Git Bash في `android-rep`:

```
printf 'sdk.dir=C:/Users/ali_h/Android/sdk\n' > local.properties   # مستثنى من المستودع
export JAVA_HOME="<مسار JDK 17>"
./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug                  # مع الرمز: الطباعة + التحصيل
./gradlew --no-daemon -PnearpayToken= :app:testDebugUnitTest :app:assembleDebug  # بلا رمز: الطباعة وحدها
./gradlew --no-daemon :app:lintDebug
```

- `-PnearpayToken=` (فارغاً) يغلب ما في `~/.gradle/gradle.properties`، فيحاكي جهازاً بلا رمز.
- `preBuild` يعيد توليد `app/src/main/res/xml/shortcuts.xml` فيُسقط ترويسة الترخيص منه. لا تلتزم بهذا التغيير: أعد الملف من git بعد البناء.
- بناء الإصدار (`bundleRelease` أدناه) بإذن المالك وحده.


**مسار البناء**: ابنِ من نسخة للمستودع في مسار ASCII بلا مسافات وخارج OneDrive، مثل `C:\Users\ali_h\fieldsa-android`، على الإيداع الذي فيه `android-rep`.
- AGP يوقف البناء على ويندوز إن كان في مسار المشروع حروف غير ASCII، والمستودع الرئيسي في مسار عربي فيه مسافات.
- لا تبنِ من مجلد worktree مؤقت لفرع ميزة: يُحذف بعد الدمج.

في PowerShell (المسار أدناه مثال):

```powershell
cd C:\Users\ali_h\fieldsa-android\android-rep
$env:JAVA_HOME    = "<مسار JDK 17>"
$env:ANDROID_HOME = "<مسار Android SDK>"

# توقيع الرفع: الأربعة كلها وإلا خرجت الحزمة غير موقّعة. كلمتا المرور تُقرآن مخفيّتين فلا تبقيان في سجل الأوامر
function Read-Secret($p) { $s = Read-Host $p -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
$env:FIELDSA_KEYSTORE          = "<المسار الكامل لملف signing.keystore — خارج المستودع>"
$env:FIELDSA_KEY_ALIAS         = "<الاسم المستعار للمفتاح>"
$env:FIELDSA_KEYSTORE_PASSWORD = Read-Secret "Keystore password"
$env:FIELDSA_KEY_PASSWORD      = Read-Secret "Key password"

.\gradlew.bat --no-daemon clean bundleRelease
```

- الأسماء الأربعة تُقبل أيضاً خصائص Gradle في `~/.gradle/gradle.properties`.
- الاسم المستعار هو `signingKey.alias` في `twa-manifest.json`.

بعد البناء:
- الناتج في `app\build\outputs\bundle\release\app-release.aab`، وملف R8 في `app\build\outputs\mapping\release\mapping.txt`.
- تحقّق من التوقيع بالأمر `keytool -printcert -jarfile app\build\outputs\bundle\release\app-release.aab`. البصمة يجب أن تطابق «مفتاح الرفع» في صفحة توقيع التطبيق في Play Console.
- أغلق نافذة PowerShell بعد البناء لتزول كلمات المرور من الذاكرة.

### ٧. الرفع إلى مسار الاختبار الداخلي

1. افتح المسار: Play Console ← **Testing ← Internal testing** («الاختبار ← الاختبار الداخلي») ← إنشاء إصدار جديد.
2. ارفع `app-release.aab`، وأضف حساب Gmail لجوال الاختبار إلى قائمة المختبرين.
3. ثبّت التطبيق **من Play** برابط الانضمام.
   - نسخة تُثبَّت يدوياً (موقّعة بمفتاح الرفع) لا يعرفها Play Integrity، فترفضها NearPay.
4. Play سيحذّر أن أجهزة لم تعد مدعومة، بسبب minSdk 26 (انظر الملاحظات).
5. قبل الإنتاج حدّث «محتوى التطبيق»:
   1. **الأذونات الفعلية أولاً**: بعد أول بناء افتح البيان المدمج (Android Studio ← APK Analyzer على الحزمة، أو `app\build\intermediates\merged_manifests\release\`).
      - اكتب كل `uses-permission` و`uses-feature` تضيفه حزمة NearPay. لم تُفحص الحزمة بعد، وقد تضيف ما ليس في `AndroidManifest.xml` هنا.
   2. **«أمان البيانات»** — صرّح بأنها «تُجمع» (collected):
      - **الموقع**: الدقيق **والتقريبي** معاً (التطبيق يطلب `ACCESS_COARSE_LOCATION` أيضاً).
      - **معرّفات الجهاز أو غيرها** (Device or other IDs): «حالة الهاتف» ليست فئة في النموذج. `READ_PHONE_STATE` يكشف بيانات الجهاز والشريحة، ومنها IMEI على أندرويد 8–9.
      - **معلومات التطبيق وأداؤه**: سجلات الأعطال والتشخيص. سجل تغييرات NearPay يذكر أن الوحدة تُبلغ عن أعطالها (0.0.213 و0.2.6).
      - **المعاملات المالية / بيانات الدفع**: ما تتسلمه NearPay من العملية.
      - الغرض: «وظائف التطبيق» و«منع الاحتيال والأمان والامتثال».
      - NearPay مزوّد خدمة يعمل لحسابنا، فاسأل NearPay هل تُعدّ «مشاركة» أم لا قبل الإجابة، وصرّح بأن البيانات مشفّرة أثناء النقل.
   3. إقرار «الميزات المالية».

### ٨. تجربة على بيئة اختبار NearPay

في `dsd-backend` على Render:

```
NEARPAY_SANDBOX_TENANTS=<معرّف شركة الاختبار القائمة>
CARD_PAY_APP_READY=1
```

- على خادم الإنتاج لا تُستعمل بيئة الاختبار إلا للشركات المسمّاة في `NEARPAY_SANDBOX_TENANTS`.
- `CARD_PAY_APP_READY=1` يُظهر زر «تحصيل بالبطاقة» في تطبيق المندوب.

ثم:

1. فعّل التحصيل بالبطاقة لشركة الاختبار من لوحة المالك، واربط تاجرها، وأسند نقطة بيع للمندوب.
2. حصّل فاتورة صغيرة ببطاقة اختبار من NearPay، من الجوال الذي ثبّت التطبيق من مسار الاختبار الداخلي.
3. تأكد أن الصفحة بعد الرجوع تعرض «تم التحصيل بالبطاقة» وأن السند صدر.
   - شكل ردّ NearPay لنيّةٍ موجودة لم يُقَس على الخادم حيّاً قط، فهذه أول فرصة لقياسه.
4. جرّب أيضاً: رفض البطاقة، والرجوع، و**إغلاق القارئ قبل تقريب البطاقة ثم «إعادة المحاولة» ثم الدفع**.
   - في الأخيرة يجب أن يصدر السند. إن عرضت الصفحة «لم يتم التحصيل» والمبلغ خُصم في لوحة NearPay، فالنيّة بقيت «ملغاة» بعد الإعادة، والخادم يحكم بحالة النيّة (`decideCardPayment`).
   - حينها احذف زر «إعادة المحاولة» من `CardPayActivity.retryable` قبل الإنتاج، واسأل NearPay (البند ٥).
5. **ثلاث عمليات متتالية دون إغلاق التطبيق** (من قائمة التطبيقات الأخيرة أو بإيقافه): لكل عملية يُبنى `TerminalSDK` جديد في العملية نفسها، وهذا غير موثّق.
   - إن فشلت التهيئة أو دخول نقطة البيع في الثانية أو الثالثة فلا إنتاج حتى تُجيب NearPay عن سؤال البند ٥ وتُرفع النسخة إلى نطاق التطبيق.
6. ارفض إذن الموقع مرة، وجوالاً بلا NFC إن توفر: يجب أن يعود التطبيق دون أن تُحجز الفاتورة (التحصيل من جديد يعمل فوراً).

### ٩. الإنتاج

1. رقِّ الإصدار من الاختبار الداخلي إلى مسار الإنتاج، وانتظر حتى يُنشر فعلاً.
   - إن تحوّلت البيئة قبل ذلك ظهر الزر لمناديب بنسخة قديمة، فيعودون إلى «حدّث التطبيق».
2. في `dsd-backend` على Render ضع مفاتيح الإنتاج من لوحة NearPay الإنتاجية:
   ```
   NEARPAY_ENV=production
   NEARPAY_API_BASE=<عنوان API الإنتاجي من NearPay — لا عنوان افتراضياً للإنتاج>
   NEARPAY_API_KEY=<مفتاح الإنتاج>
   NEARPAY_CLIENT_UUID=<مفتاح العميل في الإنتاج>
   NEARPAY_JWT_PRIVATE_KEY=<محتوى pos_key.pem الإنتاجي>
   ```
3. `NEARPAY_SANDBOX_TENANTS` لا عمل له في الإنتاج، فاحذفه.
4. لكل شركة: يفعّل المالك التحصيل بالبطاقة ويربط تاجرها، وتُسند نقاط البيع للمناديب.

## ملاحظات

- **minSdk 26 (أندرويد 8.0 فما فوق)** في البناءين: النسخة المنشورة سابقاً كانت تعمل من أندرويد 5 (minSdk 21)، وNearPay تشترط 26.
  - الجوالات بأندرويد 5 إلى 7.1 تحتفظ بالنسخة القديمة ولا تصلها التحديثات (ولا جسر الطباعة).
- **جسر الطباعة في Play**: قائمة أذونات التطبيق ستُظهر «الأجهزة القريبة» (`BLUETOOTH_CONNECT`).
  - «أمان البيانات» لا يتغير بسببه: الطباعة تبقى على الجوال، ولا يُرسل منها شيء إلينا.
  - البلوتوث غير لازم لتثبيت التطبيق (`android.hardware.bluetooth` بـ`required="false"`)، فلا يحجب Play التحديث عن جوالٍ بلا بلوتوث. حزمة NearPay كانت تجعله «مطلوباً» ضمناً بإذنَي BLUETOOTH وBLUETOOTH_ADMIN.
- الوحدة تحتاج **NFC** وخدمات Google Play، لأن Play Integrity إلزامي. جوال بلا NFC يثبّت التطبيق ويعمل في كل شيء عدا التحصيل بالبطاقة.
- نقطة البيع الواحدة تعمل على جوال واحد في وقت واحد.
  - إن ظهر أنها مربوطة بجوال آخر (الخطأ 4035 أو 5010): تُفصل من لوحة NearPay ← الطرفية ← الوصول ← فصل الجهاز.
- لا أسرار في هذا المستودع: لا رمز NearPay، ولا كلمات مرور التوقيع، ولا keystore، ولا مفاتيح PEM.
