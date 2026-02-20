import type { PoseStatus } from "../types";

export type SmoothConfig = {
  enabled: boolean;
  windowSize: number; // e.g. 15
  minStableMs: number; // e.g. 800
};

export function normalizeStatus(s: any): PoseStatus {
  const v = String(s ?? "").toLowerCase();
  if (v === "sit") return "sit";
  if (v === "sleep") return "sleep";
  if (v === "stand") return "stand";
  return "unknown";
}

export function majorityVote(items: PoseStatus[]) {
  const m = new Map<PoseStatus, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  let best: PoseStatus = "unknown";
  let bestN = -1;
  for (const [k, n] of m) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return { best, count: bestN };
}

export function formatTime(ts?: string) {
  if (!ts) return new Date().toLocaleTimeString();
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return new Date().toLocaleTimeString();
  return d.toLocaleTimeString();
}
