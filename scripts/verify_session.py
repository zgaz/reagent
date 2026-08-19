#!/usr/bin/env python3
"""校验 cook 会话日志（events.jsonl）的 SHA-256 哈希链是否被篡改。

与 cook 内置的 `bun run verify:session`（scripts/verify-session.ts）功能对应，
适合在应急响应场景中用纯 Python 环境独立校验证据完整性。

用法:
    python3 scripts/verify_session.py                  # 校验当前目录最近会话
    python3 scripts/verify_session.py <session-id>     # 校验指定会话 id
    python3 scripts/verify_session.py <目录路径>        # 校验指定会话目录

退出码: 0 = 未被修改；1 = 不存在或已被修改。
"""
import hashlib
import json
import sys
from pathlib import Path

GENESIS_HASH = "genesis"


def js_json_serialize(obj: dict) -> str:
    """按 JS `JSON.stringify` 的约定序列化，保证与 cook 写日志时计算 hash 的输入一致。

    - 键保持插入顺序（Python dict 有序，json.loads 也保留顺序）
    - 无多余空格（`separators=(',', ':')`，对齐 JS）
    - 不转义非 ASCII（`ensure_ascii=False`，JS 默认直接输出 UTF-8）
    - U+2028/U+2029（行/段分隔符）JS 会转义成 `\\u2028`/`\\u2029`，这里补上
    """
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    text = text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return text


def compute_event_hash(prev_hash: str, base: dict) -> str:
    """与 session-logger.ts 的 `computeEventHash` 一致：sha256(prev_hash + JSON(base))。"""
    return hashlib.sha256(
        (prev_hash + js_json_serialize(base)).encode("utf-8")
    ).hexdigest()


def find_session_dir(arg: str | None) -> Path | None:
    """把参数解析为会话目录；无参数时取最近修改的会话。当前目录优先，全局兜底。"""
    roots = [
        Path.cwd() / ".cook" / "sessions",
        Path.home() / ".cook" / "sessions",
    ]

    if arg:
        candidate = Path(arg)
        if candidate.is_dir():
            return candidate
        for root in roots:
            as_id = root / arg
            if as_id.is_dir():
                return as_id
        print(f"错误：找不到会话 {arg}", file=sys.stderr)
        print(f"已尝试位置：{roots[0]} 和 {roots[1]}，以及作为路径", file=sys.stderr)
        return None

    best: Path | None = None
    best_mtime = -1.0
    for root in roots:
        if not root.is_dir():
            continue
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if mtime > best_mtime:
                best, best_mtime = entry, mtime
    if best is None:
        print("错误：没有找到任何会话日志。", file=sys.stderr)
    return best


def verify_session(session_dir: Path) -> tuple[bool, int, dict | None]:
    """逐条重算哈希链。返回 (是否完整, 事件数, 首个坏事件信息或 None)。

    坏事件信息含：line（行号）、reason（原因）、event（原始事件对象，可能为 None）。
    """
    events_path = session_dir / "events.jsonl"
    if not events_path.is_file():
        return False, 0, {"line": -1, "reason": "events.jsonl 不存在", "event": None}

    last_hash = GENESIS_HASH
    event_count = 0
    with events_path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh):
            line = line.strip()
            if not line:
                continue
            event_count += 1
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                return False, event_count, {
                    "line": lineno,
                    "reason": f"第 {lineno + 1} 行不是合法 JSON，可能被破坏",
                    "event": None,
                }
            if not isinstance(event, dict):
                return False, event_count, {
                    "line": lineno,
                    "reason": f"第 {lineno + 1} 行不是 JSON 对象",
                    "event": None,
                }

            prev_hash = event.get("prev_hash")
            h = event.get("hash")
            if not isinstance(prev_hash, str) or not isinstance(h, str):
                return False, event_count, {
                    "line": lineno,
                    "reason": "该事件缺少 prev_hash 或 hash 字段",
                    "event": event,
                }
            if prev_hash != last_hash:
                return False, event_count, {
                    "line": lineno,
                    "reason": "哈希链断裂：prev_hash 与上一条事件的 hash 不一致",
                    "event": event,
                }

            base = {k: v for k, v in event.items() if k not in ("prev_hash", "hash")}
            if compute_event_hash(prev_hash, base) != h:
                return False, event_count, {
                    "line": lineno,
                    "reason": "事件内容与记录的 hash 不符（内容被改动）",
                    "event": event,
                }

            last_hash = h

    return True, event_count, None


def main() -> int:
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    session_dir = find_session_dir(arg)
    if session_dir is None:
        return 1

    valid, count, bad = verify_session(session_dir)

    separator = "=" * 46
    print(separator)
    print(" cook 日志完整性校验")
    print(separator)
    print(f"会话目录: {session_dir}")
    print(f"事件总数: {count}")

    if valid:
        print(f"校验结果: 【未修改】 哈希链完整，日志可信，可作为证据使用。")
        print(separator)
        return 0

    print("校验结果: 【已修改】 哈希链断裂，日志不可信，证据可能被篡改！")
    if bad:
        line = bad.get("line", -1)
        if line >= 0:
            print(f"  断裂位置: 第 {line + 1} 行")
        print(f"  断裂原因: {bad.get('reason')}")
        event = bad.get("event")
        if isinstance(event, dict):
            etype = event.get("type", "未知")
            etime = event.get("timestamp", "未知")
            print(f"  事件类型: {etype}")
            print(f"  事件时间: {etime}")
    print("  处理建议: 该日志已被篡改，请核对原始备份或重新取证。")
    print(separator)
    return 1


if __name__ == "__main__":
    sys.exit(main())
