import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";

type Props = {
  url: string;
  kind: "auto" | "hls" | "mjpeg" | "file";
};

export default function VideoPlayer({ url, kind }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [err, setErr] = useState<string>("");

  const detectedKind = useMemo(() => {
    if (kind !== "auto") return kind;
    const u = url.toLowerCase();
    if (u.endsWith(".m3u8")) return "hls";
    if (u.includes("mjpeg") || u.endsWith(".mjpg") || u.endsWith(".mjpeg")) return "mjpeg";
    return "file";
  }, [url, kind]);

  useEffect(() => {
    setErr("");
    if (!url) return;

    const video = videoRef.current;
    if (!video) return;

    if (detectedKind === "hls") {
      // Safari supports HLS natively sometimes
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        video.play().catch(() => {});
        return;
      }

      if (Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 6,
          maxLiveSyncPlaybackRate: 1.2,
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data?.fatal) setErr(`HLS error: ${data.type}`);
        });
        return () => hls.destroy();
      } else {
        setErr("Browser นี้ไม่รองรับ HLS ผ่าน MSE");
      }
    }

    if (detectedKind === "file") {
      video.src = url;
      video.play().catch(() => {});
      const onError = () => setErr("Video เล่นไม่ได้ (ตรวจ url / codec / CORS)");
      video.addEventListener("error", onError);
      return () => video.removeEventListener("error", onError);
    }
  }, [url, detectedKind]);

  if (!url) {
    return <div className="videoEmpty">ใส่ Video URL ก่อน (HLS .m3u8 / MJPEG / mp4)</div>;
  }

  if (detectedKind === "mjpeg") {
    return (
      <div className="videoWrap">
        {err && <div className="warn">{err}</div>}
        <img className="mjpeg" src={url} alt="mjpeg stream" />
      </div>
    );
  }

  return (
    <div className="videoWrap">
      {err && <div className="warn">{err}</div>}
      <video ref={videoRef} className="video" autoPlay playsInline muted controls />
    </div>
  );
}
