package net.fieldsa.twa;


public class DelegationService extends
        com.google.androidbrowserhelper.trusted.DelegationService {
    private LocationDelegation mLocation;

    @Override
    public void onCreate() {
        super.onCreate();
        // تفويض الموقع: التطبيق يعلن إذنَي الموقع، فChrome يسأل هذه الخدمة عن كل navigator.geolocation في الصفحة
        // (checkAndroidLocationPermission ثم startLocation/stopLocation). بلا معالجٍ يرفض Chrome الموقع فوراً بلا سؤال، ولا يغيّر
        // ذلك إذنُ الموقع في إعدادات Chrome. معالجنا لا معالج المكتبة (1.2.2 أوقف التتبّع عند أول انقطاع إشارة، انظر
        // LocationDelegation). يحرسه LocationDelegationGuardTest.
        // الخدمة مفعّلة بـ@bool/enableNotification (enableNotifications في twa-manifest.json): إطفاؤها يُطفئ التفويض أيضاً
        mLocation = new LocationDelegation(this);
        registerExtraCommandHandler(mLocation);
    }

    @Override
    public void onDestroy() {
        if (mLocation != null) mLocation.shutdown();
        super.onDestroy();
    }

    /**
     * الأمر يصل على خيط Binder بهوية Chrome (المتّصل). معالجنا يفحص إذن التطبيق بمعرّفه صراحةً، ومحو الهوية هنا يبقى لكل ما
     * يفحص بـcheckCallingOrSelfPermission (نشاط الإذن في المكتبة وخدمات Google). checkCaller() تحقّق من المتّصل قبل هذا، فمحوها آمن
     */
    @Override
    public android.os.Bundle onExtraCommand(String commandName, android.os.Bundle args,
            androidx.browser.trusted.TrustedWebActivityCallbackRemote callback) {
        final long token = android.os.Binder.clearCallingIdentity();
        try {
            return super.onExtraCommand(commandName, args, callback);
        } finally {
            android.os.Binder.restoreCallingIdentity(token);
        }
    }

    /**
     * «أثبت تواجدك» (التحقق العشوائي من التواجد): إشعار الوسم 'presence' وحده يُنشر على قناة الإنذار (PresenceAlarm) — صوت منبّه
     * واهتزاز يتكرّران حتى يُلمس أو يُغلق أو يُفتح الدرج، بسقف ثلاث دقائق. كل إشعارٍ آخر، أو قناة الإنذار محظورة، أو أي خطأ: المكتبة
     * كما هي (super). الإلغاء بلا تغيير: onCancelNotification في المكتبة يلغي بالوسم والمعرّف أيّاً كانت القناة. يحرسه PresenceAlarmTest
     */
    @Override
    public boolean onNotifyNotificationWithChannel(String platformTag, int platformId,
            android.app.Notification notification, String channelName) {
        if (PresenceAlarm.isPresenceTag(platformTag)
                && PresenceAlarm.notify(this, platformTag, platformId, notification)) {
            return true;
        }
        return super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channelName);
    }
}
