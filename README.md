# تطبيق المندوب على App Store (iPhone) — خطة ونشر

نشر **تطبيق المندوب** (نفس الـPWA على `fieldsa.net/rep`) على متجر آبل، بمسار **Codemagic السحابي** (لا يحتاج جهاز Mac).

نظير أندرويد المنشور: `net.fieldsa.twa` على Google Play. هنا الغلاف WKWebView لـiOS.

---

## الحقائق القاطعة
1. **لا رفع من ويندوز وحده** — Xcode (macOS) مطلوب؛ نستخدم **Codemagic** (بناء+توقيع+رفع سحابي).
2. **Apple Developer Program 99$/سنة** — إجراء المالك، تفعيل 24–48 ساعة. راجع [`ENROLLMENT.md`](ENROLLMENT.md).
3. **خطر رفض البند 4.2** (غلاف ويبي رقيق) + شبهة **الميزات المالية** (رُفضنا عليها في Play) — نعالجها بالتموضع وملاحظات المراجعة.

---

## الحالة

| # | المهمة | المسؤول | الحالة |
|---|---|---|---|
| 1 | التسجيل في Apple Developer | **المالك** | 🔄 يبدأ الآن (المسار الحرج) — **فرد** |
| 2 | توليد مشروع iOS (PWABuilder) | Claude | ✅ **مكتمل** (المشروع في هذا المجلّد) |
| 3 | أصول وبيانات App Store | Claude | ✅ الأيقونة + الوصف + الخصوصية + ملاحظات المراجعة + دليل اللقطات · (صور اللقطات من TestFlight) |
| 4 | `codemagic.yaml` للبناء | Claude | ✅ **مكتوب** (يُشغَّل عند تفعيل الحساب) |
| 5 | معالجة خطر المراجعة | Claude | ✅ [`review-notes.md`](metadata/review-notes.md) |
| 6 | App record + الرفع النهائي | المالك + Claude | 🔒 محجوب بـ(1) |

## توافق الميزات مع تطبيق أندرويد المنشور (مُتحقَّق)
كلاهما يحمّل نفس الـPWA حيّاً، لكن غلاف iOS (WKWebView) ليس كروم كامل — فحصتُ كل ميزة وعالجتُ الفجوات:

| الميزة | على iOS | الحالة |
|---|---|---|
| فوترة ZATCA + QR | يعمل | ✅ |
| **حفظ/مشاركة PDF** | `canShare` يسقط لمسار التنزيل → WKDownload يفتح ورقة المشاركة | ✅ |
| **العمل دون اتصال** (SW+IndexedDB) | مُفعّل عبر `WKAppBoundDomains` الصحيح | ✅ |
| **صور الزيارات** (`<input capture>`) | يعمل + أُضيف `NSPhotoLibraryUsageDescription` + إذن الكاميرا | ✅ |
| **GPS الزيارات + التتبّع** | يعمل على iOS 15+ (وصف الموقع موجود) | ✅ |
| كشوف الحساب/المرتجعات/مخزون السيارة | منطق ويب بحت | ✅ |
| **ماسح الباركود المباشر** | أُضيف **ZXing** عبر `getUserMedia` كبديل لـiOS (يبقى `BarcodeDetector` الأصلي لأندرويد) | ✅ (بانتظار نشر الـPWA) |
| **الطباعة المباشرة عبر BLE (1.1.0)** | جسر أصلي `fsPrint` + CoreBluetooth: الحرارية ESC/POS والملصقات TSPL بنفس بايتات أندرويد (حمولة FSP v1)، شاشة ربط عربية تبحث عن الطابعة بلا إقران من الإعدادات، تقدّم وإلغاء عند نهاية سطر | ✅ في الكود (بانتظار البناء والتجربة) |
| **نظام الطباعة (AirPrint)** | `window.print()` لا يعمل داخل WKWebView ⇒ الويب يرسل الـHTML للتطبيق فيطبعه بـ`UIPrintInteractionController` (`systemPrint`) | ✅ 1.1.0 |
| **Tally Dascom MIP480** | بلوتوث كلاسيكي 1.2 بلا BLE وليست MFi ⇒ **غير مدعومة على iOS** (الويب يعطّل «بلوتوث مباشر» لقالبها على الآيفون بتلميح بسيط) | ❌ بقرار آبل |
| الدفع بالبطاقة | غير متاح على الآيفون؛ الزرّ يبقى مخفياً على iOS | — |
| **تنبيهات الحضور و«أثبت تواجدك»** | Web Push لا يصل داخل WKWebView ⇒ إشعارات APNs أصلية عبر جسر `fsPush` (التفصيل أدناه) | ✅ في الكود (بانتظار قدرات App ID والبناء) |

> **تطابق كامل الآن.** أُصلح ماسح الباركود في الـPWA (`web-admin/src/rep/BarcodeScanner.tsx`): أندرويد يستمرّ على `BarcodeDetector` الأصلي، وiOS يستخدم **ZXing** (تحميل ديناميكي مقسّم عبر `getUserMedia` — الغلاف يمنح إذن الكاميرا). بديل يدوي في كلا المسارين. **يتفعّل بعد نشر الـPWA على fieldsa.net** (تعديل ويب، لا يخصّ مشروع iOS).

## إشعارات الآيفون (APNs)

طلب المالك (٤ نوفمبر ٢٠٢٦): «أثبت تواجدك» وتذكيرات الحضور («قبل بداية الدوام» و«نسيت الانصراف») تصل الآيفون والتطبيق
مغلق. Web Push الذي يخدم أندرويد والويب لا يعمل داخل WKWebView، فالخادم يرسل إلى APNs مباشرةً برمز الجهاز (بلا Firebase).

- **الجسر** `window.webkit.messageHandlers.fsPush.postMessage({op})` → Promise (`FieldSales/PushBridge.swift`، عالم `.page`،
  الإطار الرئيسي لـ`https://fieldsa.net` وحده وإلّا `forbidden`)، وعلامته
  `window.__fsIosPush = {v:1, caps:['status','register','clear','ready']}`:
  - `status` (بلا سؤال أبداً) ⇒ `{ok, v, perm, token|null, env, error|null}`؛
  - `register` ⇒ يطلب الإذن أول مرّة فقط (`.alert` و`.sound`) ثمّ `registerForRemoteNotifications` وينتظر الرمز ٢٠ ثانية؛
  - `clear` بوسمٍ (و`checkId` اختياري) أو `{all:true}` عند الخروج؛
  - `ready` ⇒ الأحداث التي لم تُقِرّ بها صفحة (١٠ أحدثها، ١٥ دقيقة من دخولها الطابور لا من وصول الإشعار).
  الرمز في ذاكرة التطبيق وحدها (لا ملف ولا مخزن إعدادات)، والبيئة (`production`/`sandbox`) من `embedded.mobileprovision` لا من `#if DEBUG`.
- **الحدث** `CustomEvent('fs-ios-push', {detail, cancelable:true})` بـ`detail = {v:1, kind:'receive'|'open'|'token', id, tag, checkId, url, at}`:
  الصفحة تقرّ بـ`preventDefault()` وإلّا ينتظر الحدث `ready` (لمسةٌ أقلعت التطبيق قبل تحميل الصفحة). التطبيق لا ينتقل إلى `url`:
  الصفحة تقرأ منه `screen` (`presence` ⇒ الطلب، `attendance` ⇒ شاشة الحضور).
- **الحمولة** من الخادم (`backend/src/services/apnsPush.ts`): `aps.alert {title, body}`، و`sound` (`presence-alarm.wav` للتواجد،
  `default` للحضور)، و`interruption-level` (`time-sensitive` للتواجد، `active` للحضور)، و`relevance-score`، و`thread-id`،
  ثمّ في المستوى الأعلى `tag` و`url` و`checkId` (للتواجد وحده) — المفاتيح نفسها التي يقرؤها `sw.js` في الويب.
  `apns-collapse-id` = الوسم، وصلاحية التواجد ١٥ دقيقة.
- **الصوت** `FieldSales/presence-alarm.wav`: ٢٨ ثانية (آبل: أقلّ من ٣٠)، PCM 16-bit أحادي 22050 هرتز، يولّده
  `python -I ci/gen_presence_alarm.py FieldSales/presence-alarm.wav` بحسابٍ صحيح فيخرج بايتاً ببايت على أي جهاز، ومورد في الحزمة.
- **الصلاحيات** `FieldSales/FieldSales.entitlements`: `aps-environment = production` و
  `com.apple.developer.usernotifications.time-sensitive = true` حرفياً، يشير إليه `CODE_SIGN_ENTITLEMENTS` في إعداد **Release**
  للهدف وحده (Debug بلا إشعارات)، والملف ليس في أي مرحلة بناء (درس انهيار 1.0).
- **الحارس** `python -I ci/check_push.py` (ويندوز وCI) و`--selftest` (يتأكد أن كل مخالفةٍ معروفة تُرفض): الصلاحيات، والمشروع،
  والصوت، وواجهات «السبب المطلوب»، واسم أي مزوّد دفع، والإصدار 1.1.0. يعمل في `ios-testflight.yml` مكان حارس
  `CODE_SIGN_ENTITLEMENTS` القديم، و`ios-push-build-check.yml` يترجم الفرع بلا توقيع.
- **ملف التعريف**: Fastfile لا يكمل بملف تعريفٍ لا يمنح الصلاحيتين ويفحص الـIPA الموقَّع قبل الرفع. بعد تفعيل القدرتين في
  App ID يجدّده match وحده إن أبطلته آبل؛ وإلّا تشغيلٌ يدويّ للوورك فلو بخيار `renew_profile` (بإذن المالك: يكتب في مستودع
  التوقيع المشترك مع «بدر»).
  **⚠️ ترتيب الدمج:** لا يُدمج `feature/ios-push` في `ios-app` قبل تفعيل القدرتين في App ID — كل دفعٍ إلى `ios-app` يشغّل
  TestFlight، وملف تعريفٍ صالح بلا الصلاحيتين يوقف البناء عند «ملف تعريف … لا يمنح»، فيتوقف كل بناءٍ بعده (ومنه أي إصلاحٍ عاجل) حتى يفعّلهما المالك.
- **خطوات المالك** وملاحظات المراجعة والخصوصية: [`metadata/push-notifications.md`](metadata/push-notifications.md).

## هيكل المشروع المُولّد
```
ios-app/
├── codemagic.yaml            ← خط البناء (macOS + توقيع + رفع TestFlight)
├── CODEMAGIC-SETUP.md        ← دليل ربط Codemagic خطوة بخطوة
├── ENROLLMENT.md             ← دليل تسجيل Apple Developer
├── FieldSales.xcworkspace/   ← يُبنى هذا (بعد pod install)
├── FieldSales.xcodeproj/     ← السكيم: FieldSales
├── FieldSales/               ← كود الغلاف (WKWebView) + Info.plist + الأيقونات
│   ├── PrintPayload.swift    ← فكّ حمولة FSP v1 (نظير bridgePayload.ts وPrintPayload.kt) + WritePlan
│   ├── PrintBridge.swift     ← معالج fsPrint (hello/pick/print/cancel/systemPrint) + الطابعة المحفوظة
│   ├── BlePrinter.swift      ← CoreBluetooth: بحث وربط وكتابة بتنظيم التدفّق والإلغاء عند العلامات
│   ├── PrinterPicker.swift   ← شاشة «اختيار الطابعة» العربية
│   ├── PushBridge.swift      ← معالج fsPush (status/register/clear/ready) + حدث fs-ios-push لإشعارات APNs
│   ├── presence-alarm.wav    ← صوت «أثبت تواجدك» (يولّده ci/gen_presence_alarm.py)
│   └── FieldSales.entitlements ← صلاحيتا الإشعارات (لإعداد Release وحده)
├── ci/                       ← fsp-check (فحص Swift للمتجهات الذهبية) + print_payload_vectors.json + check_push.py + gen_presence_alarm.py
├── Podfile                   ← Firebase/Messaging ~> 11.0
├── assets/AppIcon-1024.png   ← أيقونة المتجر
└── metadata/                 ← بيانات المتجر
```

---

## المنجز
- ✅ `assets/AppIcon-1024.png` — أيقونة المتجر (1024×1024، RGB بلا ألفا، زوايا مربّعة — مطابقة لشرط آبل).
- ✅ `ENROLLMENT.md` — دليل تسجيل المالك خطوة بخطوة.
- ✅ `metadata/app-store-listing.md` — الاسم/العنوان/الوصف/الكلمات/الروابط (عربي + إنجليزي).

## المتبقّي (بلا انتظار الحساب)
- مشروع iOS من PWABuilder → مستودع `ios-app` يتصل به Codemagic.
- `codemagic.yaml` + توثيق ربط Codemagic ومفتاح App Store Connect API.
- لقطات شاشة iPhone (6.7" و6.5") من المعاينة الحيّة.
- `metadata/app-privacy.md` (استبيان الخصوصية — الموقع GPS تحديداً).
- `metadata/review-notes.md` (ملاحظات المراجِع + حساب مراجعة تجريبي).

## يحتاج الحساب مفعّلاً
- تسجيل Bundle ID `net.fieldsa.rep` + إنشاء App record.
- مفتاح App Store Connect API (للتوقيع/الرفع في Codemagic).
- الرفع، ملء الصفحة، والإرسال للمراجعة.

---

## قرار معلّق على المالك
**فرد أم شركة** في التسجيل؟ (يؤثّر على اسم البائع واسم الحزمة). التوصية: **شركة** إن توفّر D‑U‑N‑S. التفصيل في [`ENROLLMENT.md`](ENROLLMENT.md).
