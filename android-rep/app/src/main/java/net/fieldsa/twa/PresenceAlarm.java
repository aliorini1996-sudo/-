package net.fieldsa.twa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;

/**
 * إنذار «أثبت تواجدك» (التحقق العشوائي من التواجد، طلب المالك ٤ نوفمبر ٢٠٢٦). إشعار الويب ذو الوسم 'presence' وحده
 * (presencePayload في backend/src/services/presenceChecks.ts، ثم web-admin/public/sw.js) يُعاد نشره على قناةٍ خاصة: صوت منبّه
 * (USAGE_ALARM) واهتزاز يتكرّران (FLAG_INSISTENT) حتى يُلغى الإشعار أو يُفتح درج الإشعارات، وبسقف ثلاث دقائق (setTimeoutAfter).
 * - Chrome يسلّم الإشعار مبنيّاً إلى DelegationService، ووسم الويب في platformTag وحده بصيغة p[b]#<الأصل>#1<الوسم>
 *   (NotificationIdGenerator؛ بلا وسم: ‎#0‎ ورقم)، والمعرّف دائماً ‎-1‎ (NotificationPlatformBridge.PLATFORM_ID).
 * - النشر بالوسم والمعرّف نفسيهما: notification.close() من الصفحة أو من sw.js (اللمس) يصل onCancelNotification في المكتبة
 *   فيلغيه أيّاً كانت قناته، ويسكت الرنين معه.
 * - false = لم يُنشر هنا: DelegationService يسلّمه للمكتبة (super) إشعاراً عادياً على قناة «عام» — لا يضيع طلب تواجد أبداً.
 * - بلا أذونات جديدة: لا USE_FULL_SCREEN_INTENT ولا ACCESS_NOTIFICATION_POLICY ولا VIBRATE (النظام يهتزّ بهويته هو). وCATEGORY_ALARM
 *   يعبر «عدم الإزعاج» بإعداده الافتراضي (المنبّهات مسموحة) بلا إذن. يحرسه PresenceAlarmTest.
 * الدوال الخالصة (isPresenceTag وisSilentRequest وretiredChannelIds) بلا أي استدعاء أندرويد: تُختبر على JVM.
 */
final class PresenceAlarm {
    private static final String TAG = "FsPresence";

    /** وسم الويب لطلب التواجد (الخادم وsw.js)؛ تنبيهات البصمة att-* وغيرها لا تمرّ من هنا */
    static final String WEB_TAG = "presence";
    /**
     * الصوت والاهتزاز والأهمية تُجمَّد عند أول إنشاءٍ للقناة (أندرويد يتجاهل تغييرها بعده): أي تعديلٍ عليها = رفع CHANNEL_VERSION،
     * فتُنشأ قناةٌ جديدة وتُحذف السابقة (retiredChannelIds) مع أول إنذار
     */
    static final int CHANNEL_VERSION = 1;
    static final String CHANNEL_PREFIX = "presence_alarm_v";
    static final String CHANNEL_ID = CHANNEL_PREFIX + CHANNEL_VERSION;
    /**
     * سقف الرنين، كسقف الإنذار داخل التطبيق: بعده يزيل النظام الإشعار ويرسل deleteIntent إلى Chrome (كإغلاقه). الطلب نفسه يبقى في
     * التطبيق (متأخر حتى ١٥ دقيقة)
     */
    static final long TIMEOUT_MS = 3 * 60 * 1000L;
    /** يبدأ فوراً: ثلاث هزّات ثم سكون، والنمط كله يتكرّر من أوله مع FLAG_INSISTENT (≈٤ ثوانٍ للدورة) */
    static final long[] VIBRATION = {0, 700, 300, 700, 300, 700, 1200};

    private PresenceAlarm() {}

    /** platformTag من Chrome لإشعار الويب ذي الوسم 'presence' تماماً — لا ما يبدأ به ولا ما ينتهي به فحسب */
    static boolean isPresenceTag(String platformTag) {
        if (platformTag == null) return false;
        if (platformTag.equals(WEB_TAG)) return true; // مزوّد TWA آخر قد يمرّر وسم الويب خاماً
        int originAt = platformTag.indexOf('#');
        if (originAt < 0) return false;
        String kind = platformTag.substring(0, originAt); // p: من الصفحة أو عامل الخدمة، pb: يعرضه المتصفح عنها
        if (!kind.equals("p") && !kind.equals("pb")) return false;
        int tagAt = platformTag.indexOf('#', originAt + 1); // الأصل (origin) لا «#» فيه، فأول «#» بعده يفتح الوسم
        return tagAt > originAt + 1 && platformTag.substring(tagAt + 1).equals("1" + WEB_TAG);
    }

    /**
     * طلبت الصفحة silent:true: NotificationCompat في Chrome يجعل الإشعار غير الملخّص GROUP_ALERT_SUMMARY (بلا صوت ولا اهتزاز)،
     * فلا إنذار لإشعارٍ صامت — يمرّ عادياً
     */
    static boolean isSilentRequest(int groupAlertBehavior, int flags) {
        return groupAlertBehavior == Notification.GROUP_ALERT_SUMMARY && (flags & Notification.FLAG_GROUP_SUMMARY) == 0;
    }

    /** معرّفات القنوات السابقة (v1 … قبل الحالية) التي تُحذف حين يرتفع CHANNEL_VERSION */
    static String[] retiredChannelIds() {
        String[] out = new String[CHANNEL_VERSION - 1];
        for (int v = 1; v < CHANNEL_VERSION; v++) out[v - 1] = CHANNEL_PREFIX + v;
        return out;
    }

    /**
     * ينشر الإشعار على قناة الإنذار. true = نُشر هنا؛ false = لم يُمسّ شيء، والمتّصل يسلّمه للمكتبة كما هو.
     * يصل على خيط Binder: NotificationManager آمنٌ عليه، والنشر بهوية التطبيق كما تفعل المكتبة (لا حاجة لمحو هوية المتّصل)
     */
    static boolean notify(Context ctx, String platformTag, int platformId, Notification original) {
        if (original == null) return false;
        try {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm == null || !nm.areNotificationsEnabled()) return false;
            if (isSilentRequest(original.getGroupAlertBehavior(), original.flags)) return false;
            for (String old : retiredChannelIds()) {
                if (nm.getNotificationChannel(old) != null) nm.deleteNotificationChannel(old);
            }
            // متكرّرٌ بلا ضرر: القناة القائمة لا يتغيّر منها إلا اسمها ووصفها، وما عدّله المندوب فيها يبقى
            nm.createNotificationChannel(buildChannel(ctx));
            NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
            // حظرها المندوب من إعدادات التطبيق ⇒ إشعارٌ عادي (super). خفّضها فقط ⇒ تُحترم ويُنشر عليها
            if (ch == null || ch.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
            // recoverBuilder يتبنّى الكائن الذي يُعطاه ويعدّله: نسخةٌ، فيبقى الأصل سليماً لـsuper إن فشل ما بعده.
            // ما بناه Chrome يبقى كما هو (النص والأيقونة والنقر والحذف والنسخة العامة لشاشة القفل وonlyAlertOnce)
            Notification n = Notification.Builder.recoverBuilder(ctx, original.clone())
                    .setChannelId(CHANNEL_ID)
                    .setCategory(Notification.CATEGORY_ALARM) // يعبر «عدم الإزعاج» (allowAlarms) ويُستثنى من تخفيف التنبيهات
                    .setTimeoutAfter(TIMEOUT_MS)
                    .build();
            n.flags |= Notification.FLAG_INSISTENT; // رنينٌ متكرّر حتى يُلغى أو يُفتح الدرج (أو زرّ الصوت في أندرويد 12+)
            nm.notify(platformTag, platformId, n); // الوسم والمعرّف نفسهما ⇒ cancel من Chrome يزيله
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "presence alarm not posted, falling back to the default channel", e);
            return false;
        }
    }

    /** صوت المنبّه الذي اختاره المندوب (يتبعه دائماً) على مسار المنبّهات وبمستوى صوتها، واهتزاز VIBRATION */
    private static NotificationChannel buildChannel(Context ctx) {
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID,
                ctx.getString(R.string.presence_alarm_channel_name), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(ctx.getString(R.string.presence_alarm_channel_description));
        ch.setSound(channelSound(ctx), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        ch.enableVibration(true);
        ch.setVibrationPattern(VIBRATION);
        return ch;
    }

    /**
     * نغمة المنبّه إن وُجدت؛ بلاها («بلا صوت»، أو هاتفٌ لم يضبطها مصنّعه) يعجز المشغّل عن حلّ رابطها فيسكت الإنذار كله: نغمة
     * الرنين، ثم صوت الإشعار (صوت قناة «عام» نفسه — فلا يصير أخفت مما كان)، ومسار المنبّهات باقٍ في كلها. قراءة Settings.System
     * بلا إذن. يُجمَّد الاختيار مع القناة عند أول إنشاءٍ لها (CHANNEL_VERSION)
     */
    private static Uri channelSound(Context ctx) {
        if (RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_ALARM) != null) {
            return Settings.System.DEFAULT_ALARM_ALERT_URI;
        }
        if (RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE) != null) {
            return Settings.System.DEFAULT_RINGTONE_URI;
        }
        return Settings.System.DEFAULT_NOTIFICATION_URI;
    }
}
