// The Settings screen's choices, remembered on this device. Sound has its own store (sound.ts).
import { useEffect, useState } from "react";

export type Speed = "normal" | "fast" | "instant";
export type Banlist = "0TCG" | "OCG";
interface Settings {
  // how long each duel moment (an activation, a summon) stays on screen
  speed: Speed;
  // game words coloured in effect text
  keywords: boolean;
  // which list deck legality and card limits follow (a file in ProjectIgnis' LFLists)
  banlist: Banlist;
}
const DEFAULTS: Settings = { speed: "normal", keywords: true, banlist: "0TCG" };
const KEY = "rka.settings";

let current: Settings = (() => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
})();
const listeners = new Set<(settings: Settings) => void>();

export const getSettings = () => current;
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // just not remembered
  }
  apply();
  listeners.forEach((listener) => listener(current));
}
export function useSettings(): Settings {
  const [settings, setSettings] = useState(current);
  useEffect(() => {
    listeners.add(setSettings);
    return () => void listeners.delete(setSettings);
  }, []);
  return settings;
}

// how much of each moment's time is kept: all of it, a little over half, or none
export const SPEED_SCALE: Record<Speed, number> = { normal: 1, fast: 0.55, instant: 0 };
export const speedScale = () => SPEED_SCALE[current.speed];

// what shows on the page itself: keyword colours on or off
function apply() {
  if (typeof document !== "undefined") document.documentElement.classList.toggle("plain-keywords", !current.keywords);
}
apply();
