# إشعارات تطبيق المندوب على الآيفون (APNs) — ملاحظات المراجعة والخصوصية والتوقيع

> ملفٌّ مستقلّ عن `review-notes.md` عمداً (جلسةٌ أخرى تعدّله). فقرة «Notes» الإنجليزية أدناه تُلصق **مضافةً** إلى ملاحظات
> المراجع في App Store Connect ← App Review Information ← Notes، مع الإصدار الأول الذي يحمل الإشعارات.

## ما الذي يُرسل ولماذا (للمرجع الداخلي)

نوعان فقط، كلاهما من حساب شركة المندوب نفسها وله وحده، ولا شيء سواهما عبر APNs:

| النوع | الوسم (`tag` = `apns-collapse-id`) | `interruption-level` | الصوت | الصلاحية |
|---|---|---|---|---|
| **«أثبت تواجدك»** — التحقق العشوائي من التواجد إن فعّله مدير الشركة لهذا المندوب، أثناء نوبته | `presence` (طلبٌ أحدث يحلّ محلّ الأقدم في مركز الإشعارات) | `time-sensitive` | `presence-alarm.wav` من الحزمة (٢٨ ثانية) | تنتهي مع نافذة الردّ: `apns-expiration` = الآن + ١٥ دقيقة |
| **تذكيرات الحضور** — «قبل بداية الدوام» و«نسيت الانصراف» حسب جدول الدوام الذي وضعته الشركة | `att-PRE_SHIFT` / `att-FORGOT_CHECKOUT` | `active` | الافتراضي `default` | ساعة واحدة |

- **لا تسويق ولا عروض** عبر الإشعارات أبداً (البند 4.5.4، وإرشادات HIG: لا `time-sensitive` لغير ما يلزم الآن).
- النصّ عامّ بلا بيانات عملاء ولا مبالغ ولا مواقع: «أثبت تواجدك — افتح التطبيق خلال دقيقتين واضغط «أثبت تواجدي»»،
  و«تذكير بالحضور»/«لم تسجّل انصرافك» مع وقت النوبة فقط.
- الصوت ملفّ WAV (PCM 16-bit أحادي 22050 هرتز) أقصر من ٣٠ ثانية، يُعزف مرّة ويحترم مفتاح الصامت (الصامت = اهتزاز).
  لا «تنبيهات حرجة» (Critical Alerts): صلاحيتها لآبل وحدها ولا تنطبق علينا، ولا شارة عدّاد على الأيقونة.
- لا إشعارات صامتة ولا وضع خلفية `remote-notification`: كل إشعارٍ يراه المندوب.
- لمس الإشعار يفتح شاشته داخل التطبيق (طلب التواجد أو شاشة الحضور)، والتطبيق في الواجهة يعرض الإشعار بصوته ويفتح الطلب.
- **الإذن يُطلب مرّةً واحدة وفي سياقه**: فقط حين يضغط المندوب «تفعيل التنبيهات» في شاشة الحضور (البصمة) — لا شاشة شرحٍ
  مسبقة ولا طلب عند الإقلاع. بعد الإذن يعيد التطبيق تسجيل الجهاز بصمت عند كل إقلاع ودخول (آبل: الرمز قد يتغيّر).
- الإشعارات **اختيارية** (البند 4.5.4 و5.1.2): من يرفضها يعمل التطبيق له كما هو، ويظهر طلب التواجد داخل التطبيق عند فتحه.
- **رمز الجهاز** يذهب إلى خادمنا وحده لإيصال هذه الإشعارات للمندوب المسجّل، ويُحذف عند تسجيل الخروج (وإن لم تكن شبكةٌ
  لحظتها أُعيدت المحاولة لاحقاً) أو حين تقول آبل إنه لم يعد صالحاً (410). الجزء الأصلي من التطبيق يُبقيه في الذاكرة وحدها (يُطلب من آبل عند كل إقلاع)، والصفحة تحفظ عنوان
  اشتراكها (`fs_push_apns`) لتحذفه من الخادم عند الخروج. لا يُستعمل لتتبّع ولا إعلان.

## Notes (انسخها كما هي — بالإنجليزية للمراجع)

```
Push notifications (this version):
The app can now receive two kinds of work notifications. Both are sent only by the rep's own employer
account, only to that rep, and only about the rep's working day:
1) "Confirm your presence" requests: if the company admin enabled random presence checks for the rep, the
   rep occasionally gets a request during their shift and confirms it in the app. Each request expires after
   15 minutes, so it is marked Time Sensitive and uses an alarm sound bundled with the app (under 30 seconds,
   it respects the Ring/Silent switch). These requests are random by design, so they cannot be triggered on
   demand.
2) Attendance reminders ("your shift starts soon, check in" / "you have not checked out"), sent according to
   the shift schedule set by the company. These are normal (Active) notifications with the default sound.
No marketing or promotional notifications are ever sent. Notification text contains no customer, financial
or location data. The app does not use Critical Alerts, badges or silent background notifications.

Notifications are optional. Permission is requested only when the rep taps "Turn on alerts" on the
attendance screen; it is never requested at launch. If the rep declines, the app works exactly the same and
a pending presence request appears inside the app when it is opened. The rep can change this at any time in
iOS Settings.

The device push token is sent only to our own server to deliver these notifications to the signed-in rep,
and is removed when the rep signs out (retried later if the phone is offline at that moment) or when Apple
reports it inactive. It is not used for tracking or advertising.
```

> «Turn on alerts» = ترجمة زرّ «تفعيل التنبيهات» في الواجهة الإنجليزية (web-admin/src/i18n/strings.ts) — إن تغيّرت فعدّل
> الجملة لتطابقها. ولا تذكر أي مزوّد دفع.

## App Privacy (App Store Connect) — تحديث مطلوب مع هذا الإصدار

- أضف **Identifiers → Device ID** (رمز الإشعار للجهاز): الغرض **App Functionality** · Linked to the user: **Yes** ·
  Used for tracking: **No**. (يُجمع باستمرار بعد الإذن، فلا يندرج تحت «الإفصاح الاختياري».)
- لا تغيير في Financial Info (يبقى «لا»)، ولا App Tracking Transparency (لا تتبّع).
- لا يلزم Privacy Manifest لأجل الإشعارات: `UNUserNotificationCenter` و`registerForRemoteNotifications` ليستا من
  واجهات «السبب المطلوب»، والرمز في الذاكرة لا في مخزن الإعدادات (حارس الوورك فلو على تلك الواجهات باقٍ كما هو).
- سياسة الخصوصية fieldsa.net/privacy: أضف جملةً عن رمز الإشعار (الغرض: إيصال تنبيهات العمل للمندوب، والحذف عند الخروج).
- طابِق `app-privacy.md` عند تحديث الاستبيان.

## التوقيع (للمرجع)

- `FieldSales/FieldSales.entitlements` فيه مفتاحان حرفياً لا غير: `aps-environment = production` و
  `com.apple.developer.usernotifications.time-sensitive = true`.
- يشير إليه `CODE_SIGN_ENTITLEMENTS` في إعداد **Release** للهدف وحده (بناء TestFlight/App Store)، ولا يُذكر الملف في
  أي مرحلة بناء ولا مجموعة في المشروع (درس انهيار البناء 4: ملف صلاحيات صار مورداً). إعداد Debug بلا إشعارات عمداً.
- `ci/check_push.py` يحرس ذلك كله (ويعمل على ويندوز وفي الوورك فلو): بصمة الملف ومفاتيحه، وسطرٌ واحد يذكر
  entitlements في المشروع داخل إعداد Release، والصوت مورد في الحزمة ويُعاد توليده بايتاً ببايت، وبلا واجهات «السبب
  المطلوب»، والإصدار 1.1.0 في الإعدادين.
- قبل الرفع (Fastfile): يتوقف البناء إن لم يمنح ملف التعريف الصلاحيتين، أو لم يحملهما البينارِي الموقَّع، أو ظهرت فيه
  صلاحيةٌ غريبة، أو `get-task-allow` مفعّل — فلا يُرفع بناءٌ يُقتل عند الإقلاع.
- القدرتان في App ID ‏`net.fieldsa.rep` بيد المالك: Push Notifications (بلا شهادات SSL) وTime Sensitive Notifications.
  تفعيلهما يُبطل ملف التعريف الحالي فيجدّده match وحده في البناء التالي؛ وإن لم يُبطَل وتوقف البناء برسالة «ملف تعريف …
  لا يمنح …» فتشغيلٌ يدويّ واحد للوورك فلو `ios-testflight` بخيار `renew_profile` (يكتب في مستودع التوقيع المشترك مع «بدر»).
- **⚠️ ترتيب الدمج — شرطٌ قبل الدمج لا بعده:** لا يُدمج `feature/ios-push` في `ios-app` إلا بعد أن يفعّل المالك القدرتين
  في App ID. كل دفعٍ إلى `ios-app` يشغّل `fastlane ios beta`، وملف تعريفٍ ما زال صالحاً بلا الصلاحيتين يوقف البناء قبل
  الترجمة برسالة «ملف تعريف … لا يمنح …» (الدفع العادي لا يجدّده) — فيتوقف كل بناء TestFlight بعده، ومنه فرع التتبّع
  الخلفي وأي إصلاحٍ عاجل، حتى تُفعَّل القدرتان. التوقف مقصود (لا بينارِي تخالف صلاحياته ملف تعريفه)، والعلاج الترتيب.
- **الدمج مع فرع التتبّع الخلفي** (`feature/ios-bg-tracking`): وورك فلو `ios-build-check.yml` هناك (و`codemagic.yaml`
  المتقاعد) ما زال يرفض أي `CODE_SIGN_ENTITLEMENTS` في المشروع، فيحمرّ فحص ترجمتهم على أي شجرةٍ فيها الإشعارات وإن لم
  يتعارض الدمج نصياً. عند الدمج يُستبدل سطر `grep -q CODE_SIGN_ENTITLEMENTS …` هناك بـ`python3 -I ci/check_push.py` كما في
  `ios-testflight.yml` — يعدّله صاحب ذلك الفرع أو المنسّق، لا هذا الفرع.
- الإرسال من الخادم بمفتاح APNs (‎.p8‎) من متغيرات البيئة وحدها (`APNS_KEY_P8`، `APNS_KEY_ID`، `APNS_TEAM_ID`،
  `APNS_TOPIC` اختياري) — لا يدخل المفتاح المستودع أبداً.
