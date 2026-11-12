import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// 分享菜单里的「好读」：收到文字后直接出图，可以马上发回微信。
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        Task { @MainActor in
            let blocks = await ShareInput.blocks(from: items)
            let root = ShareRootView(blocks: blocks) { [weak self] in
                self?.extensionContext?.completeRequest(returningItems: nil)
            }
            let host = UIHostingController(rootView: root)
            addChild(host)
            host.view.frame = view.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(host.view)
            host.didMove(toParent: self)
        }
    }
}

struct ShareRootView: View {
    let blocks: [Block]
    let done: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if blocks.isEmpty {
                    ContentUnavailableView("没有收到文字", systemImage: "text.badge.xmark", description: Text("请选中一段文字后再分享到「好读」。"))
                } else {
                    ComposerView(model: ComposerModel(source: blocks))
                }
            }
            .navigationTitle("好读")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成", action: done) }
            }
        }
    }
}

enum ShareInput {
    /// 按格式从全到简依次尝试：网页选区 → HTML → 富文本 → 纯文字 → 链接。
    static func blocks(from items: [NSExtensionItem]) async -> [Block] {
        let providers = items.flatMap { $0.attachments ?? [] }

        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
            guard let dict = try? await p.loadItem(forTypeIdentifier: UTType.propertyList.identifier) as? NSDictionary,
                  let page = dict[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any] else { continue }
            if let sel = page["selectionHTML"] as? String, !sel.isEmpty {
                let blocks = Importer.blocks(from: .html(sel))
                if !blocks.isEmpty { return blocks }
            }
            if let html = page["pageHTML"] as? String, !html.isEmpty {
                var blocks = Importer.blocks(from: .html(html))
                if let title = page["title"] as? String, !title.isEmpty, !blocks.contains(where: { $0 == .heading(title) }) {
                    blocks.insert(.heading(title), at: 0)
                }
                if !blocks.isEmpty { return blocks }
            }
        }

        if let html = await string(providers, UTType.html) {
            let blocks = Importer.blocks(from: .html(html))
            if !blocks.isEmpty { return blocks }
        }
        if let a = await attributed(providers) ?? items.compactMap(\.attributedContentText).first(where: hasFormatting) {
            let blocks = Importer.blocks(from: .attributed(a))
            if !blocks.isEmpty { return blocks }
        }
        if let text = await string(providers, UTType.plainText) ?? items.compactMap({ $0.attributedContentText?.string }).first,
           !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return Importer.blocks(from: .text(text))
        }
        if let url = await url(providers), let (data, _) = try? await URLSession.shared.data(from: url) {
            return Importer.blocks(from: .html(String(decoding: data, as: UTF8.self)))
        }
        return []
    }

    private static func string(_ providers: [NSItemProvider], _ type: UTType) async -> String? {
        for p in providers where p.hasItemConformingToTypeIdentifier(type.identifier) {
            let item = try? await p.loadItem(forTypeIdentifier: type.identifier)
            if let s = item as? String { return s }
            if let d = item as? Data { return String(decoding: d, as: UTF8.self) }
            if let u = item as? URL, let s = try? String(contentsOf: u, encoding: .utf8) { return s }
        }
        return nil
    }

    private static func attributed(_ providers: [NSItemProvider]) async -> NSAttributedString? {
        let types: [(UTType, NSAttributedString.DocumentType)] = [(.rtfd, .rtfd), (.flatRTFD, .rtfd), (.rtf, .rtf)]
        for (type, docType) in types {
            for p in providers where p.hasItemConformingToTypeIdentifier(type.identifier) {
                let item = try? await p.loadItem(forTypeIdentifier: type.identifier)
                var data = item as? Data
                if data == nil, let u = item as? URL { data = try? Data(contentsOf: u) }
                if let data, let a = try? NSAttributedString(data: data, options: [.documentType: docType], documentAttributes: nil) {
                    return a
                }
            }
        }
        return nil
    }

    private static func url(_ providers: [NSItemProvider]) async -> URL? {
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let u = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, u.scheme?.hasPrefix("http") == true { return u }
        }
        return nil
    }

    private static func hasFormatting(_ a: NSAttributedString) -> Bool {
        var found = false
        a.enumerateAttribute(.font, in: NSRange(location: 0, length: a.length)) { v, _, stop in
            if let f = v as? UIFont, f.fontDescriptor.symbolicTraits.contains(.traitBold) { found = true; stop.pointee = true }
        }
        return found
    }
}
