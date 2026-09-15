/*
 * ax-pulse —— F 页「Midi 打字伴侣」的心跳层（design/brief-midi.md §2）。
 *
 * 它做的事只有一件：告诉父进程「刚才多了 / 少了 N 个字」。
 * **文本永远不出这个进程** —— 只读 kAXNumberOfCharactersAttribute（一个 Int），
 * 拿不到就这一轮没有心跳。stdout 只有两种行：
 *   {"status":"ok"} / {"status":"untrusted"}
 *   {"t":<毫秒>,"d":<带符号增量>}
 * 不输出文本、不输出 app 名、不输出 bundle id（app 名留到日记层，那边有授权开关）。
 *
 * 几处是从 ContextIME 的 AXMonitor 实战里换来的，不是风格问题：
 *   · 必须有 AppKit 的 NSApplication —— NSWorkspace 通知要 AppKit 初始化过，
 *     AXObserver 的 run loop source 要挂在主 RunLoop 上，所以末尾是 app.run()；
 *   · stdout 用 FileHandle 写而不是 print —— 非 tty 下 print 是全缓冲的，
 *     父进程按行读会一直读不到东西；
 *   · 焦点通知回调带回来的 element **不可信**（有些系统版本给的是旧元素），
 *     一律重新问 app 要 kAXFocusedUIElementAttribute；
 *   · 焦点换了之后基线重置成**新元素当前的字数**而不是 0，
 *     否则切到一个已经有 2000 字的编辑器会立刻报一个 +2000。
 */

import AppKit
import ApplicationServices

/* ---------- 输出 ---------- */

let debugOn = ProcessInfo.processInfo.environment["AX_PULSE_DEBUG"] == "1"

func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

/// 调试行只进 stderr，且默认安静（AX_PULSE_DEBUG=1 才开）
func dbg(_ line: String) {
    guard debugOn else { return }
    FileHandle.standardError.write(Data(("[ax-pulse] " + line + "\n").utf8))
}

/* ---------- 安全底线 ---------- */

/// 这些 app 一律不建观察者。
/// 前半是密码 / 凭据类（哪怕只报长度也不该碰）；
/// 后半是终端 —— 终端的 AX value 是**整个 scrollback**，
/// `ls` 刷一屏会被当成打了两千个字，那不是打字。
let DENY: Set<String> = [
    "com.apple.systempreferences",
    "com.apple.SecurityAgent",
    "com.apple.keychainaccess",
    "com.apple.loginwindow",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.dashlane.Dashlane",
    "org.keepassxc.keepassxc",
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "com.mitchellh.ghostty",
    "dev.warp.Warp-Stable",
    "net.kovidgoyal.kitty",
    "io.alacritty",
    "org.alacritty",
    "com.github.wez.wezterm"
]

/// 一次能报多少字。超过这个数的是粘贴 / 自动补全 / 整段替换，不算打字。
let MAX_DELTA = 30

/* ---------- 监听 ---------- */

let axCallback: AXObserverCallback = { _, element, notification, refcon in
    guard let refcon else { return }
    let m = Unmanaged<Monitor>.fromOpaque(refcon).takeUnretainedValue()
    m.handle(notification as String, element)
}

final class Monitor {
    private var observer: AXObserver?
    private var appElement: AXUIElement?
    private var focused: AXUIElement?
    /// 上一次读到的字数。焦点旋转时重置为新元素当前的字数。
    private var baseline = 0
    /// 每 attach 一次加一：挂在旧观察者上的重试定时器醒来时发现代际变了就自行作废
    private var generation = 0
    /// 当前观察的前台 app 的 pid。只用来认「系统级焦点是不是它的」，不进任何输出行
    private var pid: pid_t = 0

    private var refcon: UnsafeMutableRawPointer {
        Unmanaged.passUnretained(self).toOpaque()
    }

    /* ----- 前台 app ----- */

    func start() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            self?.attach(app)
        }
        attach(NSWorkspace.shared.frontmostApplication)
    }

    /// 只盯前台那一个 app：旧的整个拆掉，新的重建。
    /// 全系统挂观察者既拿不到（沙箱 app 很多不给），也没必要 —— 人只在前台窗口里打字。
    private func attach(_ app: NSRunningApplication?) {
        teardown()
        generation += 1
        guard let app, app.processIdentifier > 0 else { return }
        if let bid = app.bundleIdentifier, DENY.contains(bid) {
            dbg("deny 前台 app，不建观察者")
            return
        }
        let el = AXUIElementCreateApplication(app.processIdentifier)
        // 目标 app 卡住时别把我们也拖住：0.5 s 拿不到就当拿不到
        AXUIElementSetMessagingTimeout(el, 0.5)
        var obs: AXObserver?
        guard AXObserverCreate(app.processIdentifier, axCallback, &obs) == .success, let obs else {
            dbg("AXObserverCreate 失败")
            return
        }
        appElement = el
        observer = obs
        pid = app.processIdentifier
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        // 两个都订：有的 app 换窗口时不发 FocusedUIElementChanged
        AXObserverAddNotification(obs, el, kAXFocusedUIElementChangedNotification as CFString, refcon)
        AXObserverAddNotification(obs, el, kAXFocusedWindowChangedNotification as CFString, refcon)
        dbg("attach 前台 app")
        refocus()
        /* 刚被激活的 app 往往还答不上「谁有焦点」（AX 侧要过一拍才建好树），
           而之后如果用户一直在同一个输入框里打字，焦点通知再也不会来 ——
           第一次没拿到就等于这个 app 整段时间都没有心跳。所以补三次重试。 */
        if focused == nil { retryRefocus(attempt: 0) }
    }

    /// Chromium 系 app（Claude 桌面端、Cursor、企业微信内嵌页）刚到前台那一两秒 AX 树还没建好，
    /// 问焦点只得到 cannotComplete；之后如果人一直在同一个框里打字，焦点通知再也不会来。
    /// 实测（macOS 26 + Claude.app）：前台稳定后不用任何私有属性就能拿到 AXTextArea 与字数，
    /// 设 AXManualAccessibility 反而把它弄坏（设完立刻 cannotComplete）。所以只是等，不做别的：
    /// 前 4 次隔 0.5 s，之后每 5 s 一次，直到拿到或前台换了人。
    private func retryRefocus(attempt: Int) {
        let delay = attempt < 4 ? 0.5 : 5.0
        let gen = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.generation == gen, self.focused == nil, self.observer != nil else { return }
            self.refocus()
            if self.focused == nil { self.retryRefocus(attempt: attempt + 1) }
        }
    }

    private func teardown() {
        if let obs = observer {
            if let el = focused {
                AXObserverRemoveNotification(obs, el, kAXValueChangedNotification as CFString)
            }
            if let el = appElement {
                AXObserverRemoveNotification(obs, el, kAXFocusedUIElementChangedNotification as CFString)
                AXObserverRemoveNotification(obs, el, kAXFocusedWindowChangedNotification as CFString)
            }
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        }
        observer = nil
        appElement = nil
        focused = nil
        baseline = 0
    }

    /* ----- 回调 ----- */

    func handle(_ notification: String, _ element: AXUIElement) {
        switch notification {
        case kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification:
            refocus()
        case kAXValueChangedNotification:
            onValueChanged(element)
        default:
            break
        }
    }

    /// 焦点旋转。**不信回调给的 element** —— 重新问 app 要权威焦点。
    private func refocus() {
        guard let obs = observer, let app = appElement else { return }
        if let old = focused {
            AXObserverRemoveNotification(obs, old, kAXValueChangedNotification as CFString)
        }
        focused = nil
        baseline = 0

        /* 先问 app 元素；有些 app（macOS 26 的 TextEdit 实测）在 app 层答不出焦点，
           再问系统级元素 —— 它回答的是「全系统此刻谁有焦点」，只在它属于当前 pid 时才认。 */
        var el: AXUIElement?
        var raw: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &raw)
        if err == .success, let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID() {
            el = (value as! AXUIElement)
        } else {
            var sysRaw: CFTypeRef?
            let sys = AXUIElementCreateSystemWide()
            AXUIElementSetMessagingTimeout(sys, 0.5)
            let err2 = AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &sysRaw)
            if err2 == .success, let value = sysRaw, CFGetTypeID(value) == AXUIElementGetTypeID() {
                let cand = value as! AXUIElement
                var owner: pid_t = 0
                if AXUIElementGetPid(cand, &owner) == .success, owner == pid { el = cand }
                else { dbg("系统级焦点属于别的进程，不认") }
            } else {
                dbg("取不到焦点元素 app=\(err.rawValue) sys=\(err2.rawValue)")
            }
        }
        guard let el else { return }

        if isSecure(el) {
            dbg("焦点是密码框，不订阅")
            return
        }
        AXUIElementSetMessagingTimeout(el, 0.5)
        // 失败是常态：web / Electron 容器不都支持 value changed。订不上就这一轮没有心跳，不是错误。
        _ = AXObserverAddNotification(obs, el, kAXValueChangedNotification as CFString, refcon)
        focused = el
        let n = charCount(el)
        baseline = n ?? 0
        // 调试行只带角色：够定位「是哪类元素在报数」，又不碰内容、app 名与 pid
        dbg("焦点旋转 role=\(roleOf(el)) 基线 \(baseline)")
        /* 这一句是给日后查「哪类 app 不支持」用的：元素订上了 value changed，
           但它答不出 kAXNumberOfCharacters —— 之后每一次变化都会在 onValueChanged
           里静默返回，看上去就是「在这个 app 里打字猫不动」。有这行才知道是它。 */
        if n == nil { dbg("该元素不给字数（kAXNumberOfCharacters 拿不到）role=\(roleOf(el))") }
    }

    private func onValueChanged(_ element: AXUIElement) {
        guard let el = focused, CFEqual(el, element) else { return }
        guard let n = charCount(el) else { return }
        let d = n - baseline
        baseline = n
        if d == 0 { return }
        // 粘贴 / 整段替换 / 输出刷屏：基线已经更新，但这一次不报
        if abs(d) > MAX_DELTA { dbg("增量 \(d) 超上限，不报"); return }
        // 这里没有逐键的调试行：打字时它一秒十几条，把真正要看的两类行（超上限、
        // 焦点旋转）冲得找不到，而每条 d= 携带的信息 stdout 上本来就有一份
        emit("{\"t\":\(Int(Date().timeIntervalSince1970 * 1000)),\"d\":\(d)}")
    }

    /* ----- 读字数 ----- */

    /// 只要长度，**只问 kAXNumberOfCharactersAttribute**（一个 Int，文本从不跨进程拷贝）。
    ///
    /// 不退回读 kAXValueAttribute 取 count：那条退路要把整段文本拷进这个进程，
    /// 为的只是算一个数 —— 和「文本永远不出这个进程」是同一件事的两种说法，
    /// 留着它等于留一个会在某些 app 上悄悄生效的例外。
    /// 顺带没了的还有口径分裂：AX 的字数是 UTF-16 code unit，Swift 的 `s.count`
    /// 是 grapheme cluster，一个 emoji 在两条路上分别是 2 和 1。同一个基线上
    /// 混两种口径，切一次焦点就能凭空报出一个增量。
    /// 拿不到就返回 nil —— 这一轮没有心跳，不是错误（web / Electron 容器常这样）。
    private func charCount(_ el: AXUIElement) -> Int? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXNumberOfCharactersAttribute as CFString, &raw) == .success,
              let n = raw as? Int else { return nil }
        return n
    }

    private func roleOf(_ el: AXUIElement) -> String {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &raw) == .success else { return "?" }
        return (raw as? String) ?? "?"
    }

    private func isSecure(_ el: AXUIElement) -> Bool {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXSubroleAttribute as CFString, &raw) == .success else {
            return false
        }
        return (raw as? String) == (kAXSecureTextFieldSubrole as String)
    }
}

/* ---------- 进程壳 ---------- */

let monitor = Monitor()

/// 父进程没了就退，不留孤儿。stdin 读到 EOF 即是「父进程的管道断了」。
let stdinWatch = Thread {
    _ = FileHandle.standardInput.readDataToEndOfFile()
    exit(0)
}
stdinWatch.start()

let nsapp = NSApplication.shared
// 不要 Dock 图标、不要菜单栏 —— 它是一个后台耳朵，不是 app
nsapp.setActivationPolicy(.prohibited)

if AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) {
    emit("{\"status\":\"ok\"}")
    monitor.start()
} else {
    // 用户要去系统设置里勾一下。勾完之后系统不会通知我们，只能自己复查。
    emit("{\"status\":\"untrusted\"}")
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { timer in
        guard AXIsProcessTrusted() else { return }
        timer.invalidate()
        emit("{\"status\":\"ok\"}")
        monitor.start()
    }
}

nsapp.run()
