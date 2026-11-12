import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

enum AIError: LocalizedError {
    case unavailable
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .unavailable: return "没有可用的 AI。可以在设置里配置自己的 API。"
        case .badResponse(let s): return "AI 返回的内容看不懂：\(s.prefix(120))"
        }
    }
}

protocol AIProvider {
    var name: String { get }
    func plan(for blocks: [Block]) async throws -> StructurePlan
    func shorten(_ text: String, to length: Length) async throws -> Shortened
}

enum Prompts {
    static let planSystem = """
    你是中文排版助手，帮读者在微信里轻松读完一段长文字。绝对不要改写或删减原文，只给出排版方案。
    输入是按句编号的原文。返回 JSON，字段：
    summary：一句话说清全文最重要的信息，必须忠于原文，不超过 40 字；
    headings：数组，每项 {"before": 句子编号, "title": "小标题"}，在适合开启新小节的句子前加小标题，小标题不超过 10 个字；全文少于 6 句时返回空数组；
    paragraphStarts：应该另起一段的句子编号数组；
    keySentences：读者必须知道的 1～3 句的编号（要做的事、时间、要求）。
    """

    static func shortenSystem(_ length: Length) -> String {
        switch length {
        case .points:
            return """
            把用户给的文字提炼成 3～7 条要点，每条一句话。保留所有时间、地点、金额、要求，不要添加原文没有的内容。
            返回 JSON：{"summary": "一句话要点，不超过 40 字", "points": ["要点1", "要点2"]}
            """
        default:
            return """
            把用户给的文字精简到原来的一半左右，保留所有时间、地点、金额、要求，用原文的语气，不要添加原文没有的内容。
            返回 JSON：{"summary": "一句话要点，不超过 40 字", "text": "精简后的正文，段落之间空一行"}
            """
        }
    }
}

// MARK: - 苹果端侧模型

enum AppleAI {
    /// 端侧模型能不能用，以及不能用的原因。
    static var status: (available: Bool, detail: String) {
        #if canImport(FoundationModels)
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            if !model.supportedLanguages.contains(where: { $0.languageCode == .chinese }) {
                return (false, "端侧模型暂不支持中文")
            }
            return (true, "可用，文字不离开手机")
        case .unavailable(.deviceNotEligible): return (false, "这台设备不支持 Apple 智能")
        case .unavailable(.appleIntelligenceNotEnabled): return (false, "没有在系统设置里打开 Apple 智能")
        case .unavailable(.modelNotReady): return (false, "模型还在下载，稍后再试")
        case .unavailable: return (false, "暂不可用")
        }
        #else
        return (false, "系统版本不支持")
        #endif
    }
}

#if canImport(FoundationModels)
@Generable
struct FMHeading {
    @Guide(description: "新小节第一句的编号")
    var before: Int
    @Guide(description: "小标题，不超过 10 个字")
    var title: String
}

@Generable
struct FMPlan {
    @Guide(description: "一句话说清全文最重要的信息，不超过 40 字")
    var summary: String
    var headings: [FMHeading]
    @Guide(description: "应该另起一段的句子编号")
    var paragraphStarts: [Int]
    @Guide(description: "读者必须知道的 1～3 句的编号")
    var keySentences: [Int]
}

@Generable
struct FMShort {
    @Guide(description: "一句话要点，不超过 40 字")
    var summary: String
    @Guide(description: "精简后的正文，段落之间空一行")
    var text: String
}

@Generable
struct FMPoints {
    @Guide(description: "一句话要点，不超过 40 字")
    var summary: String
    @Guide(description: "3 到 7 条要点，每条一句话")
    var points: [String]
}

struct AppleProvider: AIProvider {
    let name = "Apple 端侧模型"
    /// 端侧模型上下文较小，只把前面这么多字发给它。
    private let limit = 1800

    func plan(for blocks: [Block]) async throws -> StructurePlan {
        let session = LanguageModelSession(instructions: Prompts.planSystem)
        let r = try await session.respond(to: Structurer.numberedPrompt(blocks, limit: limit), generating: FMPlan.self).content
        return StructurePlan(
            summary: r.summary.isEmpty ? nil : r.summary,
            headings: Dictionary(r.headings.map { ($0.before, $0.title) }, uniquingKeysWith: { a, _ in a }),
            paragraphStarts: Set(r.paragraphStarts),
            keySentences: Set(r.keySentences)
        )
    }

    func shorten(_ text: String, to length: Length) async throws -> Shortened {
        let session = LanguageModelSession(instructions: Prompts.shortenSystem(length))
        let input = String(text.prefix(limit))
        if length == .points {
            let r = try await session.respond(to: input, generating: FMPoints.self).content
            return Shortened(summary: r.summary, text: r.points.map { "- \($0)" }.joined(separator: "\n"))
        }
        let r = try await session.respond(to: input, generating: FMShort.self).content
        return Shortened(summary: r.summary, text: r.text)
    }
}
#endif

// MARK: - 用户自己配置的 API（OpenAI 兼容：通义千问、DeepSeek、Kimi、Ollama 等）

struct APIConfig: Equatable {
    var baseURL: String
    var model: String
    var apiKey: String

    var isComplete: Bool { !baseURL.isEmpty && !model.isEmpty }
}

struct OpenAICompatibleProvider: AIProvider {
    let config: APIConfig
    var name: String { "自定义 API · \(config.model)" }
    private let limit = 12000

    func plan(for blocks: [Block]) async throws -> StructurePlan {
        let json = try await chat(system: Prompts.planSystem, user: Structurer.numberedPrompt(blocks, limit: limit))
        return StructurePlan(
            summary: (json["summary"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            headings: Dictionary((json["headings"] as? [[String: Any]] ?? []).compactMap { h in
                guard let b = int(h["before"]), let t = h["title"] as? String, !t.isEmpty else { return nil }
                return (b, t)
            }, uniquingKeysWith: { a, _ in a }),
            paragraphStarts: Set(ints(json["paragraphStarts"])),
            keySentences: Set(ints(json["keySentences"]))
        )
    }

    func shorten(_ text: String, to length: Length) async throws -> Shortened {
        let json = try await chat(system: Prompts.shortenSystem(length), user: String(text.prefix(limit)))
        let summary = json["summary"] as? String
        if let points = json["points"] as? [String], !points.isEmpty {
            return Shortened(summary: summary, text: points.map { "- \($0)" }.joined(separator: "\n"))
        }
        guard let body = json["text"] as? String, !body.isEmpty else { throw AIError.badResponse("\(json)") }
        return Shortened(summary: summary, text: body)
    }

    /// 发一次对话请求，返回模型输出里的 JSON 对象。
    func chat(system: String, user: String) async throws -> [String: Any] {
        var base = config.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        if base.hasSuffix("/chat/completions") { base.removeLast("/chat/completions".count) }
        guard let url = URL(string: base + "/chat/completions") else { throw AIError.badResponse("地址不对：\(config.baseURL)") }

        var body: [String: Any] = [
            "model": config.model,
            "temperature": 0.2,
            "messages": [["role": "system", "content": system], ["role": "user", "content": user]],
            "response_format": ["type": "json_object"],
        ]
        var (data, status) = try await post(url, body)
        if status == 400 {
            // 有的服务不支持 response_format，去掉再试一次。
            body["response_format"] = nil
            (data, status) = try await post(url, body)
        }
        let text = String(decoding: data, as: UTF8.self)
        guard status == 200 else { throw AIError.badResponse("HTTP \(status) \(text)") }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = root["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let content = message["content"] as? String else { throw AIError.badResponse(text) }
        return try Self.jsonObject(in: content)
    }

    private func post(_ url: URL, _ body: [String: Any]) async throws -> (Data, Int) {
        var req = URLRequest(url: url, timeoutInterval: 180)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !config.apiKey.isEmpty { req.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        return (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
    }

    /// 模型有时会在 JSON 外面包一层 ```json 或说明文字。
    static func jsonObject(in content: String) throws -> [String: Any] {
        guard let lo = content.firstIndex(of: "{"), let hi = content.lastIndex(of: "}"),
              let obj = try? JSONSerialization.jsonObject(with: Data(content[lo...hi].utf8)) as? [String: Any]
        else { throw AIError.badResponse(content) }
        return obj
    }

    private func int(_ v: Any?) -> Int? {
        if let i = v as? Int { return i }
        if let s = v as? String { return Int(s.trimmingCharacters(in: CharacterSet(charactersIn: "[] "))) }
        return nil
    }

    private func ints(_ v: Any?) -> [Int] {
        (v as? [Any] ?? []).compactMap(int)
    }
}

// MARK: - 选择用哪个 AI

enum AIMode: String, CaseIterable, Identifiable {
    case auto, custom, off
    var id: String { rawValue }
    var title: String {
        switch self {
        case .auto: return "自动（优先苹果端侧）"
        case .custom: return "只用自定义 API"
        case .off: return "不用 AI"
        }
    }
}

enum AIRouter {
    static func provider() -> AIProvider? {
        let mode = AIMode(rawValue: AppSettings.defaults.string(forKey: AppSettings.aiModeKey) ?? "") ?? .auto
        let config = AppSettings.apiConfig
        switch mode {
        case .off:
            return nil
        case .custom:
            return config.isComplete ? OpenAICompatibleProvider(config: config) : nil
        case .auto:
            var chain: [AIProvider] = []
            #if canImport(FoundationModels)
            if AppleAI.status.available { chain.append(AppleProvider()) }
            #endif
            if config.isComplete { chain.append(OpenAICompatibleProvider(config: config)) }
            return chain.count > 1 ? FallbackProvider(chain: chain) : chain.first
        }
    }
}

/// 苹果端侧模型报告可用但调用失败时（例如模型还没装好），改用自定义 API。
struct FallbackProvider: AIProvider {
    let chain: [AIProvider]
    var name: String { chain.map(\.name).joined(separator: "，备用 ") }

    func plan(for blocks: [Block]) async throws -> StructurePlan {
        try await first { try await $0.plan(for: blocks) }
    }

    func shorten(_ text: String, to length: Length) async throws -> Shortened {
        try await first { try await $0.shorten(text, to: length) }
    }

    private func first<T>(_ call: (AIProvider) async throws -> T) async throws -> T {
        var lastError: Error = AIError.unavailable
        for p in chain {
            do { return try await call(p) } catch { lastError = error }
        }
        throw lastError
    }
}
