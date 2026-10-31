# تطبيق المندوب على أندرويد (net.fieldsa.twa)

## ما هذا المشروع

هذا المجلد هو **المصدر الدائم** لتطبيق «FieldSales - فيلد سيلز» للمندوب على Google Play (المعرّف `net.fieldsa.twa`).
التطبيق غلاف TWA (Trusted Web Activity) يفتح `https://fieldsa.net/rep`، ومعه وحدة أصلية واحدة: **التحصيل بالبطاقة** عبر NearPay (SoftPOS)، أي يلمس العميل بطاقته بجوال المندوب.

- وُلّد المشروع مرة واحدة بـ Bubblewrap 1.25.0، ثم صار يُعدَّل هنا يدوياً. **لا يُعاد توليده بـ Bubblewrap بعد اليوم**، لأن `bubblewrap update` يكتب فوق `build.gradle` و`AndroidManifest.xml` فيمحو وحدة الدفع.
- `twa-manifest.json` باقٍ للمرجع فقط.
- كل تغيير في النسخة أو الألوان أو الأذونات يكون في `app/build.gradle` و`app/src/main/AndroidManifest.xml` مباشرة.

| الملف | ما فيه |
|---|---|
| `build.gradle` | Kotlin، ومستودع NearPay الخاص (يقرأ الرمز من `nearpayToken`) |
| `app/build.gradle` | الحِزم، وBuildConfig (`API_BASE` و`WEB_BASE`)، والتوقيع من متغيرات البيئة، وR8 |
| `app/proguard-rules.pro` | قواعد R8 لوحدة NearPay |
| `app/src/main/AndroidManifest.xml` | أذونات NearPay، ونشاط `CardPayActivity` على الرابط `fieldsapay://cardpay` |
| `app/src/main/java/net/fieldsa/twa/cardpay/CardPayActivity.kt` | شاشة الدفع ومسارها |
| `app/src/main/java/net/fieldsa/twa/cardpay/LaunchApi.kt` | استبدال رمز التسليم: `POST https://api.fieldsa.net/api/card-payments/launch` |
| `app/src/main/java/net/fieldsa/twa/cardpay/NearpaySession.kt` | **الملف الوحيد** الذي يستعمل رموز NearPay |
| `app/src/main/java/net/fieldsa/twa/LauncherActivity.java` | من Bubblewrap، ومعدّل: يُسقط `?cardpay=` من العنوان حين تُفتح المهمّة من قائمة التطبيقات الأخيرة، فلا تُعرض نتيجة دفعٍ قديم |

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
   - شاشة دفعٍ واحدة في كل مرة: رابطٌ ثانٍ أثناء عملية قائمة يُظهر الأولى ولا يُستبدل رمزه.

## قائمة التفعيل بالترتيب

> لا تُنفَّذ خطوة البناء ولا الرفع إلا بإذن صريح من المالك.

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
- بلا هذا الرمز يتوقف **البناء** وحده (`preBuild`) برسالة `Missing Gradle property 'nearpayToken'`.
  - `clean` و`tasks` و`signingReport` ومزامنة Android Studio تعمل بلا رمز؛ تظهر فيها تبعية NearPay غير محلولة فقط.
  - لا يُبنى من المشروع أي إصدار، ولو كان TWA وحدها، قبل وصول الرمز: وحدة الدفع جزء من التطبيق.

### ٤. رقم مشروع Google Cloud على Render

في خدمة `dsd-backend` على Render أضف المتغير:

```
NEARPAY_GCP_PROJECT_NUMBER=<رقم المشروع من الخطوة ١ — أرقام فقط>
```

- بدونه، أو بدون مفتاح JWT (`NEARPAY_JWT_PRIVATE_KEY` و`NEARPAY_CLIENT_UUID`)، لا يظهر زر «تحصيل بالبطاقة».
- ويرفض الخادم الإصدار والاستبدال (503) قبل أن يُستهلك أي رمز، فلا تُحجز فاتورة.
- الوحدة لا تنفّذ الدخول برمز التحقق (OTP).

### ٥. قبل أول بناء: مطابقة الوحدة مع حزمة NearPay

حزمة NearPay لم تكن متاحة حين كُتبت الوحدة، فالرموز منقولة من أمثلة التوثيق حرفياً. عند وصول الرمز افتح مشروعك في Android Studio، ثم:

1. **أسطر الاستيراد في `NearpaySession.kt`**: التوثيق لا يذكر حزمة (package) أي صنف.
   - ضع المؤشر على كل اسم أحمر واضغط Alt+Enter ← Import.
   - القائمة مكتوبة في رأس الملف.
2. **الحزمة في `proguard-rules.pro`**: القاعدة تفترض `io.nearpay.**`.
   - افتح `terminalsdk-release-0.2.6.aar` (ملف zip)، ثم `classes.jar`، وصحّحها إن اختلفت.
   - وانظر إن كان في الحزمة `proguard.txt`.
3. كل تعليق يبدأ بـ «تحقّق عند وصول الحزمة» في ملفات `cardpay` يذكر موضع شكٍّ واحد. أهمها:
   - نوع وسيط `onSendTransactionCompleted`: الأمثلة تقول `PurchaseResponse`، وجدول الردود يقول `TransactionResponse`.
   - نوع المبلغ في `purchase`: مثال Kotlin يمرّر `Int` ومثال Java يمرّر `Long`. المكتوب `Long`؛ إن قال المترجم «type mismatch» فمرّر `amountHalalas.toInt()` (آمن: الحد مليون ريال = ١٠٠ مليون هللة).
   - `purchase` يُنادى بالوسائط المسمّاة كأمثلة Kotlin، لأن الدليل الأمريكي للحزمة نفسها يضع `withTokenization` قبل `readCardListener`. إن اختلف اسم وسيط فصحّحه من توقيع الدالة في Android Studio.
4. **نسخة Kotlin في الحزمة**: المشروع على Kotlin 2.2.20، ومترجمه يقرأ بيانات Kotlin حتى 2.3 فقط. توثيق NearPay لا يذكر نسختها.
   - بعد أول مزامنة شغّل `.\gradlew.bat :app:dependencies --configuration releaseRuntimeClasspath` وانظر نسخة `kotlin-stdlib` المحلولة.
   - وافتح `terminalsdk-release-0.2.6.aar` ← `classes.jar` ← `META-INF/*.kotlin_module`.
   - إن كانت 2.4 أو أحدث فارفع `kotlin_version` في `build.gradle` إلى أحدث نسخة يذكر جدول توافقها AGP 8.9.1، أو ارفع AGP. `-Xskip-metadata-version-check` آخر الحلول.
5. **أسئلة لـ NearPay قبل الإنتاج** (التوثيق لا يجيب عنها):
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

إن كان الإصدار 5 مستعملاً في Play فارفع `versionCode` و`versionName` في `app/build.gradle`.

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

- **minSdk 26 (أندرويد 8.0 فما فوق)**: النسخة المنشورة سابقاً كانت تعمل من أندرويد 5 (minSdk 21)، وNearPay تشترط 26.
  - الجوالات بأندرويد 5 إلى 7.1 تحتفظ بالنسخة القديمة ولا تصلها التحديثات.
- الوحدة تحتاج **NFC** وخدمات Google Play، لأن Play Integrity إلزامي. جوال بلا NFC يثبّت التطبيق ويعمل في كل شيء عدا التحصيل بالبطاقة.
- نقطة البيع الواحدة تعمل على جوال واحد في وقت واحد.
  - إن ظهر أنها مربوطة بجوال آخر (الخطأ 4035 أو 5010): تُفصل من لوحة NearPay ← الطرفية ← الوصول ← فصل الجهاز.
- لا أسرار في هذا المستودع: لا رمز NearPay، ولا كلمات مرور التوقيع، ولا keystore، ولا مفاتيح PEM.
