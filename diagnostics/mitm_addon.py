"""可选网络诊断插件（--network-diagnostics）—— 不在 Level-0 标准采集链路。

仅当需要调查 transport 层问题（429/重连/首字节延迟）时临时启用：
    mitmproxy -s diagnostics/mitm_addon.py

v3 决策：标准 Baseline 完全移除 MITM（消除 measurement effect）；本文件仅为占位骨架，
启用前需先评估证书固定状态与对 Wall Time/TTFT 指标的干扰。
"""
from __future__ import annotations

# import mitmproxy.http  # 取消注释并安装 mitmproxy 后启用
#
# TARGET_HOSTS = ("chatgpt.com",)
#
#
# def responseheaders(flow: "mitmproxy.http.HTTPFlow"):
#     if flow.request.host not in TARGET_HOSTS:
#         return
#     if "text/event-stream" in (flow.response.headers.get("content-type") or ""):
#         flow.response.stream = chunk_logger  # 逐 chunk 时间戳
#
#
# def chunk_logger(chunk: bytes):
#     import time
#     print(f"[diag] chunk t={time.time():.3f}s bytes={len(chunk)}")
