package net.fieldsa.twa;

import android.Manifest;
import android.app.ActivityManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.RemoteException;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.browser.trusted.TrustedWebActivityCallbackRemote;

import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationAvailability;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.androidbrowserhelper.locationdelegation.PermissionRequestActivity;
import com.google.androidbrowserhelper.trusted.ExtraCommandHandler;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * تفويض الموقع من Chrome إلى التطبيق (بلاغ المالك ٣ نوفمبر ٢٠٢٦: 1.2.2 بمعالج المكتبة وبقي المندوب «بلا موقع» أو «موقعه متوقف»).
 * يحلّ محلّ LocationDelegationExtraCommandHandler من androidbrowserhelper لثلاثة عيوب فيه:
 * - يوقف التحديثات نهائياً عند أول onLocationAvailability(false) (مبنى، نفق، إشارة ضعيفة)، ولا يعيدها حتى تبدأ الصفحة طلباً جديداً.
 * - يرسل الخطأ باسم onNewErrorAvailable، وChrome لا يسمع إلا onNewLocationError، فتنتظر الصفحة بلا جواب ولا خطأ.
 * - يفتح نشاط الإذن من الخلفية في كل سؤال ولو كان الإذن ممنوحاً، وأندرويد 14+ قد يمنعه فيبقى السؤال معلّقاً.
 * الأوامر الثلاثة كما يرسلها Chrome (TrustedWebActivityClient): checkAndroidLocationPermission وstartLocation وstopLocation.
 * كل الحالة على الخيط الرئيسي، والأوامر تصل على خيط Binder فتُرحَّل إليه.
 */
final class LocationDelegation implements ExtraCommandHandler {
    private static final String TAG = "FsLocation";

    static final String CHECK_PERMISSION = "checkAndroidLocationPermission";
    static final String START_LOCATION = "startLocation";
    static final String STOP_LOCATION = "stopLocation";
    // أسماء الردود كما يقرؤها Chrome (InstalledWebappGeolocationBridge وTrustedWebActivityClient) حرفياً
    static final String CALLBACK_LOCATION = "onNewLocationAvailable";
    static final String CALLBACK_ERROR = "onNewLocationError";
    private static final String PERMISSION_RESULT = "locationPermissionResult";

    private static final long INTERVAL_MS = 1000;
    private static final long FASTEST_INTERVAL_MS = 500;
    /**
     * قراءةٌ عمرها الحقيقي (منذ التقاطها لا منذ وصولها) دون هذا تُسلَّم فوراً لطلبٍ جديد، ومثلها آخر قراءة عند البدء. أكبر من هذا
     * لا: Chrome لا يطبّق maximumAge على ما نسلّمه، فقراءةٌ قديمة تمرّ لطلب «طازج» (البصمة بموقع العميل) كأنها جديدة
     */
    private static final long FRESH_MAX_AGE_MS = 3000;
    /** قراءة الشبكة تُهمَل ما دامت قراءة GPS أحدث من هذا (مزوّد أندرويد بلا خدمات Google وحده) */
    private static final long GPS_PREFERRED_MS = 10_000;
    /**
     * إيقافٌ مؤجَّل: Chrome يوقف جسر الصفحة القديم ويبدأ الجديد (clearWatch ثم watchPosition، أو إخفاءٌ وعودة) بأمرين منفصلين،
     * فبدءٌ خلال هذه المهلة يلغي الإيقاف ولا ينقطع المزوّد
     */
    private static final long STOP_GRACE_MS = 3000;
    /**
     * stopLocation لا يحمل هوية الجسر (TrustedWebActivityClient يرسله بلا ردّ)، فإيقافٌ من جسرٍ مهدوم قد يصل وصفحةٌ أخرى ما زالت
     * تسمع. فلا يُنفَّذ ما دام Chrome ظاهراً (عمليتنا مربوطة بنشاطٍ ظاهر)، ويُعاد الفحص بعد هذه المدة حتى يختفي أو يصل بدء
     */
    private static final long VISIBLE_RECHECK_MS = 30_000;
    /**
     * سؤال الإذن من نشاط الخلفية قد يُمنع بصمت (أندرويد 14+): بعد هذه المهلة يُجاب «مرفوض» فلا تبقى الصفحة معلّقة. منحٌ أبطأ منها
     * يسري من الطلب التالي (Chrome يقرأ إذن التطبيق في كل طلب)، والفتح التالي للتطبيق يسأل بنفسه
     */
    private static final long PERMISSION_WATCHDOG_MS = 15_000;
    private static final int MAX_CALLBACKS = 8;
    /** مزوّدٌ يعمل ولم يسلّم قراءةً منذ هذا: startLocation جديد (اتصال Geolocation جديد في الصفحة) يعيد تشغيله */
    private static final long SILENT_RESTART_MS = 5000;

    private final Handler mMain = new Handler(Looper.getMainLooper());
    private final LinkedHashSet<TrustedWebActivityCallbackRemote> mCallbacks = new LinkedHashSet<>();
    private final Runnable mStopRunnable = this::stopIfHidden;

    private final Context mContext;
    @Nullable private FusedLocationProviderClient mFused;
    @Nullable private LocationManager mManager;
    private boolean mRunning;
    /** يزيد مع كل تشغيلٍ للمزوّد: ردٌّ متأخر من تشغيلٍ سابق (فشل الطلب، آخر قراءة) لا يمسّ الحالي */
    private int mGeneration;
    private boolean mUsingFused;
    private boolean mHighAccuracy;
    @Nullable private Location mLastFix;
    private long mLastFixElapsed;
    private long mLastGpsElapsed;

    LocationDelegation(Context context) {
        mContext = context.getApplicationContext();
    }

    private final LocationCallback mFusedCallback = new LocationCallback() {
        @Override
        public void onLocationResult(@NonNull LocationResult result) {
            onFix(result.getLastLocation());
        }

        @Override
        public void onLocationAvailability(@NonNull LocationAvailability availability) {
            // لا إيقاف هنا: «غير متاح» حالٌ عابر (مبنى، إشارة)، وتعود القراءات وحدها حين تتغيّر البيئة
            Log.d(TAG, "availability=" + availability.isLocationAvailable());
        }
    };

    private final LocationListener mPlatformListener = new LocationListener() {
        @Override
        public void onLocationChanged(@NonNull Location location) {
            onFix(location);
        }

        @Override
        public void onProviderEnabled(@NonNull String provider) {}

        @Override
        public void onProviderDisabled(@NonNull String provider) {}

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}
    };

    @NonNull
    @Override
    public Bundle handleExtraCommand(Context context, String commandName, Bundle args,
            @Nullable TrustedWebActivityCallbackRemote callback) {
        Bundle result = new Bundle();
        result.putBoolean(EXTRA_COMMAND_SUCCESS, false);
        switch (commandName) {
            case CHECK_PERMISSION:
                if (callback == null) break;
                checkPermission(callback);
                result.putBoolean(EXTRA_COMMAND_SUCCESS, true);
                break;
            case START_LOCATION:
                if (callback == null) break;
                // enableHighAccuracy لا يُقرأ: قيد الموقع يحتاج الدقة العالية دائماً، وتُطلب متى مُنح الموقع الدقيق
                mMain.post(() -> start(callback));
                result.putBoolean(EXTRA_COMMAND_SUCCESS, true);
                break;
            case STOP_LOCATION:
                mMain.post(() -> {
                    mMain.removeCallbacks(mStopRunnable);
                    mMain.postDelayed(mStopRunnable, STOP_GRACE_MS);
                });
                result.putBoolean(EXTRA_COMMAND_SUCCESS, true);
                break;
        }
        return result;
    }

    /** الخدمة تُهدم (Chrome فكّ الربط): لا مزوّد يعمل بعدها، ولا فحصٌ مؤجَّل */
    void shutdown() {
        mMain.post(this::stopNow);
    }

    // ── الإذن ──────────────────────────────────────────────────────────────────────────────────

    private void checkPermission(TrustedWebActivityCallbackRemote callback) {
        // ممنوحٌ (طلبه LauncherActivity عند الفتح): جوابٌ فوري بلا نشاط، فلا يتوقف شيء على منع الفتح من الخلفية
        if (hasAnyPermission()) {
            answerPermission(callback, true);
            return;
        }
        try {
            // نشاط المكتبة: يسأل ويجيب Chrome بنفسه
            PermissionRequestActivity.requestLocationPermission(mContext, callback);
        } catch (RuntimeException e) {
            Log.w(TAG, "permission activity failed", e);
            answerPermission(callback, false);
            return;
        }
        // الحارس: Chrome يحتسب أول جوابٍ وحده (LocationPermissionUpdater)، فجوابه بعد جواب النشاط يُهمل
        mMain.postDelayed(() -> {
            if (!hasAnyPermission()) answerPermission(callback, false);
        }, PERMISSION_WATCHDOG_MS);
    }

    private static void answerPermission(TrustedWebActivityCallbackRemote callback, boolean granted) {
        Bundle result = new Bundle();
        result.putBoolean(PERMISSION_RESULT, granted);
        try {
            callback.runExtraCallback(CHECK_PERMISSION, result);
        } catch (RemoteException e) {
            // Chrome أُغلق: لا أحد ينتظر
        }
    }

    private boolean granted(String permission) {
        return mContext.checkPermission(permission, Process.myPid(), Process.myUid())
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAnyPermission() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION)
                || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    // ── البدء والإيقاف (الخيط الرئيسي) ───────────────────────────────────────────────────────────

    private void start(TrustedWebActivityCallbackRemote callback) {
        mMain.removeCallbacks(mStopRunnable);
        if (!hasAnyPermission()) {
            sendError(callback, "Application does not have location permission.");
            return;
        }
        // كل أمرٍ يصل بغلافٍ جديد للردّ (حتى من الجسر نفسه)، فلا تكرار يُزال: الجسور المهدومة يتجاهل Chrome ما يصلها، والسقف يحدّها
        mCallbacks.add(callback);
        while (mCallbacks.size() > MAX_CALLBACKS) {
            mCallbacks.remove(mCallbacks.iterator().next());
        }
        boolean high = granted(Manifest.permission.ACCESS_FINE_LOCATION);
        boolean silent = SystemClock.elapsedRealtime() - mLastFixElapsed > SILENT_RESTART_MS;
        // يعمل ويسلّم قراءات: يبقى كما هو. متوقفٌ أو صامت (أو تغيّر الإذن الدقيق): يُعاد تشغيله. Chrome يرسل البدء مع كل اتصال
        // Geolocation جديد في الصفحة (لا مع كل طلب على اتصالٍ قائم)
        if (!mRunning || silent || high != mHighAccuracy) {
            Log.d(TAG, "start providers (running=" + mRunning + ", silent=" + silent + ", high=" + high + ")");
            stopProviders();
            mHighAccuracy = high;
            startProviders();
        }
        // قراءةٌ حديثة جداً تُسلَّم للطلب الجديد فوراً
        if (mLastFix != null && isFresh(mLastFix)) {
            deliver(callback, toBundle(mLastFix));
        }
    }

    private void stopIfHidden() {
        if (mRunning && isOnScreen()) {
            Log.d(TAG, "stop deferred: still on screen");
            mMain.postDelayed(mStopRunnable, VISIBLE_RECHECK_MS);
            return;
        }
        stopNow();
    }

    /** عمليتنا مربوطة بنشاطٍ ظاهر (صفحة TWA في Chrome، أو نشاطٌ لنا كالتحصيل والطباعة) */
    private static boolean isOnScreen() {
        try {
            ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();
            ActivityManager.getMyMemoryState(info);
            return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE;
        } catch (RuntimeException e) {
            return false;
        }
    }

    private void stopNow() {
        if (mRunning) Log.d(TAG, "stop providers");
        mMain.removeCallbacks(mStopRunnable);
        stopProviders();
        mCallbacks.clear();
        mLastFix = null;
    }

    private void startProviders() {
        mRunning = true;
        final int generation = ++mGeneration;
        if (isPlayServicesAvailable()) {
            try {
                if (mFused == null) mFused = LocationServices.getFusedLocationProviderClient(mContext);
                LocationRequest request = new LocationRequest.Builder(
                        mHighAccuracy ? Priority.PRIORITY_HIGH_ACCURACY : Priority.PRIORITY_BALANCED_POWER_ACCURACY,
                        INTERVAL_MS)
                        .setMinUpdateIntervalMillis(FASTEST_INTERVAL_MS)
                        .setWaitForAccurateLocation(false)
                        .build();
                mUsingFused = true;
                mFused.requestLocationUpdates(request, mFusedCallback, Looper.getMainLooper())
                        .addOnFailureListener(e -> {
                            Log.w(TAG, "fused requestLocationUpdates failed", e);
                            if (mRunning && mUsingFused && generation == mGeneration) {
                                mUsingFused = false;
                                startPlatform();
                            }
                        });
                mFused.getLastLocation().addOnSuccessListener(location -> {
                    if (location != null && generation == mGeneration && isFresh(location)) onFix(location);
                });
                return;
            } catch (RuntimeException e) {
                // SecurityException أو خدمات Google معطوبة: مزوّد أندرويد بديلاً
                Log.w(TAG, "fused unavailable", e);
                mUsingFused = false;
            }
        }
        startPlatform();
    }

    /** بلا خدمات Google (هواوي مثلاً): GPS والشبكة معاً، فداخل المبنى تصل قراءة الشبكة وخارجه GPS */
    private void startPlatform() {
        if (mManager == null) mManager = (LocationManager) mContext.getSystemService(Context.LOCATION_SERVICE);
        if (mManager == null) {
            broadcastError("Location service unavailable.");
            return;
        }
        List<String> providers = new ArrayList<>();
        if (mHighAccuracy && mManager.getAllProviders().contains(LocationManager.GPS_PROVIDER)) {
            providers.add(LocationManager.GPS_PROVIDER);
        }
        if (mManager.getAllProviders().contains(LocationManager.NETWORK_PROVIDER)) {
            providers.add(LocationManager.NETWORK_PROVIDER);
        }
        boolean any = false;
        for (String provider : providers) {
            try {
                mManager.requestLocationUpdates(provider, INTERVAL_MS, 0f, mPlatformListener, Looper.getMainLooper());
                any = true;
                Location last = mManager.getLastKnownLocation(provider);
                if (last != null && isFresh(last)) onFix(last);
            } catch (SecurityException | IllegalArgumentException e) {
                Log.w(TAG, "platform provider " + provider + " failed", e);
            }
        }
        if (!any) broadcastError("Unable to request location updates.");
    }

    private void stopProviders() {
        if (!mRunning) return;
        mRunning = false;
        if (mFused != null) {
            try {
                mFused.removeLocationUpdates(mFusedCallback);
            } catch (RuntimeException e) {
                // لا شيء
            }
        }
        if (mManager != null) {
            try {
                mManager.removeUpdates(mPlatformListener);
            } catch (RuntimeException e) {
                // لا شيء
            }
        }
        mUsingFused = false;
    }

    private boolean isPlayServicesAvailable() {
        try {
            return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(mContext)
                    == ConnectionResult.SUCCESS;
        } catch (RuntimeException e) {
            return false;
        }
    }

    // ── القراءات ───────────────────────────────────────────────────────────────────────────────

    private static boolean isFresh(Location location) {
        long ageMs = (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos()) / 1_000_000L;
        return ageMs >= 0 && ageMs <= FRESH_MAX_AGE_MS;
    }

    private void onFix(@Nullable Location location) {
        if (location == null || !mRunning) return;
        long now = SystemClock.elapsedRealtime();
        if (LocationManager.GPS_PROVIDER.equals(location.getProvider())) {
            mLastGpsElapsed = now;
        } else if (!mUsingFused && LocationManager.NETWORK_PROVIDER.equals(location.getProvider())
                && mLastGpsElapsed != 0 && now - mLastGpsElapsed < GPS_PREFERRED_MS) {
            return;
        }
        mLastFix = location;
        mLastFixElapsed = now;
        Bundle bundle = toBundle(location);
        for (TrustedWebActivityCallbackRemote callback : new ArrayList<>(mCallbacks)) {
            deliver(callback, bundle);
        }
    }

    private static Bundle toBundle(Location location) {
        // المفاتيح كما يقرؤها InstalledWebappGeolocationBridge.notifyNewGeoposition (الوقت بالملّي‌ثانية)
        Bundle b = new Bundle();
        b.putDouble("latitude", location.getLatitude());
        b.putDouble("longitude", location.getLongitude());
        b.putLong("timeStamp", location.getTime());
        if (location.hasAltitude()) b.putDouble("altitude", location.getAltitude());
        if (location.hasAccuracy()) b.putDouble("accuracy", location.getAccuracy());
        if (location.hasBearing()) b.putDouble("bearing", location.getBearing());
        if (location.hasSpeed()) b.putDouble("speed", location.getSpeed());
        return b;
    }

    private void deliver(TrustedWebActivityCallbackRemote callback, Bundle bundle) {
        try {
            callback.runExtraCallback(CALLBACK_LOCATION, bundle);
        } catch (RemoteException | RuntimeException e) {
            // جسرٌ في Chrome لم يعد موجوداً: يُحذف، وبلا أحدٍ يسمع يتوقف المزوّد
            mCallbacks.remove(callback);
            if (mCallbacks.isEmpty()) stopProviders();
        }
    }

    private static void sendError(TrustedWebActivityCallbackRemote callback, String message) {
        Bundle b = new Bundle();
        b.putString("message", message);
        try {
            callback.runExtraCallback(CALLBACK_ERROR, b);
        } catch (RemoteException | RuntimeException e) {
            // لا شيء
        }
    }

    private void broadcastError(String message) {
        for (TrustedWebActivityCallbackRemote callback : new ArrayList<>(mCallbacks)) {
            sendError(callback, message);
        }
    }
}
