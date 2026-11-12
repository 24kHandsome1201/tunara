import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppSettings.aiModeKey, store: AppSettings.defaults) private var mode = AIMode.auto.rawValue
    @AppStorage(AppSettings.baseURLKey, store: AppSettings.defaults) private var baseURL = ""
    @AppStorage(AppSettings.modelKey, store: AppSettings.defaults) private var model = ""
    @State private var apiKey = Keychain.read() ?? ""
    @State private var testResult: String?
    @State private var testing = false

    private let apple = AppleAI.status

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("用哪个 AI", selection: $mode) {
                        ForEach(AIMode.allCases) { Text($0.title).tag($0.rawValue) }
                    }
                    LabeledContent("苹果端侧模型") {
                        Text(apple.detail).foregroundStyle(apple.available ? .green : .secondary).multilineTextAlignment(.trailing)
                    }
                    LabeledContent("现在使用", value: AIRouter.provider()?.name ?? "不用 AI，只按规则分段")
                } header: {
                    Text("AI 整理")
                } footer: {
                    Text("AI 默认不改你的原文，只分段、加小标题、标出重点，并在顶部写一句话要点。「精简」和「要点」才会缩写，并在图上注明。")
                }

                Section {
                    TextField("接口地址，例如 https://api.deepseek.com/v1", text: $baseURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    TextField("模型，例如 deepseek-chat、qwen-plus", text: $model)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("API Key", text: $apiKey)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onChange(of: apiKey) { _, v in Keychain.save(v) }
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text("测试连接")
                            if testing { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(baseURL.isEmpty || model.isEmpty || testing)
                    if let testResult { Text(testResult).font(.footnote).foregroundStyle(.secondary) }
                } header: {
                    Text("自定义 API")
                } footer: {
                    Text(apple.available
                         ? "手机能用苹果端侧模型时会优先用它；也可以在上面改成「只用自定义 API」。"
                         : "这台手机用不了苹果端侧模型，可以填自己的 API。支持 OpenAI 兼容接口（通义千问、DeepSeek、Kimi、本地 Ollama 等）。Key 只存在本机钥匙串里。")
                }

                Section("关于") {
                    LabeledContent("版本", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                    Text("核心功能免费，图片不带水印。").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { dismiss() } }
        }
    }

    private func test() async {
        testing = true
        defer { testing = false }
        let provider = OpenAICompatibleProvider(config: APIConfig(baseURL: baseURL, model: model, apiKey: apiKey))
        do {
            _ = try await provider.chat(system: "只返回 JSON。", user: "返回 {\"ok\": true}")
            testResult = "连接成功，可以用 \(model) 整理文字了"
        } catch {
            testResult = "连接失败：\(error.localizedDescription)"
        }
    }
}
