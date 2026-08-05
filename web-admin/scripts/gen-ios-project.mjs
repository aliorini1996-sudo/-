// Generates a FieldSales iOS Xcode project from the PWABuilder open-source template,
// faithfully mirroring the service's token replacements + a few deliberate, documented overrides.
//
//   node scripts/gen-ios-project.mjs rep     -> ../ios-app        (sales rep app, fieldsa.net/rep)
//   node scripts/gen-ios-project.mjs admin   -> ../ios-admin-app  (company admin app, fieldsa.net/m)
//
// Run from web-admin (so `sharp` resolves). Deterministic + idempotent.
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const SCRATCH = 'C:/Users/ali_h/AppData/Local/Temp/claude/C--Users-ali-h-OneDrive--------------------/aa4de606-d97e-43cf-bdb2-2b355daa4bd2/scratchpad';
const SRC = path.join(SCRATCH, 'pwabuilder-ios-app-store-main/Microsoft.PWABuilder.IOS.Web/Resources/ios-project-src');
const ROOT = 'C:/Users/ali_h/OneDrive/سطح المكتب/كلود كود/dsd-sales-system';

// The brand mark ("المسار الصاعد"). The admin app inverts the colours so the two apps are
// distinguishable at a glance when both sit on the same home screen — same rationale as
// scripts/gen-admin-icons.mjs, which produces the matching PWA icons.
const mark = (bg, stroke, dot) => `<svg width="1024" height="1024" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" fill="${bg}"/>
  <line x1="32" y1="88" x2="88" y2="32" stroke="${stroke}" stroke-width="16" stroke-linecap="round"/>
  <circle cx="32" cy="88" r="11" fill="${dot}"/>
  <circle cx="60" cy="60" r="8.5" fill="${dot}"/>
  <circle cx="88" cy="32" r="14" fill="${stroke}"/>
  <circle cx="88" cy="32" r="7.5" fill="${dot}"/>
</svg>`;

// Permission purpose strings are declared per app and ONLY for what the web app actually calls.
// Declaring an unused permission invites a Guideline 5.1.1 question during review.
const TARGETS = {
  rep: {
    APP: 'FieldSales',
    // Home-screen label (CFBundleDisplayName). iOS truncates past ~12 characters, and these
    // mirror the two PWA manifests' short_name so a user with both installed sees the same names.
    DISPLAY_NAME: 'FieldSales',
    BUNDLE_ID: 'net.fieldsa.rep',
    ROOT_URL: 'https://fieldsa.net/rep',
    DEST: path.join(ROOT, 'ios-app'),
    ICON: { bg: '#E15A30', stroke: '#1F1A13', dot: '#FAF7F0' },
    PROGRESS: { r: 225, g: 90, b: 48 },   // #E15A30 on the dark splash
    // The rep app scans barcodes (getUserMedia) and attaches visit photos.
    MEDIA_CAPTURE: true,
    CAMERA: 'يستخدم التطبيق الكاميرا لمسح باركود المنتجات والتقاط صور زيارات العملاء.',
    MIC: 'قد يستخدم التطبيق الميكروفون عند التقاط الوسائط بناءً على طلبك.',
    LOCATION: 'يستخدم التطبيق موقعك لتسجيل مواقع الزيارات الميدانية وتتبّع مسار المندوب أثناء العمل.',
    PHOTOS: true,
  },
  admin: {
    APP: 'FieldSalesAdmin',
    DISPLAY_NAME: 'إدارة',          // matches manifest-admin.webmanifest short_name
    BUNDLE_ID: 'net.fieldsa.admin',
    ROOT_URL: 'https://fieldsa.net/m',
    DEST: path.join(ROOT, 'ios-admin-app'),
    ICON: { bg: '#1F1A13', stroke: '#E15A30', dot: '#FAF7F0' },
    PROGRESS: { r: 225, g: 90, b: 48 },
    // src/m calls navigator.geolocation only (customer location capture) — no camera, no mic,
    // no photo library. Those keys are removed rather than left with template text.
    MEDIA_CAPTURE: false,
    CAMERA: null,
    MIC: null,
    LOCATION: 'يستخدم التطبيق موقعك لالتقاط موقع العميل عند إضافته أو تعديله.',
    PHOTOS: false,
  },
};

const TARGET_NAME = process.argv[2];
const CFG = TARGETS[TARGET_NAME];
if (!CFG) {
  console.error(`Usage: node scripts/gen-ios-project.mjs <${Object.keys(TARGETS).join('|')}>`);
  process.exit(1);
}
const { APP, BUNDLE_ID, ROOT_URL, DEST, PROGRESS } = CFG;
const URL_HOST = 'fieldsa.net';
const APP_BOUND = ['fieldsa.net', 'api.fieldsa.net'];   // WKAppBoundDomains: host-only (enables service worker / offline)
const MARKETING_VERSION = '1.0.0';
fs.mkdirSync(DEST, { recursive: true });
console.log(`▶ target: ${TARGET_NAME}  (${APP} / ${BUNDLE_ID} -> ${ROOT_URL})`);

const warnings = [];
const log = (m) => console.log(m);

// ---------- 1. Clean previous generation, copy fresh template ----------
for (const item of [APP, `${APP}.xcodeproj`, `${APP}.xcworkspace`, 'pwa-shell', 'pwa-shell.xcodeproj', 'pwa-shell.xcworkspace', 'Podfile', '.gitignore', 'LICENSE', 'launch-64.png', 'launch-128.png', 'launch-192.png', '.DS_Store']) {
  fs.rmSync(path.join(DEST, item), { recursive: true, force: true });
}
// Copy each top-level template item into DEST (merges with existing docs/assets/metadata).
for (const name of fs.readdirSync(SRC)) {
  if (name === '.DS_Store') continue;
  fs.cpSync(path.join(SRC, name), path.join(DEST, name), { recursive: true });
}
log('✓ template copied');

// ---------- 2. Rename pwa-shell -> FieldSales ----------
const rename = (a, b) => { if (fs.existsSync(path.join(DEST, a))) fs.renameSync(path.join(DEST, a), path.join(DEST, b)); else warnings.push('rename src missing: ' + a); };
rename('pwa-shell', APP);
rename('pwa-shell.xcodeproj', `${APP}.xcodeproj`);
rename('pwa-shell.xcworkspace', `${APP}.xcworkspace`);
rename(`${APP}.xcodeproj/xcshareddata/xcschemes/pwa-shell.xcscheme`, `${APP}.xcodeproj/xcshareddata/xcschemes/${APP}.xcscheme`);
log('✓ folders/scheme renamed');

// ---------- helpers ----------
const edit = (rel, pairs) => {
  const p = path.join(DEST, rel);
  if (!fs.existsSync(p)) { warnings.push('edit target missing: ' + rel); return; }
  let s = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (!s.includes(from)) { warnings.push(`token not found in ${rel}: ${JSON.stringify(from).slice(0, 70)}`); continue; }
    s = s.split(from).join(to);
  }
  fs.writeFileSync(p, s, 'utf8');
};

// ---------- 3. pwa-shell / PWAShell / Pods_pwa_shell references ----------
edit('Podfile', [["pod 'Firebase/Messaging'", "pod 'Firebase/Messaging', '~> 11.0'"], ['pwa-shell', APP]]);
edit(`${APP}.xcodeproj/project.xcworkspace/contents.xcworkspacedata`, [['pwa-shell', APP]]);
edit(`${APP}.xcworkspace/contents.xcworkspacedata`, [['pwa-shell', APP]]);
edit(`${APP}.xcodeproj/xcshareddata/xcschemes/${APP}.xcscheme`, [['pwa-shell', APP], ['PWAShell', APP]]);
edit(`${APP}.xcodeproj/project.pbxproj`, [
  ['{{PWABuilder.iOS.bundleId}}', BUNDLE_ID],
  ['Pods_pwa_shell', `Pods_${APP}`],
  ['pwa-shell', APP],
  ['PWAShell', APP],
  ['MARKETING_VERSION = 1;', `MARKETING_VERSION = ${MARKETING_VERSION};`],
  ['TARGETED_DEVICE_FAMILY = "1,2,6";', 'TARGETED_DEVICE_FAMILY = "1";'],
  // Signing uses the provisioning profile's entitlements (see Entitlements removal below).
  // NOTE: 'pwa-shell' was already renamed by the pair above, so match the new name here.
  [`\t\t\t\tCODE_SIGN_ENTITLEMENTS = "${APP}/Entitlements/Entitlements.plist";\n`, ''],
]);
edit(`${APP}/PushNotifications.swift`, [['PWAShell', APP]]);
edit(`${APP}/ViewController.swift`, [['PWAShell', APP]]);
edit(`${APP}/SceneDelegate.swift`, [['PWAShell', APP]]);
log('✓ module/name references updated');

// ---------- 4. Token replacements ----------
const rgb = (v) => v / 255;
const colorStr = `<color key="tintColor" red="${rgb(PROGRESS.r)}" green="${rgb(PROGRESS.g)}" blue="${rgb(PROGRESS.b)}" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>`;
edit(`${APP}/Base.lproj/Main.storyboard`, [['PWAShell', APP], ['{{PWABuilder.iOS.progressBarColor}}', colorStr]]);

edit(`${APP}/Info.plist`, [
  ['<string>{{PWABuilder.iOS.appName}}</string>', `<string>${CFG.DISPLAY_NAME}</string>`],
  ['<string>{{PWABuilder.iOS.permittedUrls}}</string>', APP_BOUND.map(d => `<string>${d}</string>`).join('\n\t\t')],
  ['<key>{{PWABuilder.iOS.shortcuts}}</key>', ''],
  ['<string>remote-notification</string>', ''],
]);

edit(`${APP}/Settings.swift`, [
  ['{{PWABuilder.iOS.url}}', ROOT_URL],
  ['{{PWABuilder.iOS.urlHost}}', URL_HOST],
  ['"{{PWABuilder.iOS.permittedHosts}}"', ''],   // authOrigins = []
]);

// Entitlements: the template ships aps-environment + associated-domains we don't use, and a custom
// entitlements file whose contents don't match the provisioning profile gets the app killed at launch
// by CODESIGNING on device. Drop the file reference entirely so signing uses the profile's entitlements.
fs.rmSync(path.join(DEST, `${APP}/Entitlements`), { recursive: true, force: true });
// The folder is also listed in the Resources build phase; a missing build input fails the build,
// so drop every remaining pbxproj line that mentions it.
{
  const p = path.join(DEST, `${APP}.xcodeproj/project.pbxproj`);
  const kept = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !l.includes('Entitlements'));
  fs.writeFileSync(p, kept.join('\n'), 'utf8');
}

// Firebase stays inert: the app has no push notifications. Per PWABuilder's docs the shipped default is
// Firebase present but NOT configured; `Messaging.messaging()` then returns nil and assigning to it is a
// no-op. We additionally comment out that assignment so no Firebase code runs at launch at all.
edit(`${APP}/AppDelegate.swift`, [
  ['        Messaging.messaging().delegate = self', '        // Messaging.messaging().delegate = self // push notifications unused'],
]);
log('✓ tokens replaced');

// ---------- 4b. Compatibility fixes (feature parity with the published Android app) ----------
// Fix stray upstream-template module reference (CloudpilotEmu) — would break the build.
edit(`${APP}/ViewController.swift`, [['CloudpilotEmu', APP]]);

// Remove force-casts of the connected scene: `as! UIWindowScene` traps at launch whenever
// connectedScenes is still empty, which is a known crash in this template.
edit(`${APP}/WebView.swift`, [
  ['        let winScene = UIApplication.shared.connectedScenes.first\n        let windowScene = winScene as! UIWindowScene\n        var statusBarHeight = windowScene.statusBarManager?.statusBarFrame.height ?? 0',
   '        let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene\n        var statusBarHeight = windowScene?.statusBarManager?.statusBarFrame.height ?? 0'],
]);
edit(`${APP}/ViewController.swift`, [
  ['        let winScene = UIApplication.shared.connectedScenes.first\n        let windowScene = winScene as! UIWindowScene\n        var statusBarHeight = windowScene.statusBarManager?.statusBarFrame.height ?? 60',
   '        let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene\n        var statusBarHeight = windowScene?.statusBarManager?.statusBarFrame.height ?? 60'],
]);

// WebView: brand the UA tag, and (rep only) grant camera/mic to web getUserMedia.
edit(`${APP}/WebView.swift`, [['Safari/604.1 PWAShell', `Safari/604.1 ${APP}`]]);
if (CFG.MEDIA_CAPTURE) {
  edit(`${APP}/WebView.swift`, [
    ['extension ViewController: WKUIDelegate, WKDownloadDelegate {',
`extension ViewController: WKUIDelegate, WKDownloadDelegate {
    // Grant camera/microphone to web getUserMedia (barcode/photo capture) — matches Android.
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }`],
  ]);
}

// Info.plist permission purposes (App Store Guideline 5.1.1): declare only what the web app calls.
// The template ships camera/mic/location placeholders; unused ones are deleted, not reworded.
const plistPairs = [
  ['<string>Track current location by user request</string>', `<string>${CFG.LOCATION}</string>`],
];
plistPairs.push(CFG.CAMERA
  ? ['<string>Capture Video by user request</string>', `<string>${CFG.CAMERA}</string>`]
  : ['\t<key>NSCameraUsageDescription</key>\n\t<string>Capture Video by user request</string>\n', '']);
plistPairs.push(CFG.MIC
  ? ['<string>Capture Audio by user request</string>', `<string>${CFG.MIC}</string>`]
  : ['\t<key>NSMicrophoneUsageDescription</key>\n\t<string>Capture Audio by user request</string>\n', '']);
if (CFG.PHOTOS) {
  plistPairs.push(['<key>CFBundleDevelopmentRegion</key>',
    '<key>NSPhotoLibraryUsageDescription</key>\n\t<string>يتيح التطبيق اختيار صور من مكتبتك لإرفاقها بزيارات العملاء.</string>\n\t<key>NSPhotoLibraryAddUsageDescription</key>\n\t<string>يحفظ التطبيق المستندات والصور في مكتبتك عند طلبك.</string>\n\t<key>CFBundleDevelopmentRegion</key>']);
}
edit(`${APP}/Info.plist`, plistPairs);
log('✓ compatibility fixes applied (permission purposes + build fix)');

// ---------- 5. Icons ----------
const ICON_SVG = mark(CFG.ICON.bg, CFG.ICON.stroke, CFG.ICON.dot);
// App Store icons must be opaque with square corners — iOS applies the mask itself.
const png = async (size, outPath) =>
  sharp(Buffer.from(ICON_SVG)).resize(size, size).flatten({ background: CFG.ICON.bg }).removeAlpha().png().toFile(outPath);

const appIconDir = path.join(DEST, `${APP}/Assets.xcassets/AppIcon.appiconset`);
const launchDir = path.join(DEST, `${APP}/Assets.xcassets/LaunchIcon.imageset`);
const appIcons = { '20.png': 20, '29.png': 29, '40.png': 40, '50.png': 50, '57.png': 57, '58.png': 58, '60.png': 60, '72.png': 72, '76.png': 76, '80.png': 80, '87.png': 87, '100.png': 100, '114.png': 114, '120.png': 120, '144.png': 144, '152.png': 152, '167.png': 167, '180.png': 180, '192.png': 192, '1024.png': 1024, 'AppIcon-16.png': 16, 'AppIcon-16@2x.png': 32, 'AppIcon-32.png': 32, 'AppIcon-32@2x.png': 64, 'AppIcon-128.png': 128, 'AppIcon-128@2x.png': 256, 'AppIcon-256.png': 256, 'AppIcon-256@2x.png': 512, 'AppIcon-512.png': 512, 'AppIcon-512@2x.png': 1024 };
const launchIcons = { 'launch-64.png': 64, 'launch-128.png': 128, 'launch-192.png': 192, 'launch-256.png': 256, 'launch-512.png': 512 };

for (const [name, size] of Object.entries(appIcons)) await png(size, path.join(appIconDir, name));
for (const [name, size] of Object.entries(launchIcons)) await png(size, path.join(launchDir, name));
for (const name of ['launch-64.png', 'launch-128.png', 'launch-192.png']) await png(launchIcons[name], path.join(DEST, name));
log(`✓ generated ${Object.keys(appIcons).length} app icons + ${Object.keys(launchIcons).length} launch icons`);

// ---------- 6. Verify: no tokens / stale names left ----------
const walk = (dir, acc = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const fp = path.join(dir, e.name); if (e.isDirectory()) walk(fp, acc); else acc.push(fp); } return acc; };
const textExt = /\.(swift|plist|pbxproj|xcscheme|xcworkspacedata|storyboard|json|Podfile|md)$|Podfile$/;
let leftoverTokens = 0, staleNames = 0;
for (const f of walk(path.join(DEST, APP)).concat(walk(path.join(DEST, `${APP}.xcodeproj`)), walk(path.join(DEST, `${APP}.xcworkspace`)), [path.join(DEST, 'Podfile')])) {
  if (!(textExt.test(f) || f.endsWith('Podfile'))) continue;
  const s = fs.readFileSync(f, 'utf8');
  if (s.includes('{{PWABuilder')) { leftoverTokens++; console.warn('  ⚠ leftover token in', f.replace(DEST, '.')); }
  if (s.includes('pwa-shell') || s.includes('PWAShell') || s.includes('pwa_shell') || s.includes('CloudpilotEmu')) { staleNames++; console.warn('  ⚠ stale name in', f.replace(DEST, '.')); }
}

log('\n===== SUMMARY =====');
log(`leftover {{tokens}}: ${leftoverTokens}   stale pwa-shell/PWAShell: ${staleNames}`);
if (warnings.length) { log('warnings:'); warnings.forEach(w => log('  - ' + w)); } else log('no warnings');
