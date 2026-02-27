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
const STATUS_ENDPOINT = `${BACKEND_BASE_URL}/api/status`;
const VIDEO_ENDPOINT = `${BACKEND_BASE_URL}/api/video`;
const STATUS_POLL_MS = 1000;
const STREAM_RETRY_MS = 1200;

const DANGER_POSTURES = new Set(["stand", "stand_up"]);
const WARN_POSTURES = new Set(["sit"]);
const NOTIFY_POSTURES = new Set(["stand", "stand_up", "sit"]);

function normalizePosture(posture: string) {
  const p = posture.toLowerCase().trim();
  if (p === "standup") return "stand_up";
  if (p === "sitdown") return "sit_down";
  return p;
}

function badgeTone(posture: string): Tone {
  const p = normalizePosture(posture);
  if (DANGER_POSTURES.has(p)) return "danger";
  if (WARN_POSTURES.has(p)) return "warn";
  return "";
}

function isAlertPosture(posture: string) {
  return NOTIFY_POSTURES.has(normalizePosture(posture));
}

function fmt2(v: number | undefined) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

export default function App() {
  const [posture, setPosture] = useState("unknown");
  const [personCount, setPersonCount] = useState<string>("-");
  const [detScore, setDetScore] = useState("-");
  const [poseScore, setPoseScore] = useState("-");
  const [statusText, setStatusText] = useState("System is OFF");
  const [connected, setConnected] = useState(false);
  const [backendUnavailable, setBackendUnavailable] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");
  const [systemEnabled, setSystemEnabled] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  const [streamRetrying, setStreamRetrying] = useState(false);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const [alertModalText, setAlertModalText] = useState("");
  const [beepMuted, setBeepMuted] = useState(false);

  const lastAlertSeqRef = useRef(0);
  const lastAlertFingerprintRef = useRef("");
  const notificationPermissionRequestedRef = useRef(false);
  const beepTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRetryTimerRef = useRef<number | null>(null);

  const tone = useMemo(() => badgeTone(posture), [posture]);
  const isAlerting = useMemo(() => systemEnabled && isAlertPosture(posture), [posture, systemEnabled]);

  const notifyBrowser = async (nextPosture: string, message: string) => {
    if (!("Notification" in window)) return false;

    let permission = Notification.permission;
    if (permission === "default" && !notificationPermissionRequestedRef.current) {
      notificationPermissionRequestedRef.current = true;
      try {
        permission = await Notification.requestPermission();
      } catch {
        return false;
      }
    }

    if (permission !== "granted") return false;

    new Notification(`SafeRise Alert: ${nextPosture.toUpperCase()}`, {
      body: message,
      tag: `safe-rise-posture-${nextPosture}`,
    });
    return true;
  };

  const ensureAudioContext = async () => {
    const win = window as Window & { webkitAudioContext?: typeof AudioContext };
    const AudioContextCtor = window.AudioContext || win.webkitAudioContext;
    if (!AudioContextCtor) return null;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextCtor();
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    return audioContextRef.current;
  };

  const playBeepOnce = async () => {
    const ctx = await ensureAudioContext();
    if (!ctx) return;

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(990, ctx.currentTime);

    gainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.24);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.24);
  };

  const stopBeeping = () => {
    if (beepTimerRef.current !== null) {
      window.clearInterval(beepTimerRef.current);
      beepTimerRef.current = null;
    }
  };

  const startBeeping = () => {
    if (beepMuted || beepTimerRef.current !== null) return;

    void playBeepOnce();
    beepTimerRef.current = window.setInterval(() => {
      void playBeepOnce();
    }, 760);
  };

  const openAlertModal = (message: string) => {
    setAlertModalText(message);
    setAlertModalOpen(true);
    setBeepMuted(false);
  };

  const closeAlertModal = () => {
    setAlertModalOpen(false);
  };

  const clearStreamRetryTimer = () => {
    if (streamRetryTimerRef.current !== null) {
      window.clearTimeout(streamRetryTimerRef.current);
      streamRetryTimerRef.current = null;
    }
  };

  const openSystem = () => {
    if (systemEnabled) return;

    lastAlertSeqRef.current = 0;
    lastAlertFingerprintRef.current = "";
    setSystemEnabled(true);
    setBackendUnavailable(false);
    setConnected(false);
    setAlertMessage("");
    setStatusText("System ON. Connecting to backend...");
    setStreamRetrying(false);
    setStreamVersion((prev) => prev + 1);
  };

  const closeSystem = () => {
    if (!systemEnabled) return;

    lastAlertSeqRef.current = 0;
    lastAlertFingerprintRef.current = "";
    setSystemEnabled(false);
    setConnected(false);
    setBackendUnavailable(false);
    setStreamRetrying(false);
    setAlertMessage("");
    setAlertModalOpen(false);
    setPosture("unknown");
    setPersonCount("-");
    setDetScore("-");
    setPoseScore("-");
    setStatusText("System is OFF");
    stopBeeping();
    clearStreamRetryTimer();
  };

  const handleStreamError = () => {
    if (!systemEnabled) return;

    setStreamRetrying(true);
    if (streamRetryTimerRef.current !== null) return;

    streamRetryTimerRef.current = window.setTimeout(() => {
      setStreamVersion((prev) => prev + 1);
      streamRetryTimerRef.current = null;
    }, STREAM_RETRY_MS);
  };

  const handleStreamLoad = () => {
    setStreamRetrying(false);
    clearStreamRetryTimer();
  };

  useEffect(() => {
    document.body.classList.toggle("alert-mode", isAlerting);
    return () => {
      document.body.classList.remove("alert-mode");
    };
  }, [isAlerting]);

  useEffect(() => {
    if (alertModalOpen && !beepMuted) {
      startBeeping();
    } else {
      stopBeeping();
    }
  }, [alertModalOpen, beepMuted]);

  useEffect(() => {
    if (!alertModalOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAlertModal();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [alertModalOpen]);

  useEffect(() => {
    if (!systemEnabled) return;

    const pollStatus = async () => {
      try {
        const res = await fetch(STATUS_ENDPOINT);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = (await res.json()) as StatusPayload;
        const nextPosture = normalizePosture(String(data.posture ?? "unknown"));

        setPosture(nextPosture);
        setPersonCount(String(data.person_count ?? "-"));
        setDetScore(fmt2(data.det_score));
        setPoseScore(fmt2(data.pose_score));
        setConnected(true);
        setBackendUnavailable(false);

        const updated = data.updated_at
          ? new Date(data.updated_at * 1000).toLocaleTimeString()
          : new Date().toLocaleTimeString();
        setStatusText(`state=${String(data.message ?? "-")} | updated=${updated}`);

        setAlertMessage(data.alert_message ?? "");

        const message = data.alert_message || `ALERT: detected posture ${nextPosture.toUpperCase()}`;
        const alertSeq = Number(data.alert_seq ?? 0);

        let shouldNotify = false;
        if (alertSeq > 0) {
          if (alertSeq > lastAlertSeqRef.current) {
            lastAlertSeqRef.current = alertSeq;
            shouldNotify = isAlertPosture(nextPosture);
          }
        } else if (isAlertPosture(nextPosture)) {
          const fingerprint = `${nextPosture}|${message}|${String(data.updated_at ?? "")}`;
          if (fingerprint !== lastAlertFingerprintRef.current) {
            lastAlertFingerprintRef.current = fingerprint;
            shouldNotify = true;
          }
        }

        if (shouldNotify) {
          setAlertMessage(message);
          openAlertModal(message);
          const notified = await notifyBrowser(nextPosture, message);
          if (!notified) {
            setStatusText((prev) => `${prev} | browser notification blocked`);
          }
        }
      } catch {
        setConnected(false);
        setBackendUnavailable(true);
        setAlertMessage("");
        setStatusText(`Backend is unavailable. Please start server at ${BACKEND_BASE_URL}`);
      }
    };

    const interval = window.setInterval(() => {
      void pollStatus();
    }, STATUS_POLL_MS);
    void pollStatus();

    return () => {
      window.clearInterval(interval);
    };
  }, [systemEnabled]);

  useEffect(() => {
    return () => {
      stopBeeping();
      clearStreamRetryTimer();
      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  return (
    <div className={`wrap ${isAlerting ? "alerting" : ""}`}>
      <div className="top">
        <div className="brand">SafeRise Monitor</div>
        <div className={`chip ${systemEnabled && connected ? "live" : systemEnabled ? "danger" : ""}`}>
          {systemEnabled ? (
            connected ? (
              <>
                <span className="live-dot" />
                <span>Live status</span>
              </>
            ) : (
              "Connecting"
            )
          ) : (
            "System OFF"
          )}
        </div>
      </div>

      {backendUnavailable ? (
        <div className="backend-warning" role="alert">
          Backend is unavailable. กรุณาเปิด backend server ที่ {BACKEND_BASE_URL}
        </div>
      ) : null}

      {alertModalOpen ? (
        <div
          className="alert-modal-backdrop"
          role="alertdialog"
          aria-modal="true"
          aria-live="assertive"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeAlertModal();
            }
          }}
        >
          <div className="alert-modal">
            <div className="alert-modal-title">Emergency Alert</div>
            <div className="alert-modal-text">{alertModalText || "ตรวจพบท่าที่เสี่ยงต่อการลุกจากเตียง"}</div>
            <div className="alert-modal-meta">Current posture: {posture.toUpperCase()}</div>
            <div className="alert-modal-actions">
              <button className="btn secondary" onClick={() => setBeepMuted((prev) => !prev)}>
                {beepMuted ? "Unmute Beep" : "Mute Beep"}
              </button>
              <button className="btn danger" onClick={closeAlertModal}>
                Close Alert
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="layout">
        <div className="panel">
          <div className="head">
            <span>Realtime Stream</span>
            <span className={`chip ${tone}`}>{posture.toUpperCase()}</span>
          </div>

          <div className="video-actions">
            <button className="btn" onClick={openSystem} disabled={systemEnabled}>
              เปิดระบบ
            </button>
            <button className="btn danger" onClick={closeSystem} disabled={!systemEnabled}>
              ปิดระบบ
            </button>
          </div>

          <div className="system-state">
            <span>System State</span>
            <span className={`state ${systemEnabled ? "live" : ""}`}>{systemEnabled ? "RUNNING" : "OFF"}</span>
          </div>

          {streamRetrying ? <div className="stream-warning">Video interrupted. Reconnecting...</div> : null}

          {systemEnabled ? (
            <img
              key={streamVersion}
              className="video"
              src={`${VIDEO_ENDPOINT}?v=${streamVersion}`}
              alt="backend video stream"
              onError={handleStreamError}
              onLoad={handleStreamLoad}
            />
          ) : (
            <div className="video-off">System is OFF. Press เปิดระบบ to start stream.</div>
          )}
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

          <div className="status-endpoint">endpoints: {VIDEO_ENDPOINT} | {STATUS_ENDPOINT}</div>
          <div className={`status ${tone}`}>{statusText}</div>
        </div>
      </div>
    </div>
  );
}
