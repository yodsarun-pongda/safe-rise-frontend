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
type SourceMode = "camera" | "video" | "unknown";

const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_BASE_URL ?? "").trim().replace(/\/$/, "");
const API_BASE_PATH = BACKEND_BASE_URL ? `${BACKEND_BASE_URL}/api` : "/api";
const STATUS_ENDPOINT = `${API_BASE_PATH}/status`;
const VIDEO_ENDPOINT = `${API_BASE_PATH}/video`;
const REFERENCE_LINE_ENDPOINT = `${API_BASE_PATH}/reference-line`;
const REFERENCE_BASELINE_ENDPOINT = `${API_BASE_PATH}/reference-baseline`;
const BACKEND_TARGET = BACKEND_BASE_URL || "same-origin (/api)";
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

function fmtHms(date: Date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function fmtUpdatedAt(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fmtHms(new Date());
  }

  // Accept both seconds and milliseconds timestamps.
  const ms = value >= 1_000_000_000_000 ? value : value * 1000;
  return fmtHms(new Date(ms));
}

export default function App() {
  const [posture, setPosture] = useState("-");
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
  const [alertEnabled, setAlertEnabled] = useState(true);
  const [refLineEnabled, setRefLineEnabled] = useState(false);
  const [baselineForm, setBaselineForm] = useState({
    x1: "100",
    y1: "420",
    x2: "520",
    y2: "390",
  });
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [baselineNotice, setBaselineNotice] = useState("");
  const [baselineError, setBaselineError] = useState("");
  const [sourceMode, setSourceMode] = useState<SourceMode>("unknown");
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceConfigValue, setSourceConfigValue] = useState<string>("0");
  const [sourceVideoPath, setSourceVideoPath] = useState<string>("mock-video");
  const [sourceError, setSourceError] = useState("");

  const lastAlertSeqRef = useRef(0);
  const lastAlertFingerprintRef = useRef("");
  const notificationPermissionRequestedRef = useRef(false);
  const beepTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRetryTimerRef = useRef<number | null>(null);

  const tone = useMemo(() => badgeTone(posture), [posture]);
  const isAlerting = useMemo(
    () => systemEnabled && alertEnabled && isAlertPosture(posture),
    [posture, systemEnabled, alertEnabled],
  );

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

  const resolveSourceMode = (data: Record<string, unknown>): SourceMode => {
    const isCameraStream = data.is_camera_stream;
    if (typeof isCameraStream === "boolean") {
      return isCameraStream ? "camera" : "video";
    }

    const mode = String(data.mode ?? data.source_mode ?? "").toLowerCase().trim();
    if (mode.includes("camera")) return "camera";
    if (mode.includes("video") || mode.includes("file") || mode.includes("local")) return "video";
    return "unknown";
  };

  const applySourceConfig = (data: Record<string, unknown>) => {
    const mode = resolveSourceMode(data);
    const sourceValue = data.source ?? data.camera_source ?? data.current_source;
    const localVideoSource = data.local_video_source ?? data.video_source;

    setSourceMode(mode);
    if (sourceValue !== undefined && sourceValue !== null) {
      setSourceConfigValue(String(sourceValue));
    }
    if (localVideoSource !== undefined && localVideoSource !== null) {
      setSourceVideoPath(String(localVideoSource));
    }
  };

  const loadBaselineConfig = async () => {
    try {
      setBaselineBusy(true);
      setBaselineError("");
      setBaselineNotice("");

      const [lineRes, baseRes] = await Promise.all([
        fetch(REFERENCE_LINE_ENDPOINT),
        fetch(REFERENCE_BASELINE_ENDPOINT),
      ]);
      if (!lineRes.ok) throw new Error(`reference-line HTTP ${lineRes.status}`);
      if (!baseRes.ok) throw new Error(`reference-baseline HTTP ${baseRes.status}`);

      const lineData = (await lineRes.json()) as Record<string, unknown>;
      const baseData = (await baseRes.json()) as Record<string, unknown>;

      setRefLineEnabled(Boolean(lineData.enabled));

      const fromRoot = baseData;
      const manualObj =
        typeof baseData.manual === "object" && baseData.manual !== null
          ? (baseData.manual as Record<string, unknown>)
          : null;
      const source = manualObj ?? fromRoot;

      const nextX1 = Number(source.x1);
      const nextY1 = Number(source.y1);
      const nextX2 = Number(source.x2);
      const nextY2 = Number(source.y2);

      if (
        Number.isFinite(nextX1) &&
        Number.isFinite(nextY1) &&
        Number.isFinite(nextX2) &&
        Number.isFinite(nextY2)
      ) {
        setBaselineForm({
          x1: String(nextX1),
          y1: String(nextY1),
          x2: String(nextX2),
          y2: String(nextY2),
        });
      }

      setBaselineNotice("Loaded baseline config");
    } catch (err) {
      setBaselineError(err instanceof Error ? err.message : "Failed to load baseline config");
    } finally {
      setBaselineBusy(false);
    }
  };

  const setReferenceLineMode = async (enabled: boolean) => {
    try {
      setBaselineBusy(true);
      setBaselineError("");
      setBaselineNotice("");

      const res = await fetch(`${REFERENCE_LINE_ENDPOINT}?enabled=${enabled ? "true" : "false"}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`reference-line HTTP ${res.status}`);

      setRefLineEnabled(enabled);
      setBaselineNotice(`Reference line ${enabled ? "enabled" : "disabled"}`);
    } catch (err) {
      setBaselineError(err instanceof Error ? err.message : "Failed to update reference line");
    } finally {
      setBaselineBusy(false);
    }
  };

  const saveManualBaseline = async () => {
    const x1 = Number(baselineForm.x1);
    const y1 = Number(baselineForm.y1);
    const x2 = Number(baselineForm.x2);
    const y2 = Number(baselineForm.y2);

    if (![x1, y1, x2, y2].every(Number.isFinite)) {
      setBaselineError("Please enter valid numbers for x1 y1 x2 y2");
      return;
    }

    try {
      setBaselineBusy(true);
      setBaselineError("");
      setBaselineNotice("");

      const query = new URLSearchParams({
        x1: String(x1),
        y1: String(y1),
        x2: String(x2),
        y2: String(y2),
      });
      const res = await fetch(`${REFERENCE_BASELINE_ENDPOINT}?${query.toString()}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`reference-baseline HTTP ${res.status}`);

      setBaselineNotice("Manual baseline saved");
    } catch (err) {
      setBaselineError(err instanceof Error ? err.message : "Failed to save baseline");
    } finally {
      setBaselineBusy(false);
    }
  };

  const clearManualBaseline = async () => {
    try {
      setBaselineBusy(true);
      setBaselineError("");
      setBaselineNotice("");

      const res = await fetch(REFERENCE_BASELINE_ENDPOINT, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`reference-baseline HTTP ${res.status}`);

      setBaselineNotice("Manual baseline cleared");
    } catch (err) {
      setBaselineError(err instanceof Error ? err.message : "Failed to clear baseline");
    } finally {
      setBaselineBusy(false);
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

  const toggleAlertEnabled = () => {
    setAlertEnabled((prev) => {
      const next = !prev;
      if (!next) {
        setAlertModalOpen(false);
        setBeepMuted(false);
        stopBeeping();
        setStatusText((prevStatus) => `${prevStatus} | alert disabled`);
      } else {
        setStatusText((prevStatus) => `${prevStatus} | alert enabled`);
      }
      return next;
    });
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
    if (!alertModalOpen) return;
    if (isAlertPosture(posture)) return;
    closeAlertModal();
  }, [posture, alertModalOpen]);

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

        const updated = fmtUpdatedAt(data.updated_at);
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

        if (shouldNotify && alertEnabled) {
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
        setStatusText(`Backend is unavailable. Please start server at ${BACKEND_TARGET}`);
      }
    };

    const interval = window.setInterval(() => {
      void pollStatus();
    }, STATUS_POLL_MS);
    void pollStatus();

    return () => {
      window.clearInterval(interval);
    };
  }, [systemEnabled, alertEnabled]);

  useEffect(() => {
    if (!systemEnabled) return;
    void loadBaselineConfig();
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
      </div>

      {backendUnavailable ? (
        <div className="backend-warning" role="alert">
          Backend is unavailable. Please re-check backend server at {BACKEND_TARGET}
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
            {/* <span className={`chip ${tone}`}>{posture.toUpperCase()}</span> */}
          </div>

          <div className="video-actions">
            <button className="btn" onClick={openSystem} disabled={systemEnabled}>
              Start System
            </button>
            <button className="btn danger" onClick={closeSystem} disabled={!systemEnabled}>
              Close System
            </button>
            <button className={`btn ${alertEnabled ? "secondary" : "danger"}`} onClick={toggleAlertEnabled}>
              {alertEnabled ? "Disable Alert" : "Enable Alert"}
            </button>
          </div>

          <div className="system-states">
            <div className="system-state">
              <span>System State</span>
              <span className={`state ${systemEnabled ? "live" : ""}`}>{systemEnabled ? "RUNNING" : "OFF"}</span>
            </div>

            <div className="system-state">
              <span>Alert State</span>
              <span className={`state ${alertEnabled ? "live" : ""}`}>{alertEnabled ? "ENABLED" : "DISABLED"}</span>
            </div>
          </div>

          {sourceError ? <div className="stream-warning error">{sourceError}</div> : null}
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
            <div className="video-off">System is OFF. Please press Start stream.</div>
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

          <div className="baseline-config">
            <div className="baseline-title">Base Line Config</div>

            <div className="baseline-row">
              <button className="btn secondary" onClick={() => void loadBaselineConfig()} disabled={baselineBusy}>
                Load
              </button>
              <button
                className="btn secondary"
                onClick={() => void setReferenceLineMode(true)}
                disabled={baselineBusy || refLineEnabled}
              >
                Enable Ref Line
              </button>
              <button
                className="btn secondary"
                onClick={() => void setReferenceLineMode(false)}
                disabled={baselineBusy || !refLineEnabled}
              >
                Disable Ref Line
              </button>
            </div>

            <div className="baseline-grid">
              <label className="baseline-field">
                <span>x1</span>
                <input
                  value={baselineForm.x1}
                  onChange={(event) => setBaselineForm((prev) => ({ ...prev, x1: event.target.value }))}
                  inputMode="numeric"
                />
              </label>
              <label className="baseline-field">
                <span>y1</span>
                <input
                  value={baselineForm.y1}
                  onChange={(event) => setBaselineForm((prev) => ({ ...prev, y1: event.target.value }))}
                  inputMode="numeric"
                />
              </label>
              <label className="baseline-field">
                <span>x2</span>
                <input
                  value={baselineForm.x2}
                  onChange={(event) => setBaselineForm((prev) => ({ ...prev, x2: event.target.value }))}
                  inputMode="numeric"
                />
              </label>
              <label className="baseline-field">
                <span>y2</span>
                <input
                  value={baselineForm.y2}
                  onChange={(event) => setBaselineForm((prev) => ({ ...prev, y2: event.target.value }))}
                  inputMode="numeric"
                />
              </label>
            </div>

            <div className="baseline-row">
              <button className="btn" onClick={() => void saveManualBaseline()} disabled={baselineBusy}>
                Save Baseline
              </button>
              <button className="btn danger" onClick={() => void clearManualBaseline()} disabled={baselineBusy}>
                Clear Baseline
              </button>
            </div>

            <div className="baseline-hint">
              reference-line: <strong>{refLineEnabled ? "ON" : "OFF"}</strong>
            </div>
            {baselineNotice ? <div className="baseline-note ok">{baselineNotice}</div> : null}
            {baselineError ? <div className="baseline-note err">{baselineError}</div> : null}
          </div>

          <div className="status-endpoint">endpoints: {VIDEO_ENDPOINT} | {STATUS_ENDPOINT}</div>
          <div className={`status ${tone}`}>{statusText}</div>
        </div>
      </div>
    </div>
  );
}
