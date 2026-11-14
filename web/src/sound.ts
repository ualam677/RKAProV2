// Duel sounds, made in the browser (Web Audio): short and quiet, nothing to download and nothing borrowed. On by default;
// the mute choice is remembered.
const KEY = "rka.muted";
let muted = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<(muted: boolean) => void>();
let audio: AudioContext | null = null;
let master: GainNode | null = null;

export const isMuted = () => muted;
export function setMuted(next: boolean) {
  muted = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // just not remembered
  }
  listeners.forEach((listener) => listener(next));
}
export const onMuted = (listener: (muted: boolean) => void) => (listeners.add(listener), () => listeners.delete(listener));

function context(): AudioContext | null {
  if (muted || typeof window === "undefined") return null;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    if (!master) {
      master = audio.createGain();
      master.gain.value = 0.16;
      master.connect(audio.destination);
    }
    return audio;
  } catch {
    return null;
  }
}

// one note: a waveform gliding from one pitch to another, with a quick attack and a soft tail
function tone(ctx: AudioContext, { type = "sine", from, to = from, at = 0, length, volume = 1 }: { type?: OscillatorType; from: number; to?: number; at?: number; length: number; volume?: number }) {
  const start = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + length);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(master!);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

// a short burst of filtered noise: card swishes and impacts
function swish(ctx: AudioContext, { at = 0, length = 0.12, from = 1800, to = 600, volume = 0.5 }: { at?: number; length?: number; from?: number; to?: number; volume?: number }) {
  const start = ctx.currentTime + at;
  const frames = Math.floor(ctx.sampleRate * length);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(from, start);
  filter.frequency.exponentialRampToValueAtTime(to, start + length);
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(filter).connect(gain).connect(master!);
  source.start(start);
}

export type Sound = "draw" | "summon" | "activate" | "resolve" | "negate" | "phase" | "attack" | "pick";

/** Plays one of the duel's sounds (nothing when muted). */
export function play(sound: Sound) {
  const ctx = context();
  if (!ctx) return;
  switch (sound) {
    case "draw":
      swish(ctx, { length: 0.09, from: 2600, to: 1200, volume: 0.35 });
      break;
    case "pick":
      tone(ctx, { type: "triangle", from: 1320, length: 0.05, volume: 0.25 });
      break;
    case "summon":
      // a low landing and a short shimmer
      tone(ctx, { type: "sine", from: 140, to: 70, length: 0.22, volume: 0.9 });
      swish(ctx, { length: 0.14, from: 900, to: 300, volume: 0.35 });
      tone(ctx, { type: "triangle", from: 880, to: 1320, at: 0.05, length: 0.18, volume: 0.18 });
      break;
    case "activate":
      // two bright notes, rising
      tone(ctx, { type: "triangle", from: 988, length: 0.12, volume: 0.35 });
      tone(ctx, { type: "triangle", from: 1480, at: 0.07, length: 0.2, volume: 0.3 });
      break;
    case "resolve":
      tone(ctx, { type: "sine", from: 660, to: 880, length: 0.14, volume: 0.25 });
      break;
    case "negate":
      // a dull downward buzz
      tone(ctx, { type: "sawtooth", from: 320, to: 110, length: 0.28, volume: 0.22 });
      tone(ctx, { type: "square", from: 160, to: 80, length: 0.24, volume: 0.08 });
      break;
    case "phase":
      swish(ctx, { length: 0.22, from: 500, to: 2200, volume: 0.25 });
      tone(ctx, { type: "sine", from: 523, at: 0.08, length: 0.2, volume: 0.18 });
      break;
    case "attack":
      swish(ctx, { length: 0.18, from: 600, to: 3000, volume: 0.45 });
      tone(ctx, { type: "sine", from: 110, to: 55, at: 0.12, length: 0.2, volume: 0.6 });
      break;
  }
}
