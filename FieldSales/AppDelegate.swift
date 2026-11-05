import UIKit
import UserNotifications


@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window : UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // إشعارات APNs أصلية بلا Firebase (PushBridge.swift). المندوب يأذن من الصفحة لا عند الإقلاع.
        // المفوَّض قبل انتهاء الإقلاع (آبل): لمسة إشعارٍ أقلعت التطبيق تصل didReceive أدناه ولا تضيع.
        UNUserNotificationCenter.current().delegate = self
        PushBridge.shared.appDidFinishLaunching()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushBridge.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushBridge.shared.didFailToRegister(error: error)
    }
}

extension AppDelegate : UNUserNotificationCenterDelegate {

    // والتطبيق في الواجهة: يُعرض الإشعار بصوته كما في الخلفية، والصفحة تفتح شاشته فوراً
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        PushBridge.shared.received(notification)
        completionHandler([.banner, .list, .sound])
    }

    // لمس المندوب الإشعار (ومنه اللمسة التي أقلعت التطبيق): الصفحة تفتح شاشته
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            PushBridge.shared.opened(response.notification)
        }
        completionHandler()
    }
}
