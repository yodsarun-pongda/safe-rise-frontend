import { useEffect, useMemo, useRef, useState } from "react";

type StatusPayload = {
  posture?: string;
  det_score?: number;
  pose_score?: number;
  person_count?: number;
  message?: string;
  updated_at?: number;
  alert_message?: string;
  alert_seq?: number;
};

type Tone = "" | "warn" | "danger";
const BACKEND_BASE_URL = "http://127.0.0.1:8000";

function badgeTone(posture: string): Tone {
  if (posture === "stand") return "danger";
  if (posture === "sit" || posture === "skip") return "warn";
  return "";
}

function fmt2(v: number | undefined) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

export default function App() {
  const [posture, setPosture] = useState("Loading...");
  const [personCount, setPersonCount] = useState<string>("-");
  const [detScore, setDetScore] = useState("-");
  const [poseScore, setPoseScore] = useState("-");
  const [statusText, setStatusText] = useState("Connecting...");
  const [connected, setConnected] = useState(false);
  const [backendUnavailable, setBackendUnavailable] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");
  const [streamVersion, setStreamVersion] = useState(0);
  const [streamRetrying, setStreamRetrying] = useState(false);

  const lastAlertSeqRef = useRef(0);
  const streamRetryTimerRef = useRef<number | null>(null);

  const tone = useMemo(() => badgeTone(posture), [posture]);
  const streamUrl = useMemo(
    () => `${BACKEND_BASE_URL}/api/video?v=${streamVersion}`,
    [streamVersion],
  );

  useEffect(() => {
    const pollStatus = async () => {
      try {
        const res = await fetch(`${BACKEND_BASE_URL}/api/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = (await res.json()) as StatusPayload;
        const nextPosture = String(data.posture ?? "unknown");

        setPosture(nextPosture);
        setPersonCount(String(data.person_count ?? "-"));
        setDetScore(fmt2(data.det_score));
        setPoseScore(fmt2(data.pose_score));
        setConnected(true);
        setBackendUnavailable(false);

        const updated = new Date((data.updated_at ?? 0) * 1000).toLocaleTimeString();
        setStatusText(`state=${String(data.message ?? "-")} | updated=${updated}`);

        if (data.alert_message) {
          setAlertMessage(data.alert_message);
        } else {
          setAlertMessage("");
        }

        const alertSeq = Number(data.alert_seq ?? 0);
        if (alertSeq > lastAlertSeqRef.current) {
          lastAlertSeqRef.current = alertSeq;
          window.alert(data.alert_message || "ALERT: patient may leave the bed");
        }
      } catch {
        setConnected(false);
        setBackendUnavailable(true);
        setAlertMessage("");
        setStatusText("Backend is unavailable. Please start server at 127.0.0.1:8000");
      }
    };

    const interval = window.setInterval(pollStatus, 1000);
    void pollStatus();

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      if (streamRetryTimerRef.current !== null) {
        window.clearTimeout(streamRetryTimerRef.current);
      }
    };
  }, []);

  const handleStreamError = () => {
    setStreamRetrying(true);
    if (streamRetryTimerRef.current !== null) return;

    streamRetryTimerRef.current = window.setTimeout(() => {
      setStreamVersion((prev) => prev + 1);
      streamRetryTimerRef.current = null;
    }, 1200);
  };

  const handleStreamLoad = () => {
    setStreamRetrying(false);
  };

  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">SafeRise Monitor</div>
        <div className={`chip ${connected ? "live" : "danger"}`}>
          {connected ? (
            <>
              <span className="live-dot" />
              <span>Live status</span>
            </>
          ) : (
            "Disconnected"
          )}
        </div>
      </div>

      {backendUnavailable ? (
        <div className="backend-warning" role="alert">
          Backend is unavailable. กรุณาเปิด backend server ที่ {BACKEND_BASE_URL}
        </div>
      ) : null}

      <div className="layout">
        <div className="panel">
          <div className="head">
            <span>Realtime Camera</span>
            <span className={`chip ${tone}`}>{posture.toUpperCase()}</span>
          </div>

          {streamRetrying ? <div className="stream-warning">Video interrupted. Reconnecting...</div> : null}

          <img
            key={streamVersion}
            className="video"
            src={streamUrl}
            alt="video stream"
            onError={handleStreamError}
            onLoad={handleStreamLoad}
          />
        </div>

        <div className="panel">
          <div className="head">
            <span>Safe Rise - A Class Group</span>
          </div>

          {alertMessage ? <div className="alert">{alertMessage}</div> : null}

          <div className="meta">
            <div className="item">
              <div className="k">Posture</div>
              <div className="v">{posture.toUpperCase()}</div>
            </div>
            <div className="item">
              <div className="k">Persons</div>
              <div className="v">{personCount}</div>
            </div>
            <div className="item">
              <div className="k">Detect Score</div>
              <div className="v">{detScore}</div>
            </div>
            <div className="item">
              <div className="k">Pose Score</div>
              <div className="v">{poseScore}</div>
            </div>
          </div>

          <div className={`status ${tone}`}>{statusText}</div>
        </div>
      </div>
    </div>
  );
}
