#!/usr/bin/env python3
"""校验 reagent 会话日志（events.jsonl）的 SHA-256 哈希链是否被篡改。

与 reagent 内置的 `reagent --session-logs` 记录逻辑对应，
适合在应急响应场景中用纯 Python 环境独立校验证据完整性，无需安装任何依赖。

用法:
    python3 verify_session.py                  # 校验当前目录最近会话
    python3 verify_session.py <session-id>     # 校验指定会话 id
    python3 verify_session.py <目录路径>        # 校验指定会话目录

退出码: 0 = 哈希链完整；1 = 不存在/被篡改。
"""
import hashlib
import json
import sys
from pathlib import Path

GENESIS_HASH = "genesis"


def js_json_serialize(obj: dict) -> str:
    """按 JS `JSON.stringify` 的约定序列化，保证与 reagent 写日志时计算 hash 的输入一致。

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
        print(f"Session not found: {arg}", file=sys.stderr)
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
        print("No session logs found.", file=sys.stderr)
    return best


def verify_session(session_dir: Path) -> tuple[bool, int, int | None]:
    """逐条重算哈希链。返回 (valid, event_count, first_bad_line_index)。"""
    events_path = session_dir / "events.jsonl"
    if not events_path.is_file():
        return False, 0, None

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
                return False, event_count, lineno
            if not isinstance(event, dict):
                return False, event_count, lineno

            prev_hash = event.get("prev_hash")
            h = event.get("hash")
            if not isinstance(prev_hash, str) or not isinstance(h, str):
                return False, event_count, lineno
            if prev_hash != last_hash:
                return False, event_count, lineno

            # 去掉 prev_hash/hash 后即为写入时用于 hash 的 base（顺序不变）
            base = {k: v for k, v in event.items() if k not in ("prev_hash", "hash")}
            if compute_event_hash(prev_hash, base) != h:
                return False, event_count, lineno

            last_hash = h

    return True, event_count, None


def main() -> int:
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    session_dir = find_session_dir(arg)
    if session_dir is None:
        return 1

    valid, count, bad_line = verify_session(session_dir)
    print(f"Session: {session_dir}")
    print(f"Events:  {count}")
    if valid:
        print(f"Integrity: OK — hash chain of {count} events intact")
        return 0

    idx = bad_line if bad_line is not None else -1
    print(f"Integrity: TAMPERED — chain broke at event #{idx + 1} (line index {idx})")
    return 1


if __name__ == "__main__":
    sys.exit(main())
