import Foundation
import Security
import SwiftUI

/// App 和分享扩展通过 App Group 共用设置；API Key 放在共享钥匙串里。
enum AppSettings {
    static let group = "group.com.tunara.haodu"
    static let defaults = UserDefaults(suiteName: group) ?? .standard

    static let aiModeKey = "ai.mode"
    static let baseURLKey = "ai.baseURL"
    static let modelKey = "ai.model"
    static let themeKey = "style.theme"
    static let sizeKey = "style.size"
    static let splitKey = "style.split"
    static let attachKey = "style.attachOriginal"

    static var apiConfig: APIConfig {
        APIConfig(
            baseURL: defaults.string(forKey: baseURLKey) ?? "",
            model: defaults.string(forKey: modelKey) ?? "",
            apiKey: Keychain.read() ?? ""
        )
    }
}

enum Keychain {
    private static let account = "ai.apiKey"

    private static func query(shared: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.tunara.haodu",
            kSecAttrAccount as String: account,
        ]
        if shared { q[kSecAttrAccessGroup as String] = AppSettings.group }
        return q
    }

    static func read() -> String? {
        for shared in [true, false] {
            var q = query(shared: shared)
            q[kSecReturnData as String] = true
            var out: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data {
                return String(decoding: data, as: UTF8.self)
            }
        }
        return nil
    }

    static func save(_ value: String) {
        for shared in [true, false] { SecItemDelete(query(shared: shared) as CFDictionary) }
        guard !value.isEmpty else { return }
        for shared in [true, false] {
            var q = query(shared: shared)
            q[kSecValueData as String] = Data(value.utf8)
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            if SecItemAdd(q as CFDictionary, nil) == errSecSuccess { return }
        }
    }
}

struct Theme: Identifiable, Equatable {
    let id: String
    let name: String
    let background: Color
    let text: Color
    let secondary: Color
    let accent: Color
    let highlight: Color
    let card: Color

    static let all: [Theme] = [
        Theme(id: "clean", name: "清爽", background: Color(red: 1, green: 1, blue: 1), text: Color(red: 0.13, green: 0.13, blue: 0.15),
              secondary: Color(red: 0.45, green: 0.46, blue: 0.5), accent: Color(red: 0.05, green: 0.56, blue: 0.33),
              highlight: Color(red: 1, green: 0.88, blue: 0.35).opacity(0.55), card: Color(red: 0.93, green: 0.97, blue: 0.94)),
        Theme(id: "paper", name: "护眼", background: Color(red: 0.98, green: 0.96, blue: 0.9), text: Color(red: 0.2, green: 0.17, blue: 0.13),
              secondary: Color(red: 0.5, green: 0.45, blue: 0.38), accent: Color(red: 0.72, green: 0.38, blue: 0.12),
              highlight: Color(red: 1, green: 0.82, blue: 0.4).opacity(0.5), card: Color(red: 0.95, green: 0.9, blue: 0.8)),
        Theme(id: "night", name: "夜间", background: Color(red: 0.11, green: 0.12, blue: 0.14), text: Color(red: 0.88, green: 0.89, blue: 0.9),
              secondary: Color(red: 0.6, green: 0.62, blue: 0.66), accent: Color(red: 0.38, green: 0.84, blue: 0.6),
              highlight: Color(red: 0.95, green: 0.75, blue: 0.2).opacity(0.35), card: Color(red: 0.17, green: 0.2, blue: 0.2)),
    ]

    static func named(_ id: String) -> Theme { all.first { $0.id == id } ?? all[0] }
}

enum TextSize: String, CaseIterable, Identifiable {
    case standard, large, huge
    var id: String { rawValue }
    var title: String {
        switch self {
        case .standard: return "标准"
        case .large: return "大字"
        case .huge: return "长辈"
        }
    }
    var points: CGFloat {
        switch self {
        case .standard: return 17
        case .large: return 19
        case .huge: return 22
        }
    }
}
