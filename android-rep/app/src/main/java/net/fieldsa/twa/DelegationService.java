package net.fieldsa.twa;

import com.google.androidbrowserhelper.locationdelegation.LocationDelegationExtraCommandHandler;


public class DelegationService extends
        com.google.androidbrowserhelper.trusted.DelegationService {
    @Override
    public void onCreate() {
        super.onCreate();
        // تفويض الموقع: التطبيق يعلن إذنَي الموقع، فChrome يسأل هذه الخدمة عن كل navigator.geolocation في الصفحة
        // (checkAndroidLocationPermission ثم startLocation/stopLocation). بلا هذا المعالج تردّ المكتبة «لا أعرف الأمر»
        // فيرفض Chrome الموقع فوراً بلا سؤال، ولا يغيّر ذلك إذنُ الموقع في إعدادات Chrome. يحرسه LocationDelegationGuardTest.
        // الخدمة مفعّلة بـ@bool/enableNotification (enableNotifications في twa-manifest.json): إطفاؤها يُطفئ التفويض أيضاً
        registerExtraCommandHandler(new LocationDelegationExtraCommandHandler());
    }

    /**
     * الأمر يصل على خيط Binder بهوية Chrome (المتّصل)، والمعالج يقرّر الدقة العالية بـcheckCallingOrSelfPermission(FINE):
     * بهوية Chrome يُفحص إذن Chrome لا إذن التطبيق، فإن لم يملك Chrome الموقع الدقيق صارت كل القراءات «متوازنة» (واي فاي
     * وأبراج، كثيراً فوق ١٠٠ م) فلا يقبلها قيد الموقع. checkCaller() تحقّق من المتّصل قبل هذا، فمحو الهوية هنا آمن
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
}

