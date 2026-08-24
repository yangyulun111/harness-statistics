"""只读解析 Codex state_5.sqlite：threads（任务目录）+ thread_spawn_edges（父子图）。

始终以 `file:...?mode=ro` 只读打开，配合 busy_timeout；WAL 快照读，绝不写入 ~/.codex。
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple


@dataclass
class ThreadRow:
    id: str
    rollout_path: Optional[str] = None
    source: Optional[str] = None          # 用户线程为普通字符串；子代理为 JSON blob
    thread_source: Optional[str] = None   # user / subagent
    model: Optional[str] = None
    model_provider: Optional[str] = None
    reasoning_effort: Optional[str] = None
    cwd: Optional[str] = None
    cli_version: Optional[str] = None
    sandbox_policy: Optional[str] = None   # v1.2：JSON 字符串（state DB 原文）
    approval_mode: Optional[str] = None    # v1.2
    title: Optional[str] = None
    name: Optional[str] = None
    preview: Optional[str] = None
    first_user_message: Optional[str] = None
    tokens_used: Optional[int] = None     # 线程生命周期累计（total_token_usage.total_tokens）
    git_sha: Optional[str] = None
    git_branch: Optional[str] = None
    git_origin_url: Optional[str] = None
    agent_nickname: Optional[str] = None
    agent_role: Optional[str] = None
    agent_path: Optional[str] = None
    archived: int = 0
    created_ms: Optional[int] = None      # *_ms 优先，缺失时由 *_at(秒) 换算
    updated_ms: Optional[int] = None

    def source_dict(self) -> Optional[dict]:
        """source 列若为子代理 JSON blob 则解析；普通字符串返回 None。"""
        if not self.source:
            return None
        s = self.source.strip()
        if not s.startswith("{"):
            return None
        try:
            v = json.loads(s)
            return v if isinstance(v, dict) else None
        except json.JSONDecodeError:
            return None

    def parent_from_source(self) -> Optional[str]:
        d = self.source_dict()
        if not d:
            return None
        spawn = (d.get("subagent") or {}).get("thread_spawn") or {}
        return spawn.get("parent_thread_id")


def _connect_ro(db: Path) -> sqlite3.Connection:
    uri = "file:" + db.as_posix().replace("?", "%3f").replace("#", "%23") + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=10.0)
    conn.execute("PRAGMA busy_timeout = 8000")
    return conn


def read_threads(db: Path) -> List[ThreadRow]:
    conn = _connect_ro(db)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM threads").fetchall()
        out: List[ThreadRow] = []
        for r in rows:
            def g(col: str):
                try:
                    return r[col]
                except (IndexError, KeyError):
                    return None

            created_ms = g("created_at_ms")
            if not created_ms and g("created_at"):
                created_ms = int(g("created_at")) * 1000
            updated_ms = g("updated_at_ms")
            if not updated_ms and g("updated_at"):
                updated_ms = int(g("updated_at")) * 1000
            out.append(ThreadRow(
                id=g("id"), rollout_path=g("rollout_path"), source=g("source"),
                thread_source=g("thread_source"), model=g("model"),
                model_provider=g("model_provider"), reasoning_effort=g("reasoning_effort"),
                cwd=g("cwd"), cli_version=g("cli_version"),
                sandbox_policy=g("sandbox_policy"), approval_mode=g("approval_mode"),
                title=g("title"), name=g("name"),
                preview=g("preview"), first_user_message=g("first_user_message"),
                tokens_used=g("tokens_used"), git_sha=g("git_sha"), git_branch=g("git_branch"),
                git_origin_url=g("git_origin_url"), agent_nickname=g("agent_nickname"),
                agent_role=g("agent_role"), agent_path=g("agent_path"),
                archived=int(g("archived") or 0),
                created_ms=created_ms, updated_ms=updated_ms,
            ))
        return out
    finally:
        conn.close()


def read_spawn_edges(db: Path) -> List[Tuple[str, str, Optional[str]]]:
    conn = _connect_ro(db)
    try:
        return [(r[0], r[1], r[2] if len(r) > 2 else None)
                for r in conn.execute("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges")]
    finally:
        conn.close()
