"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  AlertTriangle,
  CheckCircle2,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  uploadAudio,
  UploadFailed,
  type UploadProgress,
} from "@/lib/recording/upload";

/**
 * Browser-side interview recorder.
 *
 * Phases (one source of truth — the UI branches off `phase`):
 *
 *   idle              — pre-recording. Big "Start recording" CTA,
 *                       headphone reminder banner, mic-permission hint.
 *   asking-permission — getUserMedia() in flight after the user
 *                       click. Shown briefly because Safari requires
 *                       a user gesture to ask for the mic.
 *   permission-denied — getUserMedia() rejected. Show recovery
 *                       instructions; user may retry.
 *   recording / paused — MediaRecorder is running. Timer + level
 *                       meter + Pause/Resume + End controls.
 *   mic-disconnected  — the audio track ended mid-session (Bluetooth
 *                       headset slept, USB mic unplugged, OS revoked
 *                       permission, watchdog detected a silent stall).
 *                       Captured chunks are preserved in memory; the
 *                       user can reconnect their mic to keep going or
 *                       upload what they captured so far.
 *   stopping          — End clicked, waiting for the final dataavailable.
 *   uploading         — concatenated Blob is being PUT to storage with a
 *                       progress bar.
 *   upload-failed     — all retries exhausted. The Blob is still in
 *                       memory; "Retry upload" re-invokes the upload.
 *   transcribing      — server picked up the upload; we poll
 *                       /api/sessions/:id every 3 seconds for state.
 *   error             — terminal client error (no recovery path
 *                       beyond "start over").
 *
 * Critical safety rules enforced here (not just by convention):
 *   - During `recording` / `paused` / `stopping` we DO NOT show
 *     transcription, suggestions, partials, or any AI-derived
 *     content. The recording UI shows status / timer / level / controls
 *     ONLY. (Search this file for "interview-assist guard".)
 *   - On unmount we (a) stop tracks (releases the mic indicator the
 *     OS shows in the tab/menu bar), (b) close the AudioContext, and
 *     (c) drop the Blob ref so memory is freed.
 *   - `beforeunload` listener attaches the moment recording starts and
 *     detaches the moment we know upload succeeded. Tab-hidden
 *     warning fires after 30s of being hidden during recording.
 */

type Phase =
  | "idle"
  | "asking-permission"
  | "permission-denied"
  | "recording"
  | "paused"
  | "mic-disconnected"
  | "stopping"
  | "uploading"
  | "upload-failed"
  | "transcribing"
  | "error";

/**
 * Local enum for the three states the recorder cares about. We
 * deliberately name it `MicPermissionStatus` to avoid shadowing the
 * DOM lib's global `PermissionStatus` interface (the type returned
 * by `navigator.permissions.query`).
 */
type MicPermissionStatus = "unknown" | "granted" | "denied" | "prompt";

interface SessionMetadata {
  id: string;
  companyName: string;
  roleTitle: string;
  level: string;
  roundType: string;
}

const HIDDEN_WARNING_DELAY_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_ATTEMPTS = 200; // ~10 minutes

const MIME_TYPE = "audio/webm;codecs=opus";

/**
 * Watchdog window for the chunk pipeline. We ask MediaRecorder for a
 * `dataavailable` event every 1 second; if more than this many ms
 * pass without a chunk, the underlying capture has stalled (the most
 * common cause is a silent mic disconnect: Bluetooth headset went
 * idle, USB mic unplugged, OS revoked permission mid-stream — none
 * of which fire MediaRecorder's `error` event). We surface a clear
 * error and stop the recorder, instead of letting the timer run on
 * for minutes producing an 8-second clip.
 */
const CHUNK_WATCHDOG_TIMEOUT_MS = 8_000;
/**
 * How often the watchdog checks. Cheap interval — 1s is plenty.
 */
const CHUNK_WATCHDOG_TICK_MS = 1_000;

/**
 * Browser feature gate. If the runtime can't produce Opus-in-WebM
 * we'd ship an unplayable file to the server, so we refuse to enter
 * the recording flow at all and show a clear message instead.
 */
function detectMimeSupport(): { ok: boolean; mimeType: string } {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return { ok: false, mimeType: MIME_TYPE };
  }
  if (MediaRecorder.isTypeSupported(MIME_TYPE)) {
    return { ok: true, mimeType: MIME_TYPE };
  }
  // Safari historically didn't support Opus-in-WebM; check the
  // simpler fallback. We deliberately don't accept "audio/mp4" here
  // because the spec pins WebM end-to-end.
  if (MediaRecorder.isTypeSupported("audio/webm")) {
    return { ok: true, mimeType: "audio/webm" };
  }
  return { ok: false, mimeType: MIME_TYPE };
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function SessionRecorder({ session }: { session: SessionMetadata }) {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("idle");
  const [permission, setPermission] =
    useState<MicPermissionStatus>("unknown");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [elapsedMs, setElapsedMs] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [tabHiddenWarning, setTabHiddenWarning] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  );
  // Tracks the in-flight `getUserMedia` call when the user clicks
  // "Reconnect" from the mic-disconnected panel. We don't reuse the
  // `asking-permission` phase here because that phase swaps back to
  // the pre-recording UI, which would hide the captured-so-far state.
  const [isReconnecting, setIsReconnecting] = useState(false);

  /**
   * Refs for everything that should NOT trigger a re-render when it
   * mutates. The MediaRecorder, audio chunks, AudioContext, and the
   * still-in-memory Blob fall in that bucket.
   */
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const accumulatedMsRef = useRef(0);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hiddenSinceRef = useRef<number | null>(null);
  const hiddenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Wall-clock timestamp of the most recent chunk we received from
   * MediaRecorder. Used by the watchdog (`chunkWatchdogRef`) to
   * detect stalled captures — a stream that has stopped emitting
   * data while the recorder still claims to be "recording".
   */
  const lastChunkAtRef = useRef<number | null>(null);
  const chunkWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const blobRef = useRef<Blob | null>(null);
  const uploadKeyRef = useRef<string | null>(null);
  // Cached upload token data so retries can skip the upload-url call.
  // The session moves to `recording` state when the token is issued,
  // so a retry that calls upload-url again gets a 409. Storing the URL
  // + headers here lets us re-use the token on retry as long as the
  // URL hasn't expired (upload URLs are valid for ~60 min;
  // retries happen within seconds).
  const uploadUrlRef = useRef<string | null>(null);
  const uploadHeadersRef = useRef<Record<string, string> | null>(null);
  const pollAttemptsRef = useRef(0);

  const mimeSupport = useMemo(() => detectMimeSupport(), []);

  /* -------------------------------------------------------------- */
  /*                  Permission status (best-effort)                */
  /* -------------------------------------------------------------- */

  // Read the permission state if the browser exposes it (Chrome,
  // Firefox; Safari ignores 'microphone' in `permissions.query` and
  // returns 'unknown' here, which is fine — we then ask for real
  // when the user clicks Start).
  //
  // We also subscribe to the `change` event on the PermissionStatus
  // so a user who toggles the site permission in browser settings
  // (e.g. unblocks the mic after seeing the "blocked" panel) sees
  // the recorder UI update without a refresh.
  useEffect(() => {
    let cancelled = false;
    if (typeof navigator === "undefined") return;
    if (!navigator.permissions?.query) return;

    let status: PermissionStatus | null = null;
    let onChange: (() => void) | null = null;

    const apply = (state: PermissionState) => {
      const next: MicPermissionStatus =
        state === "granted"
          ? "granted"
          : state === "denied"
            ? "denied"
            : "prompt";
      setPermission(next);
    };

    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((result) => {
        if (cancelled) return;
        status = result;
        apply(result.state);
        const handler = () => {
          if (cancelled) return;
          // Re-read off the captured `result` because TS narrows
          // around the closure but the runtime mutation on
          // `result.state` is what fires the change event.
          apply(result.state);
        };
        onChange = handler;
        if (typeof result.addEventListener === "function") {
          result.addEventListener("change", handler);
        } else {
          result.onchange = handler;
        }
      })
      .catch(() => {
        // Safari rejects with a TypeError on `microphone`. Treat as
        // unknown so the UI shows the headphone reminder rather than
        // a misleading "denied" state.
      });

    return () => {
      cancelled = true;
      if (status && onChange) {
        if (typeof status.removeEventListener === "function") {
          status.removeEventListener("change", onChange);
        } else if (status.onchange === onChange) {
          status.onchange = null;
        }
      }
    };
  }, []);

  /* -------------------------------------------------------------- */
  /*                       Cleanup helpers                           */
  /* -------------------------------------------------------------- */

  const stopAudioPipeline = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {
        // already disconnected
      }
      analyserRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current
        .close()
        .catch(() => {
          // closing a closed context throws — ignore.
        });
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current = null;
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {
        // The page may have been backgrounded; the lock is already
        // released. Nothing to do.
      });
      wakeLockRef.current = null;
    }
  }, []);

  const stopElapsedTimer = useCallback(() => {
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
  }, []);

  const stopChunkWatchdog = useCallback(() => {
    if (chunkWatchdogRef.current) {
      clearInterval(chunkWatchdogRef.current);
      chunkWatchdogRef.current = null;
    }
    lastChunkAtRef.current = null;
  }, []);

  /**
   * Full teardown — called on unmount and on terminal errors. Drops
   * the Blob ref too so the GC can reclaim a multi-MB recording the
   * moment we're done with it.
   */
  const teardownEverything = useCallback(() => {
    stopAudioPipeline();
    releaseWakeLock();
    stopElapsedTimer();
    stopChunkWatchdog();
    if (hiddenTimerRef.current) {
      clearTimeout(hiddenTimerRef.current);
      hiddenTimerRef.current = null;
    }
    recorderRef.current = null;
    chunksRef.current = [];
    blobRef.current = null;
  }, [releaseWakeLock, stopAudioPipeline, stopChunkWatchdog, stopElapsedTimer]);

  useEffect(() => {
    return () => {
      teardownEverything();
    };
  }, [teardownEverything]);

  /* -------------------------------------------------------------- */
  /*                  beforeunload + visibility                      */
  /* -------------------------------------------------------------- */

  // Recording / paused / stopping / uploading / upload-failed are all
  // states where losing the tab means losing data. The poll-while-
  // transcribing phase is fine to leave (server will keep working).
  const isInDangerPhase =
    phase === "recording" ||
    phase === "paused" ||
    phase === "mic-disconnected" ||
    phase === "stopping" ||
    phase === "uploading" ||
    phase === "upload-failed";

  useEffect(() => {
    if (!isInDangerPhase) return;

    const handler = (e: BeforeUnloadEvent) => {
      // Modern browsers ignore custom strings; setting returnValue
      // is what triggers the native prompt.
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
    };
  }, [isInDangerPhase]);

  // Tab-hidden detection. If the candidate's tab is in the background
  // for >30s during recording we surface a banner (without stopping
  // the recorder — modern browsers keep the audio capture alive).
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;

    const onVisibilityChange = () => {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now();
        hiddenTimerRef.current = setTimeout(() => {
          setTabHiddenWarning(true);
        }, HIDDEN_WARNING_DELAY_MS);
      } else {
        hiddenSinceRef.current = null;
        if (hiddenTimerRef.current) {
          clearTimeout(hiddenTimerRef.current);
          hiddenTimerRef.current = null;
        }
        setTabHiddenWarning(false);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (hiddenTimerRef.current) {
        clearTimeout(hiddenTimerRef.current);
        hiddenTimerRef.current = null;
      }
    };
  }, [phase]);

  /* -------------------------------------------------------------- */
  /*                   Audio-level meter loop                        */
  /* -------------------------------------------------------------- */

  const startMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      // RMS over the time-domain buffer, mapped from [128 ± 128] into
      // [0, 1]. This is intentionally cheap; we don't need an exact
      // VU meter, just a "is the mic getting any signal" indicator.
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // Soft compression so a normal speaking voice fills most of the
      // bar without clipping for a clap.
      const level = Math.min(1, rms * 2);
      setAudioLevel(level);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  /* -------------------------------------------------------------- */
  /*                    Start / Stop / Pause                         */
  /* -------------------------------------------------------------- */

  const startElapsedTimer = useCallback(() => {
    startedAtRef.current = Date.now();
    tickIntervalRef.current = setInterval(() => {
      const startedAt = startedAtRef.current ?? Date.now();
      setElapsedMs(accumulatedMsRef.current + (Date.now() - startedAt));
    }, 250);
  }, []);

  /**
   * Wire a freshly-acquired MediaStream into the audio meter and a
   * new MediaRecorder, then call `recorder.start(1000)`.
   *
   * Used by BOTH the initial start and the post-disconnect reconnect
   * flow — that's why we don't touch `chunksRef` or
   * `accumulatedMsRef` here. The caller decides whether this is a
   * fresh recording (clears chunks) or a continuation (keeps them).
   *
   * Returns `true` on success, `false` if something failed before
   * the recorder started running. On failure, this helper has
   * already torn down anything it set up and set `errorMessage`;
   * the caller is responsible for choosing the destination phase.
   */
  const attachStreamAndStart = useCallback(
    (stream: MediaStream): boolean => {
      streamRef.current = stream;

      // AudioContext for the level meter. Created here (not at module
      // scope) because Safari blocks AudioContext construction without
      // a user gesture — we have one (the click that started/resumed
      // recording).
      try {
        const audioCtx = new AudioContext();
        audioContextRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);
        analyserRef.current = analyser;
        startMeter();
      } catch {
        // Meter is purely visual; if the AudioContext refuses, keep
        // recording without it.
      }

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          mimeType: mimeSupport.mimeType,
          audioBitsPerSecond: 64000,
        });
      } catch (err) {
        stopAudioPipeline();
        setErrorMessage(
          err instanceof Error
            ? `Could not start the recorder: ${err.message}`
            : "Could not start the recorder.",
        );
        return false;
      }
      recorderRef.current = recorder;

      /**
       * Recoverable "the mic stopped feeding us audio" handler. The
       * captured chunks stay in `chunksRef` so the user can either
       * reconnect their mic and keep going or end the session and
       * upload what was captured.
       *
       * Idempotent against the specific `recorder` instance — if
       * track.ended and the watchdog both fire, only the first one
       * does the teardown.
       */
      const handleMicDisconnected = (message: string, source: string) => {
        if (recorderRef.current !== recorder) return;
        console.warn(`[recorder] mic disconnected (${source}):`, message);
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // The recorder may already be tearing down; ignore.
        }
        stopChunkWatchdog();
        stopAudioPipeline();
        // Keep wake lock — we're still in a recording flow, just
        // waiting on the user to reconnect their mic.
        const startedAt = startedAtRef.current;
        if (startedAt !== null) {
          accumulatedMsRef.current += Date.now() - startedAt;
          startedAtRef.current = null;
        }
        stopElapsedTimer();
        recorderRef.current = null;
        setElapsedMs(accumulatedMsRef.current);
        setPhase("mic-disconnected");
        setErrorMessage(message);
      };

      /**
       * Genuinely fatal handler — MediaRecorder.onerror means the
       * encoder/muxer hit a condition we can't recover from on the
       * client. We drop chunks and bail to the terminal error state.
       *
       * We DO inspect the underlying audio track first: some browsers
       * fire `onerror` (rather than `track.ended`) when the device
       * disappears mid-stream, and that case is recoverable.
       */
      const handleFatalError = (message: string, source: string) => {
        if (recorderRef.current !== recorder) return;
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack && audioTrack.readyState === "ended") {
          handleMicDisconnected(message, `${source} (track ended)`);
          return;
        }
        console.error(`[recorder] capture failed (${source}):`, message);
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // The recorder may already be tearing down; ignore.
        }
        stopChunkWatchdog();
        stopAudioPipeline();
        releaseWakeLock();
        stopElapsedTimer();
        recorderRef.current = null;
        chunksRef.current = [];
        blobRef.current = null;
        setPhase("error");
        setErrorMessage(message);
      };

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
          lastChunkAtRef.current = Date.now();
        }
      };
      recorder.onerror = (event: Event) => {
        const detail =
          (event as Event & { error?: { message?: string; name?: string } })
            .error;
        const message =
          detail?.message ||
          detail?.name ||
          "The browser stopped recording unexpectedly. " +
            "Please reload the tab and start a new session.";
        handleFatalError(message, "MediaRecorder.onerror");
      };

      // Listen for the audio track itself ending or being muted
      // mid-stream. These are the silent-failure modes MediaRecorder
      // does NOT fire `error` for:
      //
      //   - `ended`: the track stopped emitting samples permanently.
      //     Bluetooth headset auto-disconnected, USB mic unplugged,
      //     OS revoked permission, the user clicked "Stop sharing"
      //     in Chrome's mic indicator. Without this listener the
      //     timer keeps ticking, no chunks land, and the user sees
      //     a clipped recording on review.
      //
      //   - `mute`: temporary "no audio reaching the track" state
      //     (system audio routing change, headphone unplug). We
      //     don't outright fail on `mute` because Chrome sometimes
      //     emits transient mutes during HW switches; the chunk
      //     watchdog escalates if it persists.
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.addEventListener("ended", () => {
          handleMicDisconnected(
            "Your microphone disconnected. We've paused the recording — " +
              "reconnect your mic and tap Resume to keep going, or end the " +
              "session to upload what you've recorded so far.",
            "MediaStreamTrack.ended",
          );
        });
        audioTrack.addEventListener("mute", () => {
          console.warn("[recorder] audio track muted mid-stream");
        });
      }

      lastChunkAtRef.current = Date.now();

      // Chunk watchdog — escalates the silent-failure case when:
      //
      //   - The audio track DIDN'T fire `ended` (some browsers/HW
      //     combinations just stop producing samples without ending
      //     the track), AND
      //   - MediaRecorder's `onerror` ALSO didn't fire (the encoder
      //     is happy with empty input).
      //
      // The watchdog fires when no `dataavailable` has landed for
      // `CHUNK_WATCHDOG_TIMEOUT_MS`. While paused, we reset
      // `lastChunkAtRef` to "now" on every tick so resume picks up
      // cleanly. This is a RECOVERABLE failure — the user can
      // reconnect their mic and continue.
      chunkWatchdogRef.current = setInterval(() => {
        const r = recorderRef.current;
        if (!r) return;
        if (r.state === "paused" || r.state === "inactive") {
          lastChunkAtRef.current = Date.now();
          return;
        }
        const lastAt = lastChunkAtRef.current ?? Date.now();
        const idleMs = Date.now() - lastAt;
        if (idleMs > CHUNK_WATCHDOG_TIMEOUT_MS) {
          handleMicDisconnected(
            "Your microphone stopped sending audio. We've paused the " +
              "recording — check your mic (especially Bluetooth headsets " +
              "that auto-sleep) and tap Resume to keep going.",
            `chunk watchdog (idle ${Math.round(idleMs / 1000)}s)`,
          );
        }
      }, CHUNK_WATCHDOG_TICK_MS);

      // Collect chunks every 1s. If `start()` throws (some Android
      // Chromes balk if the mic is suddenly unavailable between
      // getUserMedia and start), tear down what we set up and bail.
      try {
        recorder.start(1000);
      } catch (err) {
        console.error("[recorder] MediaRecorder.start failed:", err);
        stopChunkWatchdog();
        stopAudioPipeline();
        recorderRef.current = null;
        setErrorMessage(
          err instanceof Error
            ? `Could not start the recorder: ${err.message}`
            : "Could not start the recorder.",
        );
        return false;
      }

      return true;
    },
    [
      mimeSupport.mimeType,
      releaseWakeLock,
      startMeter,
      stopAudioPipeline,
      stopChunkWatchdog,
      stopElapsedTimer,
    ],
  );

  const handleStartRecording = useCallback(async () => {
    setErrorMessage(null);

    if (!mimeSupport.ok) {
      setPhase("error");
      setErrorMessage(
        "Your browser doesn't support the audio format we record (Opus in WebM). " +
          "Please use the latest Chrome, Firefox, or Safari.",
      );
      return;
    }

    setPhase("asking-permission");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1,
        },
      });
    } catch (err) {
      setPermission("denied");
      setPhase("permission-denied");
      setErrorMessage(
        err instanceof Error
          ? `Microphone access was blocked: ${err.name}.`
          : "Microphone access was blocked.",
      );
      return;
    }

    setPermission("granted");

    // Wake-lock request (best-effort). Not all browsers expose this;
    // Firefox didn't ship it until recently. Failure is non-fatal —
    // the user just risks the screen sleeping.
    try {
      const wakeLock = (
        navigator as Navigator & {
          wakeLock?: { request: (kind: "screen") => Promise<WakeLockSentinel> };
        }
      ).wakeLock;
      if (wakeLock) {
        wakeLockRef.current = await wakeLock.request("screen");
      }
    } catch {
      // ignore
    }

    chunksRef.current = [];
    accumulatedMsRef.current = 0;

    if (!attachStreamAndStart(stream)) {
      releaseWakeLock();
      setPhase("error");
      return;
    }

    setElapsedMs(0);
    setPhase("recording");
    startElapsedTimer();
  }, [
    attachStreamAndStart,
    mimeSupport,
    releaseWakeLock,
    startElapsedTimer,
  ]);

  /**
   * Re-acquire the mic after a disconnect and resume the SAME
   * session. Captured chunks in `chunksRef` and the previously
   * accumulated elapsed time are preserved — we just spin up a fresh
   * MediaRecorder against the new stream and keep appending.
   *
   * The resulting upload is two WebM segments concatenated, which
   * the server's transcription pipeline accepts. The alternative
   * (forcing a brand new session) loses everything captured so far.
   */
  const handleReconnectMic = useCallback(async () => {
    if (isReconnecting) return;
    setErrorMessage(null);
    setIsReconnecting(true);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1,
        },
      });
    } catch (err) {
      setIsReconnecting(false);
      setErrorMessage(
        err instanceof Error
          ? `Couldn't reconnect microphone (${err.name}). Check your device and try again.`
          : "Couldn't reconnect microphone. Check your device and try again.",
      );
      return;
    }

    // Wake lock may have been released while the page was hidden or
    // during the disconnect; re-request inside this user gesture.
    if (!wakeLockRef.current) {
      try {
        const wakeLock = (
          navigator as Navigator & {
            wakeLock?: { request: (kind: "screen") => Promise<WakeLockSentinel> };
          }
        ).wakeLock;
        if (wakeLock) {
          wakeLockRef.current = await wakeLock.request("screen");
        }
      } catch {
        // ignore
      }
    }

    if (!attachStreamAndStart(stream)) {
      setIsReconnecting(false);
      return;
    }

    setIsReconnecting(false);
    startElapsedTimer();
    setPhase("recording");
  }, [attachStreamAndStart, isReconnecting, startElapsedTimer]);

  const handlePauseResume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      try {
        recorder.pause();
      } catch (err) {
        console.warn("[recorder] pause failed:", err);
        return;
      }
      const startedAt = startedAtRef.current ?? Date.now();
      accumulatedMsRef.current += Date.now() - startedAt;
      stopElapsedTimer();
      setPhase("paused");
    } else if (recorder.state === "paused") {
      try {
        recorder.resume();
      } catch (err) {
        console.warn("[recorder] resume failed:", err);
        return;
      }
      startElapsedTimer();
      setPhase("recording");
    }
  }, [startElapsedTimer, stopElapsedTimer]);

  const finalizeBlobAndUpload = useCallback(
    async (blob: Blob, durationSeconds: number) => {
      // Defensive sanity checks before we touch the network. These
      // mirror the server's `audioUploadedBodySchema` bounds — failing
      // here is faster and lets us tell the user "your recording was
      // too short" instead of bouncing through a server validation
      // error. A 0-byte blob almost always means MediaRecorder never
      // produced a `dataavailable` (mic glitch, auto-revoked
      // permission); under 1s is below the bottom of the schema.
      if (blob.size === 0) {
        setPhase("error");
        setErrorMessage(
          "Your recording came back empty. The browser may have lost " +
            "access to the microphone — please start a new session.",
        );
        return;
      }
      if (durationSeconds < 1) {
        setPhase("error");
        setErrorMessage(
          "The recording was too short to upload. Please start a new " +
            "session and record for at least one second.",
        );
        return;
      }

      blobRef.current = blob;

      setPhase("uploading");
      setUploadProgress({ loaded: 0, total: blob.size });
      setRetryAttempt(null);

      try {
        // Re-use a cached upload URL if one exists from a previous
        // attempt. Calling upload-url again would fail with 409 because
        // the session is already in `recording` state after the first
        // token was issued. Upload URLs are valid for ~60 min;
        // retries occur within seconds so expiry is not a concern in
        // practice. If the URL has somehow expired, the server returns 403 and
        // the user sees a clear "upload failed" prompt to start a new
        // session rather than the confusing "recording already started".
        let url: string;
        let key: string;
        let requiredHeaders: Record<string, string>;

        if (
          uploadUrlRef.current &&
          uploadKeyRef.current &&
          uploadHeadersRef.current
        ) {
          url = uploadUrlRef.current;
          key = uploadKeyRef.current;
          requiredHeaders = uploadHeadersRef.current;
        } else {
          const presignRes = await fetch(
            `/api/sessions/${session.id}/audio/upload-url`,
            {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            },
          );
          if (!presignRes.ok) {
            let detail = `upload-url failed with ${presignRes.status}`;
            try {
              const body = (await presignRes.json()) as { message?: string };
              if (body.message) detail = body.message;
            } catch {
              // body wasn't JSON
            }
            throw new UploadFailed(detail, presignRes.status);
          }
          ({ url, key, requiredHeaders } = (await presignRes.json()) as {
            url: string;
            key: string;
            requiredHeaders: Record<string, string>;
          });
          uploadKeyRef.current = key;
          uploadUrlRef.current = url;
          uploadHeadersRef.current = requiredHeaders;
        }

        await uploadAudio({
          url,
          blob,
          headers: requiredHeaders,
          onProgress: (p) => setUploadProgress(p),
          onRetry: (attempt) => setRetryAttempt(attempt),
        });

        // Notify the server: blob is up, kick off transcription.
        const finRes = await fetch(
          `/api/sessions/${session.id}/audio/uploaded`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              key,
              file_size_bytes: blob.size,
              duration_seconds: durationSeconds,
            }),
          },
        );
        if (!finRes.ok) {
          let detail = `finalize failed with ${finRes.status}`;
          try {
            const body = (await finRes.json()) as { message?: string };
            if (body.message) detail = body.message;
          } catch {
            // body wasn't JSON
          }
          throw new UploadFailed(detail, finRes.status);
        }

        // Free the local Blob — server has it. The recorder phase
        // changes to `transcribing` and the polling effect picks up.
        blobRef.current = null;
        setUploadProgress(null);
        setPhase("transcribing");
      } catch (err) {
        console.error("[recorder] upload pipeline failed:", err);
        setErrorMessage(
          err instanceof Error
            ? err.message
            : "Upload failed. Check your connection and try again.",
        );
        setPhase("upload-failed");
      }
    },
    [session.id],
  );

  const handleEndSession = useCallback(() => {
    const recorder = recorderRef.current;

    // Capture duration BEFORE pause/stop so the calculation is
    // independent of whether we were currently paused. If there's no
    // active recorder (the mic-disconnected case), just use the
    // accumulated time — the live segment has already been folded in
    // by the disconnect handler.
    const startedAt = startedAtRef.current;
    const liveMs =
      recorder && recorder.state === "recording" && startedAt
        ? Date.now() - startedAt
        : 0;
    const totalMs = accumulatedMsRef.current + liveMs;
    const durationSeconds = Math.max(1, Math.round(totalMs / 1000));

    setPhase("stopping");
    stopElapsedTimer();
    stopChunkWatchdog();

    // Mic-disconnected path: no active recorder, just chunks in
    // memory. Assemble and upload directly.
    if (!recorder || recorder.state === "inactive") {
      if (chunksRef.current.length === 0) {
        setPhase("error");
        setErrorMessage(
          "We didn't capture any audio before the microphone disconnected. " +
            "Please start a new session.",
        );
        return;
      }
      const blob = new Blob(chunksRef.current, {
        type: mimeSupport.mimeType,
      });
      chunksRef.current = [];
      stopAudioPipeline();
      releaseWakeLock();
      void finalizeBlobAndUpload(blob, durationSeconds);
      return;
    }

    // Final dataavailable arrives via onstop. Wire it up here so
    // both pause-and-stop and recording-and-stop converge to one
    // upload call.
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: mimeSupport.mimeType,
      });
      // Free the chunks immediately — we have one consolidated blob now.
      chunksRef.current = [];
      stopAudioPipeline();
      releaseWakeLock();
      void finalizeBlobAndUpload(blob, durationSeconds);
    };

    try {
      // Stopping a paused recorder is allowed and is the only way to
      // get the final dataavailable to fire.
      recorder.stop();
    } catch (err) {
      console.error("[recorder] stop failed:", err);
      // We may still have chunks; try to assemble and upload them.
      const blob = new Blob(chunksRef.current, {
        type: mimeSupport.mimeType,
      });
      chunksRef.current = [];
      stopAudioPipeline();
      releaseWakeLock();
      void finalizeBlobAndUpload(blob, durationSeconds);
    }
  }, [
    finalizeBlobAndUpload,
    mimeSupport.mimeType,
    releaseWakeLock,
    stopAudioPipeline,
    stopChunkWatchdog,
    stopElapsedTimer,
  ]);

  const handleRetryUpload = useCallback(() => {
    const blob = blobRef.current;
    if (!blob) {
      setPhase("error");
      setErrorMessage(
        "Recording is no longer in memory — it was lost. " +
          "Please start a new session.",
      );
      return;
    }
    const durationSeconds = Math.max(1, Math.round(elapsedMs / 1000));
    void finalizeBlobAndUpload(blob, durationSeconds);
  }, [elapsedMs, finalizeBlobAndUpload]);

  /* -------------------------------------------------------------- */
  /*                   Polling for transcription                     */
  /* -------------------------------------------------------------- */

  useEffect(() => {
    if (phase !== "transcribing") return;

    pollAttemptsRef.current = 0;
    let cancelled = false;
    // AbortController so a cleanup (phase change, unmount, navigate)
    // also aborts an in-flight fetch — otherwise we'd keep parsing
    // and acting on a response after the user already moved on.
    const controller = new AbortController();

    const poll = async () => {
      if (cancelled) return;
      pollAttemptsRef.current += 1;
      try {
        const res = await fetch(`/api/sessions/${session.id}`, {
          credentials: "same-origin",
          headers: { "Cache-Control": "no-cache" },
          signal: controller.signal,
        });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as {
            session: { state: string };
          };
          if (cancelled) return;
          if (body.session.state === "review") {
            // Cast through `Route` because the dynamic `${session.id}`
            // segment can't be resolved against the generated typed
            // routes union at compile time.
            router.replace(
              `/sessions/${session.id}/review` as Route,
            );
            return;
          }
        }
      } catch (err) {
        // Don't loop after an explicit abort.
        if ((err as { name?: string })?.name === "AbortError") return;
        // Transient network errors during polling are fine — we'll
        // try again on the next interval.
      }

      if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
        if (!cancelled) {
          setPhase("error");
          setErrorMessage(
            "Transcription is taking longer than expected. We've saved your " +
              "recording — refresh this page in a few minutes to check on it.",
          );
        }
        return;
      }

      if (!cancelled) {
        timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    let timeoutId: ReturnType<typeof setTimeout> = setTimeout(
      poll,
      POLL_INTERVAL_MS,
    );

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [phase, router, session.id]);

  /* -------------------------------------------------------------- */
  /*                              UI                                 */
  /* -------------------------------------------------------------- */

  return (
    <section className="mx-auto max-w-3xl px-6 py-10" aria-live="polite">
      {/* Persistent banner during danger phases. We deliberately
          leave it on through `upload-failed` because losing the tab
          there really does lose the recording. */}
      {isInDangerPhase && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
          <span>
            Don&apos;t close this tab — your recording will be lost.
          </span>
        </div>
      )}

      {tabHiddenWarning && (phase === "recording" || phase === "paused") && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
          <span>
            This tab has been hidden for over 30 seconds. Some browsers may
            throttle the recorder while the tab is in the background — please
            keep this tab visible for the rest of the interview.
          </span>
        </div>
      )}

      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {session.companyName} · {session.roundType.replace("_", " ")}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {session.roleTitle}
        </h1>
        <p className="text-sm text-muted-foreground">
          Level: {session.level}
        </p>
      </header>

      {/* Phase-driven body. */}
      <div className="mt-10">
        {phase === "idle" || phase === "asking-permission" ? (
          <PreRecordingPanel
            permission={permission}
            mimeSupportOk={mimeSupport.ok}
            onStart={handleStartRecording}
            isAsking={phase === "asking-permission"}
          />
        ) : phase === "permission-denied" ? (
          <PermissionDeniedPanel
            errorMessage={errorMessage}
            onRetry={() => {
              setPhase("idle");
              setErrorMessage(null);
            }}
          />
        ) : phase === "recording" ||
          phase === "paused" ||
          phase === "stopping" ? (
          <RecordingPanel
            phase={phase}
            elapsedMs={elapsedMs}
            audioLevel={audioLevel}
            onPauseResume={handlePauseResume}
            onEnd={handleEndSession}
          />
        ) : phase === "mic-disconnected" ? (
          <MicDisconnectedPanel
            elapsedMs={elapsedMs}
            errorMessage={errorMessage}
            isReconnecting={isReconnecting}
            onReconnect={handleReconnectMic}
            onEnd={handleEndSession}
          />
        ) : phase === "uploading" ? (
          <UploadingPanel
            progress={uploadProgress}
            retryAttempt={retryAttempt}
          />
        ) : phase === "upload-failed" ? (
          <UploadFailedPanel
            errorMessage={errorMessage}
            onRetry={handleRetryUpload}
          />
        ) : phase === "transcribing" ? (
          <TranscribingPanel />
        ) : (
          <ErrorPanel errorMessage={errorMessage} />
        )}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*                             Sub-panels                              */
/* ─────────────────────────────────────────────────────────────────── */

function PreRecordingPanel({
  permission,
  mimeSupportOk,
  onStart,
  isAsking,
}: {
  permission: MicPermissionStatus;
  mimeSupportOk: boolean;
  onStart: () => void;
  isAsking: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Headphone reminder — visible by design. The spec calls
          "annoying enough that users will get headphones" a feature,
          not a bug; this is the load-bearing copy + color. */}
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <Headphones className="size-5 shrink-0 text-amber-600" aria-hidden />
        <div>
          <p className="font-semibold text-amber-900 dark:text-amber-200">
            Wear headphones (seriously).
          </p>
          <p className="mt-1 text-amber-800/90 dark:text-amber-200/80">
            Without headphones, your microphone may pick up the
            interviewer&apos;s voice through your speakers — recording someone
            without consent can be illegal in your jurisdiction. InterviewReplay is
            built to record only your voice.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background p-6">
        <div className="flex items-center gap-3">
          {permission === "granted" ? (
            <CheckCircle2
              className="size-4 text-emerald-600"
              aria-hidden
            />
          ) : permission === "denied" ? (
            <MicOff className="size-4 text-destructive" aria-hidden />
          ) : (
            <Mic className="size-4 text-muted-foreground" aria-hidden />
          )}
          <p className="text-sm">
            Microphone:{" "}
            <span className="font-medium">
              {permission === "granted"
                ? "ready"
                : permission === "denied"
                  ? "blocked — enable it in your browser settings"
                  : "permission required"}
            </span>
          </p>
        </div>

        {!mimeSupportOk && (
          <p className="mt-4 text-sm text-destructive">
            Your browser can&apos;t produce the audio format we need. Please
            switch to the latest Chrome, Firefox, or Safari.
          </p>
        )}

        <div className="mt-6 flex justify-center">
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={onStart}
            disabled={isAsking || !mimeSupportOk}
            className="h-14 px-10 text-base"
          >
            {isAsking ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Asking for microphone…
              </>
            ) : (
              <>
                <Mic className="size-4" aria-hidden />
                Start recording
              </>
            )}
          </Button>
        </div>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          We&apos;ll ask your browser for microphone access. You can always
          stop early.
        </p>
      </div>
    </div>
  );
}

function PermissionDeniedPanel({
  errorMessage,
  onRetry,
}: {
  errorMessage: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center">
      <MicOff
        className="mx-auto size-8 text-destructive"
        aria-hidden
      />
      <h2 className="mt-3 text-lg font-semibold">Microphone access blocked</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {errorMessage ??
          "Your browser blocked microphone access. Open this site's permissions in your browser settings, allow the microphone, then try again."}
      </p>
      <Button
        type="button"
        variant="outline"
        className="mt-5"
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

function RecordingPanel({
  phase,
  elapsedMs,
  audioLevel,
  onPauseResume,
  onEnd,
}: {
  phase: "recording" | "paused" | "stopping";
  elapsedMs: number;
  audioLevel: number;
  onPauseResume: () => void;
  onEnd: () => void;
}) {
  const isPaused = phase === "paused";
  const isStopping = phase === "stopping";

  return (
    <div className="space-y-8">
      {/* interview-assist guard: this block intentionally renders ONLY
          status/timer/level/controls. Do NOT add transcription,
          partials, suggestions, or any AI-derived content here. */}
      <div className="flex flex-col items-center gap-4">
        <div
          className={`flex size-24 items-center justify-center rounded-full ${
            isPaused ? "bg-muted" : "bg-destructive/10"
          }`}
        >
          <span
            aria-hidden
            className={`block size-12 rounded-full ${
              isPaused
                ? "bg-muted-foreground/40"
                : "bg-destructive animate-pulse"
            }`}
          />
        </div>
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {isStopping
            ? "Finalizing…"
            : isPaused
              ? "Paused"
              : "Recording"}
        </p>
        <p className="text-5xl font-mono font-semibold tabular-nums">
          {formatElapsed(elapsedMs)}
        </p>
      </div>

      <LevelMeter level={audioLevel} dimmed={isPaused || isStopping} />

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onPauseResume}
          disabled={isStopping}
        >
          {isPaused ? (
            <>
              <Play className="size-4" aria-hidden />
              Resume
            </>
          ) : (
            <>
              <Pause className="size-4" aria-hidden />
              Pause
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="default"
          size="lg"
          onClick={onEnd}
          disabled={isStopping}
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        >
          {isStopping ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Finishing…
            </>
          ) : (
            <>
              <Square className="size-4" aria-hidden />
              End session
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function MicDisconnectedPanel({
  elapsedMs,
  errorMessage,
  isReconnecting,
  onReconnect,
  onEnd,
}: {
  elapsedMs: number;
  errorMessage: string | null;
  isReconnecting: boolean;
  onReconnect: () => void;
  onEnd: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-6 text-center">
        <MicOff
          className="mx-auto size-8 text-amber-600"
          aria-hidden
        />
        <h2 className="mt-3 text-lg font-semibold">
          Microphone disconnected
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {errorMessage ??
            "Your microphone stopped sending audio. We've paused the recording and kept what you captured so far."}
        </p>
        <p className="mt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Captured so far
        </p>
        <p className="mt-1 font-mono text-3xl font-semibold tabular-nums">
          {formatElapsed(elapsedMs)}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={onReconnect}
            disabled={isReconnecting}
          >
            {isReconnecting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Reconnecting…
              </>
            ) : (
              <>
                <Mic className="size-4" aria-hidden />
                Reconnect &amp; resume
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={onEnd}
            disabled={isReconnecting}
          >
            <Square className="size-4" aria-hidden />
            End &amp; upload what we have
          </Button>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Don&apos;t close this tab — your recording is still in memory.
        </p>
      </div>
    </div>
  );
}

function LevelMeter({ level, dimmed }: { level: number; dimmed: boolean }) {
  const BARS = 12;
  // `level` is in [0, 1]; map to a number of "lit" bars.
  const lit = Math.round(level * BARS);
  return (
    <div
      role="meter"
      aria-label="Microphone input level"
      aria-valuenow={Math.round(level * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`mx-auto flex h-12 w-full max-w-md items-end justify-center gap-1 ${
        dimmed ? "opacity-40" : ""
      }`}
    >
      {Array.from({ length: BARS }, (_, i) => {
        const active = i < lit;
        const heightPct = 30 + (i / (BARS - 1)) * 70;
        return (
          <span
            key={i}
            aria-hidden
            className={`w-3 rounded-sm transition-colors ${
              active
                ? i > BARS * 0.8
                  ? "bg-destructive"
                  : i > BARS * 0.5
                    ? "bg-amber-500"
                    : "bg-emerald-500"
                : "bg-muted"
            }`}
            style={{ height: `${heightPct}%` }}
          />
        );
      })}
    </div>
  );
}

function UploadingPanel({
  progress,
  retryAttempt,
}: {
  progress: UploadProgress | null;
  retryAttempt: number | null;
}) {
  const pct = progress
    ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
    : 0;
  return (
    <div className="rounded-xl border border-border bg-background p-6 text-center">
      <Loader2
        className="mx-auto size-8 animate-spin text-muted-foreground"
        aria-hidden
      />
      <h2 className="mt-3 text-lg font-semibold">Uploading recording…</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {retryAttempt
          ? `Retrying (attempt ${retryAttempt + 1})…`
          : "Please keep this tab open until the upload finishes."}
      </p>
      <div className="mt-5 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-[width] duration-200"
          style={{ width: `${pct}%` }}
          aria-hidden
        />
      </div>
      <p className="mt-2 text-xs tabular-nums text-muted-foreground">
        {pct}%
      </p>
    </div>
  );
}

function UploadFailedPanel({
  errorMessage,
  onRetry,
}: {
  errorMessage: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center">
      <AlertTriangle
        className="mx-auto size-8 text-destructive"
        aria-hidden
      />
      <h2 className="mt-3 text-lg font-semibold">Upload failed</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {errorMessage ??
          "We couldn't upload your recording after several attempts."}{" "}
        Your recording is still in this tab&apos;s memory — don&apos;t close
        the tab.
      </p>
      <Button
        type="button"
        variant="primary"
        size="lg"
        onClick={onRetry}
        className="mt-5"
      >
        <RotateCcw className="size-4" aria-hidden />
        Retry upload
      </Button>
    </div>
  );
}

function TranscribingPanel() {
  return (
    <div className="rounded-xl border border-border bg-background p-6 text-center">
      <Loader2
        className="mx-auto size-8 animate-spin text-muted-foreground"
        aria-hidden
      />
      <h2 className="mt-3 text-lg font-semibold">Transcribing…</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Your recording is uploaded. We&apos;re generating the transcript now —
        this usually takes one to two minutes.
      </p>
    </div>
  );
}

function ErrorPanel({ errorMessage }: { errorMessage: string | null }) {
  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center">
      <AlertTriangle
        className="mx-auto size-8 text-destructive"
        aria-hidden
      />
      <h2 className="mt-3 text-lg font-semibold">Something went wrong</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {errorMessage ?? "An unknown error occurred."}
      </p>
    </div>
  );
}
