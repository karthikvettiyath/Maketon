import { useEffect, useMemo, useRef, useState } from "react";
import "./LandingIntro.css";

const INTRO_AUDIO_URL = import.meta.env.VITE_INTRO_AUDIO_URL || "/stranger-things-intro.mp3";

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function safeStopAudio(handle) {
  if (!handle) return;
  try {
    handle.stop?.();
  } catch {
    // ignore
  }
}

function createExternalIntroAudio({ url, volume = 0.8 } = {}) {
  if (!url) return null;
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.loop = false;
  audio.volume = Math.max(0, Math.min(1, volume));

  const stop = () => {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // ignore
    }
  };

  const play = async () => {
    await audio.play();
  };

  return { stop, play };
}

function createRetroIntroAudio({ volume = 0.7 } = {}) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;

  const ctx = new AudioContextCtor();
  const master = ctx.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume));

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -18;
  limiter.knee.value = 30;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.005;
  limiter.release.value = 0.25;

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 30;
  hp.Q.value = 0.7;

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 900;
  lp.Q.value = 0.9;

  const delay = ctx.createDelay(0.8);
  delay.delayTime.value = 0.22;

  const feedback = ctx.createGain();
  feedback.gain.value = 0.28;

  const wet = ctx.createGain();
  wet.gain.value = 0.35;

  const dry = ctx.createGain();
  dry.gain.value = 0.85;

  master.connect(hp);
  hp.connect(limiter);
  limiter.connect(ctx.destination);

  const bus = ctx.createGain();
  bus.gain.value = 0.9;

  bus.connect(lp);
  lp.connect(dry);
  dry.connect(master);

  lp.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wet);
  wet.connect(master);

  const now = ctx.currentTime;

  const makeOsc = (type) => {
    const o = ctx.createOscillator();
    o.type = type;
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g);
    g.connect(bus);
    return { o, g };
  };

  // Bass drone
  const bass = makeOsc("sawtooth");
  bass.o.frequency.setValueAtTime(55, now);
  bass.g.gain.setValueAtTime(0, now);
  bass.g.gain.linearRampToValueAtTime(0.18, now + 0.08);
  bass.g.gain.linearRampToValueAtTime(0.12, now + 6.0);

  // Pulse layer
  const pulse = makeOsc("square");
  pulse.o.frequency.setValueAtTime(110, now);
  pulse.g.gain.setValueAtTime(0, now);
  pulse.g.gain.linearRampToValueAtTime(0.08, now + 0.06);

  // Simple motif (original)
  const lead = makeOsc("triangle");
  lead.g.gain.setValueAtTime(0, now);

  const semitone = (rootHz, st) => rootHz * Math.pow(2, st / 12);
  const motifRoot = 65.41; // Low C (C2 approx)
  // C Maj 7 Arpeggio: C, E, G, B, C...
  const motif = [0, 4, 7, 11, 12, 11, 7, 4];
  const step = 0.33; // ~90 BPM eighth notes

  // We loop the arpeggio for the duration
  const totalNotes = 32;

  for (let i = 0; i < totalNotes; i += 1) {
    const noteIndex = i % motif.length;
    const t0 = now + 0.5 + i * step;
    const t1 = t0 + step * 1.5; // Legato
    const f = semitone(motifRoot, motif[noteIndex]);

    lead.o.frequency.setValueAtTime(f, t0);
    lead.g.gain.setValueAtTime(0, t0);
    lead.g.gain.linearRampToValueAtTime(0.15, t0 + 0.05);
    lead.g.gain.linearRampToValueAtTime(0.1, t1 - 0.05);
    lead.g.gain.linearRampToValueAtTime(0, t1);

    // Pulse gate for movement (heartbeat rhythm)
    pulse.g.gain.setValueAtTime(0.04, t0);
    pulse.g.gain.linearRampToValueAtTime(0.08, t0 + 0.04);
    pulse.g.gain.linearRampToValueAtTime(0.04, t1);
  }

  const stopAt = now + 7.2;
  bass.g.gain.setValueAtTime(bass.g.gain.value, stopAt - 0.3);
  bass.g.gain.linearRampToValueAtTime(0, stopAt);
  pulse.g.gain.setValueAtTime(pulse.g.gain.value, stopAt - 0.25);
  pulse.g.gain.linearRampToValueAtTime(0, stopAt);

  bass.o.start(now);
  pulse.o.start(now);
  lead.o.start(now);

  bass.o.stop(stopAt);
  pulse.o.stop(stopAt);
  lead.o.stop(stopAt);

  const stop = () => {
    try {
      bass.o.stop();
    } catch {
      // ignore
    }
    try {
      pulse.o.stop();
    } catch {
      // ignore
    }
    try {
      lead.o.stop();
    } catch {
      // ignore
    }
    try {
      ctx.close();
    } catch {
      // ignore
    }
  };

  return { ctx, stop };
}

export default function LandingIntro({
  title = "MAKETON",
  subtitle = "",
  minDurationMs = 5000,
  durationMs = 9500,
  fadeOutMs = 450,
  onDone
}) {
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [started, setStarted] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [canSkip, setCanSkip] = useState(false);
  const [skipCountdown, setSkipCountdown] = useState(0);
  const audioHandleRef = useRef(null);
  const doneRef = useRef(false);
  const mountedAtRef = useRef(0);
  const exitTimeoutRef = useRef(null);
  const minTimerRef = useRef(null);
  const countdownTimerRef = useRef(null);

  const letters = useMemo(() => String(title).split(""), [title]);

  function finalizeDone() {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone?.();
  }

  function requestExit() {
    if (doneRef.current || exiting) return;
    const now = Date.now();
    const elapsed = now - (mountedAtRef.current || now);
    const minMs = Math.max(0, Number(minDurationMs) || 0);

    if (elapsed < minMs) {
      const remaining = minMs - elapsed;
      if (exitTimeoutRef.current) window.clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = window.setTimeout(() => {
        requestExit();
      }, remaining);
      return;
    }

    setExiting(true);
    safeStopAudio(audioHandleRef.current);
    audioHandleRef.current = null;

    const ms = reducedMotion ? 0 : Math.max(0, Number(fadeOutMs) || 0);
    if (exitTimeoutRef.current) window.clearTimeout(exitTimeoutRef.current);
    exitTimeoutRef.current = window.setTimeout(() => {
      finalizeDone();
    }, ms);
  }

  async function startAudio() {
    if (audioHandleRef.current) return;

    // Prefer a user-provided audio file (must be properly licensed by the user).
    const external = createExternalIntroAudio({ url: INTRO_AUDIO_URL, volume: 0.8 });
    if (external) {
      audioHandleRef.current = external;
      try {
        await external.play();
        setAudioBlocked(false);
      } catch {
        setAudioBlocked(true);
        safeStopAudio(external);
        audioHandleRef.current = null;
      }
      return;
    }

    // Fallback: built-in original synth stinger.
    const synth = createRetroIntroAudio({ volume: 0.7 });
    if (!synth) return;
    audioHandleRef.current = synth;

    try {
      if (synth.ctx?.state === "suspended") {
        await synth.ctx.resume();
      }
      setAudioBlocked(false);
    } catch {
      setAudioBlocked(true);
      safeStopAudio(synth);
      audioHandleRef.current = null;
    }
  }

  useEffect(() => {
    mountedAtRef.current = Date.now();

    // Try to start audio; if blocked, we’ll prompt for a click.
    startAudio().catch(() => {
      setAudioBlocked(true);
    });

    const baseMs = reducedMotion ? Math.max(0, Number(minDurationMs) || 0) : Math.max(0, Number(durationMs) || 0);
    const ms = Math.max(Math.max(0, Number(minDurationMs) || 0), baseMs);
    const t = window.setTimeout(() => {
      requestExit();
    }, ms);

    const minMs = Math.max(0, Number(minDurationMs) || 0);
    setCanSkip(false);
    setSkipCountdown(Math.ceil(minMs / 1000));

    if (minTimerRef.current) window.clearTimeout(minTimerRef.current);
    minTimerRef.current = window.setTimeout(() => {
      setCanSkip(true);
      setSkipCountdown(0);
    }, minMs);

    if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = window.setInterval(() => {
      const now = Date.now();
      const elapsed = now - (mountedAtRef.current || now);
      const remaining = Math.max(0, minMs - elapsed);
      setSkipCountdown(remaining > 0 ? Math.ceil(remaining / 1000) : 0);
      if (remaining <= 0) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    }, 250);

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        if (canSkip) requestExit();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        // Space/Enter: attempt audio, otherwise skip.
        startAudio().catch(() => setAudioBlocked(true));
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKeyDown);
      if (minTimerRef.current) window.clearTimeout(minTimerRef.current);
      if (exitTimeoutRef.current) window.clearTimeout(exitTimeoutRef.current);
      if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
      safeStopAudio(audioHandleRef.current);
      audioHandleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSkip, durationMs, fadeOutMs, minDurationMs, reducedMotion]);

  useEffect(() => {
    // Mark started after first paint so CSS animations kick in.
    const r = window.requestAnimationFrame(() => setStarted(true));
    return () => window.cancelAnimationFrame(r);
  }, []);

  return (
    <div className={exiting ? "introRoot introRootExiting" : "introRoot"} aria-label="Intro">
      <div className="introBg" />
      <div className={started ? "introFrame introFrameOn" : "introFrame"} />

      <div className="introCenter">
        <div className={started ? "introTitle introTitleOn" : "introTitle"}>
          {letters.map((ch, i) => (
            <span
              // eslint-disable-next-line react/no-array-index-key
              key={`${ch}-${i}`}
              className={ch === " " ? "introLetter introLetterSpace" : "introLetter"}
              style={{ "--i": i, "--offset": i - (letters.length - 1) / 2 }}
            >
              {ch === " " ? "\u00A0" : ch}
            </span>
          ))}
        </div>

        {subtitle ? (
          <div className={started ? "introSub introSubOn" : "introSub"}>{subtitle}</div>
        ) : null}

        <div className="introActions">
          {audioBlocked ? (
            <button
              className="introBtn"
              type="button"
              onClick={() => {
                startAudio().catch(() => setAudioBlocked(true));
              }}
            >
              Enable audio
            </button>
          ) : null}

          <button
            className="introBtn introBtnGhost"
            type="button"
            onClick={requestExit}
            disabled={!canSkip || exiting}
            aria-disabled={!canSkip || exiting}
            title={!canSkip ? "Intro must display briefly before skipping." : ""}
          >
            {canSkip ? "Skip" : `Skip in ${skipCountdown || 1}s`}
          </button>
        </div>

        <div className="introHint">Tip: press Esc to skip.</div>
      </div>
    </div>
  );
}
