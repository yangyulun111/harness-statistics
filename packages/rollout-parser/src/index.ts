/**
 * Rollout JSONL 增量读取 —— Python oracle ledger/rollout_tail.py 的 TS 移植。
 * 断点续读只处理新增字节，只消费完整行（半行留到下一轮）。
 * 背景：本机实测最大 rollout 达 694MB，绝不能全量重扫。
 */
import fs from "node:fs";

export const CHUNK = 4 * 1024 * 1024; // 每次磁盘读取 4MB
export const MAX_LINES = 20_000; // 单次返回行数上限（防巨文件一次吃满内存）
export const MAX_BYTES = 64 * 1024 * 1024; // 单次消费字节上限

export interface ReadNewLinesResult {
  lines: string[];
  newOffset: number;
  truncated: boolean;
}

const NL = Buffer.from("\n");

export function readNewLines(filePath: string, lastOffset: number): ReadNewLinesResult {
  const size = fs.statSync(filePath).size;
  let offset = lastOffset;
  let truncated = false;
  if (size < lastOffset) {
    offset = 0;
    truncated = true; // 文件变小（轮转/截断）→ 从头重读
  }

  const lines: string[] = [];
  let consumed = 0;
  const fd = fs.openSync(filePath, "r");
  try {
    let readPos = offset;
    let remainder = Buffer.alloc(0);
    let stop = false;
    while (!stop) {
      const buf = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, buf, 0, CHUNK, readPos);
      if (n === 0) break;
      readPos += n;
      const data =
        remainder.length > 0 ? Buffer.concat([remainder, buf.subarray(0, n)]) : buf.subarray(0, n);
      // 完整行 = 以 \n 结尾的段；最后一段留作 remainder（半行留到下一轮）
      const complete: Buffer[] = [];
      let start = 0;
      for (;;) {
        const i = data.indexOf(NL, start);
        if (i === -1) break;
        complete.push(data.subarray(start, i));
        start = i + 1;
      }
      remainder = data.subarray(start);
      for (const line of complete) {
        lines.push(line.toString("utf8"));
        offset += line.length + 1;
        consumed += line.length + 1;
        if (lines.length >= MAX_LINES || consumed >= MAX_BYTES) {
          stop = true;
          break;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { lines, newOffset: offset, truncated };
}
