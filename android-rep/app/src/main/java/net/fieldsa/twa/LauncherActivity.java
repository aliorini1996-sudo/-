/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package net.fieldsa.twa;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import net.fieldsa.twa.print.BridgeContract;
import net.fieldsa.twa.print.PrinterStore;


public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {
    // تفويض الموقع (DelegationService): Chrome يأخذ إذن الموقع من التطبيق لا من إعداداته. يُطلب هنا قبل فتح الصفحة، في كل
    // فتحٍ ما دام الدقيق غير ممنوح، لأن طلبه من داخل الصفحة (PermissionRequestActivity تفتحها الخدمة من الخلفية) لا يُعتمد عليه:
    // - أندرويد 14 فأحدث قد يمنع فتح نشاطٍ من الخلفية (android-browser-helper#499)، فيبقى طلب الموقع معلّقاً بلا جواب.
    // - أندرويد 8 إلى 10: Chrome يحفظ «مرفوض» من 1.2.0/1.2.1 ولا يسأل ثانيةً حتى يُمنح الإذن للتطبيق.
    // - بعض الواجهات (HyperOS/OxygenOS) تقتل الخدمة والسؤال مفتوح.
    // بعد المنح يجيب Chrome «مسموح» بلا سؤال. الرفض أو الرجوع يفتح الصفحة كالمعتاد، ويُسأل ثانيةً في الفتح التالي: 1.2.2 كان
    // يكفّ بعد رفضٍ واحد (أو إغلاق الحوار) فيبقى المندوب بلا موقع. لا حلقة: أندرويد نفسه يجيب «مرفوض» فوراً بلا حوار بعد
    // رفضين (أو «عدم السؤال مجدداً» على 8 إلى 10)، فتُفتح الصفحة في الحال
    private static final int LOCATION_REQUEST_CODE = 4201;
    private boolean mAwaitingLocationPermission;

    @Override
    protected boolean shouldLaunchImmediately() {
        if (!shouldAskLocationBeforeLaunch()) return true;
        mAwaitingLocationPermission = true;
        return false;
    }

    /** شرط Chrome نفسه للتفويض: الإذن معلنٌ في البيان المدمج، والدقيق غير ممنوح (التقريبي وحده يُسأل للترقية: قيد الموقع يحتاج الدقيق) */
    private boolean shouldAskLocationBeforeLaunch() {
        try {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED) {
                return false;
            }
            // البناء بلا رمز NearPay يُزيل أذونات الموقع (src/printonly)، فChrome يستعمل إذنه ولا داعي للسؤال هنا
            return declaresPermission(Manifest.permission.ACCESS_FINE_LOCATION);
        } catch (RuntimeException e) {
            return false; // أي تعذّر: تُفتح الصفحة فوراً كما كانت، والتفويض يسأل من داخلها
        }
    }

    private boolean declaresPermission(String permission) {
        try {
            String[] requested = getPackageManager()
                    .getPackageInfo(getPackageName(), PackageManager.GET_PERMISSIONS)
                    .requestedPermissions;
            if (requested == null) return false;
            for (String p : requested) {
                if (permission.equals(p)) return true;
            }
        } catch (PackageManager.NameNotFoundException e) {
            // حزمتنا نفسها: لا يقع
        }
        return false;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
            int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != LOCATION_REQUEST_CODE || !mAwaitingLocationPermission) return;
        // أياً كان الجواب (منح، رفض، رجوع بلا جواب) تُفتح الصفحة مرة واحدة
        mAwaitingLocationPermission = false;
        launchTwa();
    }


    

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Setting an orientation crashes the app due to the transparent background on Android 8.0
        // Oreo and below. We only set the orientation on Oreo and above. This only affects the
        // splash screen and Chrome will still respect the orientation.
        // See https://github.com/GoogleChromeLabs/bubblewrap/issues/496 for details.
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
        // FINE وCOARSE معاً: أندرويد 12+ يشترطهما في الطلب نفسه ويعرض «دقيق/تقريبي». الإعادة بعد تدويرٍ أو موت العملية
        // تفتح الصفحة فوراً (العلامة محفوظة) ويُهمل جوابٌ متأخر، فلا يبقى المندوب على شاشة فارغة
        if (mAwaitingLocationPermission && !isFinishing()) {
            requestPermissions(new String[] {
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST_CODE);
        }
    }

    @Override
    protected Uri getLaunchingUrl() {
        // Get the original launch Url.
        Uri uri = super.getLaunchingUrl();

        // وحدة التحصيل بالبطاقة: رجوعها (CardPayActivity.returnToWeb بـNEW_TASK|CLEAR_TASK) يجعل /rep?cardpay=<المعرّف>
        // «النيّة الأساس» للمهمّة. فتح المهمّة لاحقاً من قائمة التطبيقات الأخيرة يعيد تسليمها بـFLAG_ACTIVITY_LAUNCHED_FROM_HISTORY،
        // فتعرض الصفحة نتيجة دفعٍ قديم كأنه تحصيلٌ جديد. من القائمة الأخيرة يُسقط cardpay ويبقى ما سواه
        // ثم وسيط جسر الطباعة (fsbridge) على كل إطلاق
        return appendPrintBridge(stripStaleCardPay(uri));
    }

    /**
     * جسر الطباعة: كل إطلاقٍ يمرّ من هنا (تشغيلٌ بارد، رابط fieldsa.net، اختصار، رجوع التحصيل بالبطاقة، القائمة الأخيرة) يقول
     * للصفحة إن هذه النسخة فيها PrintActivity، ويعطيها مفتاح الثقة لهذا التثبيت (fsbridge=<الإصدار>.<المفتاح>) فتطبع بلا نقرة
     * تأكيد. الصفحة تحفظه وتحذفه من العنوان فوراً (captureBridgeLaunch). على عناوين https لمضيفنا وحدها، ولا يتكرر
     */
    private Uri appendPrintBridge(Uri uri) {
        if (uri == null || !uri.isHierarchical()) return uri;
        if (!"https".equals(uri.getScheme()) || !getString(R.string.hostName).equals(uri.getHost())) return uri;
        try {
            String value = BridgeContract.PROTOCOL_VERSION + "." + PrinterStore.bridgeKey(this);
            if (uri.getQueryParameter(BridgeContract.LAUNCH_PARAM) == null) {
                return uri.buildUpon().appendQueryParameter(BridgeContract.LAUNCH_PARAM, value).build();
            }
            Uri.Builder clean = uri.buildUpon().clearQuery();
            for (String name : uri.getQueryParameterNames()) {
                if (BridgeContract.LAUNCH_PARAM.equals(name)) continue;
                for (String v : uri.getQueryParameters(name)) {
                    clean.appendQueryParameter(name, v);
                }
            }
            return clean.appendQueryParameter(BridgeContract.LAUNCH_PARAM, value).build();
        } catch (RuntimeException e) {
            return uri; // عنوانٌ لا يُحلَّل أو تعذّر المفتاح: يُترك كما هو، والطباعة تمرّ بشاشة التأكيد
        }
    }

    private Uri stripStaleCardPay(Uri uri) {
        Intent launch = getIntent();
        if (uri == null || launch == null
                || (launch.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
                || !uri.isHierarchical()) {
            return uri;
        }
        try {
            if (uri.getQueryParameter("cardpay") == null) return uri;
            Uri.Builder clean = uri.buildUpon().clearQuery();
            for (String name : uri.getQueryParameterNames()) {
                if ("cardpay".equals(name)) continue;
                for (String value : uri.getQueryParameters(name)) {
                    clean.appendQueryParameter(name, value);
                }
            }
            return clean.build();
        } catch (RuntimeException e) {
            return uri; // عنوانٌ لا يُحلَّل: يُترك كما سلّمته المكتبة
        }
    }
}
