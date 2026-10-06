// 发真实的系统鼠标 / 键盘事件（CGEvent，走 macOS 窗口服务器，和手动操作一样会经过点击穿透判定）。
// 给 real-input.mjs 用：从标准输入逐行读命令，每条回一行结果。坐标 = 屏幕点坐标，原点在主屏左上角
// （与 Electron 的 screen 坐标一致）。
//
//   check                    有没有发事件的权限（系统设置 › 隐私与安全性 › 辅助功能）→ ok / denied
//   request                  弹出系统授权提示
//   pos                      光标位置 → x y
//   move x y                 移动光标
//   click x y [right]        单击（左键 / 右键）
//   down x y / up x y        按下 / 松开左键
//   drag x y                 按住左键移动到 (x, y)（leftMouseDragged）
//   key escape               按一下 Esc
//   front                    最前面的应用 → bundle id
//   windows                  屏幕上的窗口 → JSON [{owner, pid, layer, x, y, width, height}]
import AppKit
import ApplicationServices

let source = CGEventSource(stateID: .hidSystemState)

func post(_ type: CGEventType, _ x: Double, _ y: Double, _ button: CGMouseButton = .left) {
  let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button)!
  if type == .leftMouseDown || type == .leftMouseUp || type == .rightMouseDown || type == .rightMouseUp {
    e.setIntegerValueField(.mouseEventClickState, value: 1)
  }
  e.post(tap: .cghidEventTap)
}

func key(_ code: CGKeyCode) {
  CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)!.post(tap: .cghidEventTap)
  usleep(30_000)
  CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)!.post(tap: .cghidEventTap)
}

func windows() -> String {
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let list = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
  var out: [[String: Any]] = []
  for w in list {
    guard let b = w[kCGWindowBounds as String] as? [String: Double] else { continue }
    out.append([
      "owner": w[kCGWindowOwnerName as String] as? String ?? "",
      "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,
      "layer": w[kCGWindowLayer as String] as? Int ?? 0,
      "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "width": b["Width"] ?? 0, "height": b["Height"] ?? 0,
    ])
  }
  let data = try! JSONSerialization.data(withJSONObject: out)
  return String(data: data, encoding: .utf8)!
}

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine() {
  let a = line.split(separator: " ").map(String.init)
  guard let cmd = a.first else { continue }
  let n = a.dropFirst().compactMap { Double($0) }
  switch cmd {
  case "check": print(CGPreflightPostEventAccess() ? "ok" : "denied")
  case "request": print(CGRequestPostEventAccess() ? "ok" : "denied")
  case "pos":
    let p = CGEvent(source: nil)!.location
    print("\(p.x) \(p.y)")
  case "move" where n.count == 2: post(.mouseMoved, n[0], n[1]); print("ok")
  case "down" where n.count == 2: post(.leftMouseDown, n[0], n[1]); print("ok")
  case "up" where n.count == 2: post(.leftMouseUp, n[0], n[1]); print("ok")
  case "drag" where n.count == 2: post(.leftMouseDragged, n[0], n[1]); print("ok")
  case "click" where n.count == 2:
    let right = a.count > 3 && a[3] == "right"
    post(.mouseMoved, n[0], n[1])
    usleep(40_000)
    post(right ? .rightMouseDown : .leftMouseDown, n[0], n[1], right ? .right : .left)
    usleep(60_000)
    post(right ? .rightMouseUp : .leftMouseUp, n[0], n[1], right ? .right : .left)
    print("ok")
  case "key" where a.count == 2 && a[1] == "escape": key(53); print("ok")
  case "front":
    // 没有常驻 run loop 时 NSWorkspace 收不到「切换应用」通知，先转一下让它更新
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
  case "windows": print(windows())
  default: print("error unknown command: \(line)")
  }
}
