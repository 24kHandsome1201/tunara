import SwiftUI
import UIKit
import UniformTypeIdentifiers

@main
struct HaoduApp: App {
    var body: some Scene {
        WindowGroup { HomeView() }
    }
}

struct HomeView: View {
    @State private var text = ""
    /// 粘贴进来的原始格式（网页 HTML 或富文本）。改过文字后就只用纯文字。
    @State private var formatted: (input: SourceInput, text: String)?
    @State private var composing: [Block]?
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $text)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .padding(8)
                    if text.isEmpty {
                        Text("把要发给朋友的长文字粘贴在这里。\n\n也可以在微信、备忘录、Safari 里选中文字，点「分享」→「好读」，一步出图。")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 13).padding(.vertical, 16)
                            .allowsHitTesting(false)
                    }
                }
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))

                HStack {
                    Button { paste() } label: { Label("粘贴", systemImage: "doc.on.clipboard") }
                    Menu {
                        ForEach(Sample.all) { s in Button(s.title) { load(s) } }
                    } label: { Label("示例", systemImage: "text.book.closed") }
                    Spacer()
                    if formatted != nil, formatted?.text == text {
                        Label("保留了原格式", systemImage: "checkmark.seal").font(.caption).foregroundStyle(.green)
                    }
                    if !text.isEmpty {
                        Button("清空", role: .destructive) { text = ""; formatted = nil }
                    }
                }
                .buttonStyle(.bordered)

                Button {
                    composing = blocks()
                } label: {
                    Text("生成好读长图").font(.headline).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(Color(red: 0.03, green: 0.76, blue: 0.38))
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Text("核心功能免费，图片不带水印").font(.caption2).foregroundStyle(.secondary)
            }
            .padding()
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("好读")
            .toolbar {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("设置")
            }
            .navigationDestination(item: Binding(get: { composing.map(BlockList.init) }, set: { composing = $0?.blocks })) { list in
                ComposerView(model: ComposerModel(source: list.blocks))
                    .navigationTitle("预览")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
        .onAppear(perform: handleLaunchArguments)
    }

    private func blocks() -> [Block] {
        if let formatted, formatted.text == text { return Importer.blocks(from: formatted.input) }
        return Importer.blocks(from: .text(text))
    }

    private func load(_ s: Sample) {
        switch s.input {
        case .text(let t): text = t; formatted = nil
        default:
            let plain = Importer.blocks(from: s.input).map(\.plainText).joined(separator: "\n")
            text = plain
            formatted = (s.input, plain)
        }
    }

    /// 网页和富文本优先，保留标题、列表、粗体。
    private func paste() {
        let pb = UIPasteboard.general
        if let data = pb.data(forPasteboardType: UTType.html.identifier), let html = String(data: data, encoding: .utf8) {
            set(.html(html))
        } else if let data = pb.data(forPasteboardType: UTType.rtf.identifier),
                  let a = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil) {
            set(.attributed(a))
        } else if let s = pb.string {
            text = s
            formatted = nil
        }
    }

    private func set(_ input: SourceInput) {
        let plain = Importer.blocks(from: input).map(\.plainText).joined(separator: "\n")
        text = plain
        formatted = (input, plain)
    }

    /// 演示和截图用：`-demo notice` 直接打开预览，`-demo settings` 打开设置。
    private func handleLaunchArguments() {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-fill"), i + 1 < args.count, let s = Sample.all.first(where: { $0.id == args[i + 1] }) {
            load(s)
        }
        guard let i = args.firstIndex(of: "-demo"), i + 1 < args.count else { return }
        if args[i + 1] == "settings" { showSettings = true; return }
        if let s = Sample.all.first(where: { $0.id == args[i + 1] }) {
            load(s)
            composing = blocks()
        }
    }
}

private struct BlockList: Hashable, Identifiable {
    let blocks: [Block]
    var id: Int { hashValue }
}
