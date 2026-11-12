import SwiftUI
import UIKit

/// 预览并发送长图。App 内和分享扩展共用这个界面。
@MainActor
final class ComposerModel: ObservableObject {
    let source: [Block]
    @Published var length: Length = .original { didSet { Task { await refresh() } } }
    @Published var themeID: String { didSet { save(themeID, AppSettings.themeKey); rerender() } }
    @Published var size: TextSize { didSet { save(size.rawValue, AppSettings.sizeKey); rerender() } }
    @Published var split: Bool { didSet { save(split, AppSettings.splitKey); rerender() } }
    @Published var attachOriginal: Bool { didSet { save(attachOriginal, AppSettings.attachKey); cache[.concise] = nil; cache[.points] = nil; Task { await refresh() } } }
    @Published private(set) var pages: [UIImage] = []
    @Published private(set) var working: String?
    @Published private(set) var note: String?

    let ai: AIProvider?
    private var cache: [Length: ReadableDocument] = [:]
    private var current: ReadableDocument?

    init(source: [Block], ai: AIProvider? = AIRouter.provider()) {
        self.source = source
        self.ai = ai
        let d = AppSettings.defaults
        themeID = d.string(forKey: AppSettings.themeKey) ?? Theme.all[0].id
        size = TextSize(rawValue: d.string(forKey: AppSettings.sizeKey) ?? "") ?? .standard
        split = d.object(forKey: AppSettings.splitKey) as? Bool ?? true
        attachOriginal = d.object(forKey: AppSettings.attachKey) as? Bool ?? false
        #if DEBUG
        // 演示和截图用：启动参数 `-demo.length points`。
        if let l = Length(rawValue: UserDefaults.standard.string(forKey: "demo.length") ?? "") { length = l }
        #endif
    }

    var aiLabel: String { ai?.name ?? "未启用 AI，只按规则分段" }

    /// 先立刻用本地规则出图，再等 AI 整理好后替换。
    func start() async {
        let local = Structurer.apply(Structurer.localPlan(source), to: source)
        show(ReadableDocument(summary: nil, blocks: local))
        await refresh()
    }

    func refresh() async {
        let wanted = length
        if let doc = cache[wanted] { show(doc); note = nil; return }
        if ai == nil {
            if wanted == .original {
                show(ReadableDocument(summary: nil, blocks: Structurer.apply(Structurer.localPlan(source), to: source)))
                note = nil
            } else {
                note = "精简和要点需要 AI。到 App 的「设置」里配置 API 后就能用。"
            }
            return
        }
        working = wanted == .original ? "AI 正在分段、加小标题…" : "AI 正在\(wanted.title)…"
        note = nil
        do {
            let doc = try await Structurer.build(source: source, length: wanted, ai: ai, attachOriginal: attachOriginal)
            cache[wanted] = doc
            if length == wanted { show(doc) }
        } catch {
            if length == wanted {
                let reason = (error as? AIError)?.errorDescription ?? "\(ai?.name ?? "AI")这次没能运行。没有苹果端侧模型的手机，可以在「设置」里配置自己的 API。"
                note = wanted == .original ? "AI 没整理成功，先按规则分段。\(reason)" : reason
            }
        }
        if length == wanted { working = nil }
    }

    private func show(_ doc: ReadableDocument) {
        current = doc
        rerender()
    }

    private func rerender() {
        guard let current else { return }
        pages = PageRenderer.render(current, theme: Theme.named(themeID), size: size, split: split)
        #if DEBUG
        // 演示和截图用：启动参数 `-demo.dumpDir /tmp/x` 把生成的图片写到这个目录。
        if let dir = UserDefaults.standard.string(forKey: "demo.dumpDir") {
            for (i, page) in pages.enumerated() {
                try? page.pngData()?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(length.rawValue)-\(i + 1).png"))
            }
        }
        #endif
    }

    private func save(_ value: Any, _ key: String) { AppSettings.defaults.set(value, forKey: key) }
}

struct ComposerView: View {
    @StateObject var model: ComposerModel
    @State private var sharing = false
    @State private var savedMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            controls
            preview
            bottomBar
        }
        .task { await model.start() }
        .sheet(isPresented: $sharing) { ActivityView(items: model.pages).presentationDetents([.medium, .large]) }
        .alert(savedMessage ?? "", isPresented: Binding(get: { savedMessage != nil }, set: { if !$0 { savedMessage = nil } })) {
            Button("好") {}
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            Picker("篇幅", selection: $model.length) {
                ForEach(Length.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            HStack(spacing: 8) {
                Menu {
                    Picker("配色", selection: $model.themeID) { ForEach(Theme.all) { Text($0.name).tag($0.id) } }
                    Picker("字号", selection: $model.size) { ForEach(TextSize.allCases) { Text($0.title).tag($0) } }
                    Toggle("拆成几张（微信里更清楚）", isOn: $model.split)
                    if model.length != .original { Toggle("后面附上原文", isOn: $model.attachOriginal) }
                } label: {
                    Label("\(Theme.named(model.themeID).name) · \(model.size.title)", systemImage: "textformat.size")
                        .font(.subheadline)
                }
                Spacer()
                Label(model.aiLabel, systemImage: model.ai == nil ? "sparkles.slash" : "sparkles")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var preview: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let working = model.working {
                    Label(working, systemImage: "sparkles").font(.footnote).foregroundStyle(.secondary)
                        .symbolEffect(.pulse)
                }
                if let note = model.note {
                    Text(note).font(.footnote).foregroundStyle(.orange).multilineTextAlignment(.center)
                }
                ForEach(Array(model.pages.enumerated()), id: \.offset) { i, page in
                    VStack(spacing: 4) {
                        Image(uiImage: page).resizable().scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                        Text(pageInfo(i, page)).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .padding()
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private func pageInfo(_ i: Int, _ page: UIImage) -> String {
        let w = Int(page.size.width * page.scale), h = Int(page.size.height * page.scale)
        return "第 \(i + 1) 张，共 \(model.pages.count) 张 · \(w)×\(h)"
    }

    private var bottomBar: some View {
        HStack(spacing: 12) {
            Button {
                for page in model.pages { UIImageWriteToSavedPhotosAlbum(page, nil, nil, nil) }
                savedMessage = "已存到相册（\(model.pages.count) 张）"
            } label: {
                Label("存相册", systemImage: "square.and.arrow.down").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            Button {
                sharing = true
            } label: {
                Label("发给微信好友", systemImage: "paperplane.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(red: 0.03, green: 0.76, blue: 0.38))
        }
        .controlSize(.large)
        .disabled(model.pages.isEmpty)
        .padding()
        .background(.bar)
    }
}

/// 系统分享面板。选微信就能直接发给好友。
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
