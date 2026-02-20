export type PoseStatus = "sit" | "sleep" | "stand" | "unknown";

export type DetectorMessage =
  | {
      camera_id?: string;
      ts?: string; // ISO
      status?: PoseStatus | string;
      confidence?: number;
      fps_in?: number;
      fps_out?: number;
      latency_ms?: number;
      person?: Array<{ id?: number; bbox?: [number, number, number, number] }>;
      type?: string;
      [k: string]: any;
    }
  | {
      type: "state_change";
      camera_id?: string;
      ts?: string;
      from?: PoseStatus | string;
      to?: PoseStatus | string;
      confidence?: number;
      stable_for_ms?: number;
      [k: string]: any;
    };

export type TimelineItem = {
  id: string;
  ts: string; // display text
  title: string;
  detail?: string;
  kind: "state_change" | "message" | "system";
};
