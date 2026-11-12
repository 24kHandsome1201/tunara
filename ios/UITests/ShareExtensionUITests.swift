import XCTest

/// 从 Safari 分享网页到「好读」，确认分享扩展能一步出图。
/// 需要先在 Mac 上用 `python3 -m http.server 8765` 把 ios/UITests 目录提供出来。
final class ShareExtensionUITests: XCTestCase {
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")

    private func save(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/shots/\(name).png"))
        try? safari.debugDescription.write(toFile: "/tmp/shots/\(name).txt", atomically: true, encoding: .utf8)
    }

    /// 第一个存在的元素。
    private func firstExisting(_ candidates: [XCUIElement], timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let e = candidates.first(where: { $0.exists && $0.isHittable }) { return e }
            usleep(300_000)
        } while Date() < deadline
        return nil
    }

    /// 在 App 的设置里填自定义 API（地址和模型从环境变量 API_BASE、API_MODEL 读取），并测试连接。
    private func configureAPI(base: String, model: String) {
        let app = XCUIApplication()
        app.launch()
        app.buttons["设置"].tap()
        func fill(_ field: XCUIElement, _ text: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 5))
            field.tap()
            let old = field.value as? String ?? ""
            if old == text { return }
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count + 5) + text)
        }
        fill(app.textFields.element(boundBy: 0), base)
        fill(app.textFields.element(boundBy: 1), model)
        app.buttons["测试连接"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH '连接成功'")).firstMatch.waitForExistence(timeout: 120))
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/shots/settings-api.png"))
        app.buttons["完成"].tap()
    }

    func testShareFromSafari() throws {
        let env = ProcessInfo.processInfo.environment
        if let base = env["API_BASE"], let model = env["API_MODEL"] { configureAPI(base: base, model: model) }
        safari.launch()
        sleep(2)
        safari.open(URL(string: "http://127.0.0.1:8765/article.html")!)
        sleep(3)
        save("ui-1-safari")

        let shareLabels = ["分享", "Share", "ShareButton"]
        var share = firstExisting(shareLabels.map { safari.buttons[$0].firstMatch }, timeout: 5)
        if share == nil {
            // iOS 26 起，紧凑标签栏把「分享」收进了「更多」菜单。
            let more = firstExisting(["更多", "More", "MoreMenuButton", "PageFormatMenuButton"].map { safari.buttons[$0].firstMatch }, timeout: 5)
            more?.tap()
            sleep(1)
            save("ui-2-menu")
            share = firstExisting(shareLabels.flatMap { [safari.buttons[$0].firstMatch, safari.cells[$0].firstMatch, safari.staticTexts[$0].firstMatch] }, timeout: 5)
        }
        let shareButton = try XCTUnwrap(share, "找不到 Safari 的分享按钮")
        shareButton.tap()
        sleep(2)
        save("ui-3-sheet")

        var target = firstExisting([safari.cells["好读"].firstMatch, safari.buttons["好读"].firstMatch], timeout: 5)
        var swipes = 0
        while target == nil, swipes < 4 {
            safari.collectionViews.firstMatch.swipeLeft()
            swipes += 1
            target = firstExisting([safari.cells["好读"].firstMatch, safari.buttons["好读"].firstMatch], timeout: 2)
        }
        try XCTUnwrap(target, "分享面板里没有「好读」").tap()

        XCTAssertTrue(safari.buttons["发给微信好友"].waitForExistence(timeout: 30))
        // 等 AI 整理完（没有配置 AI 时立刻就是最终结果）。
        sleep(UInt32(ProcessInfo.processInfo.environment["SHARE_WAIT"] ?? "4") ?? 4)
        save("share-extension")
    }
}
