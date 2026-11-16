// The Settings screen: sound and animation speed for duels, keyword colours, the ban list, this device's data
import { useEffect, useState } from "react";
import { isMuted, onMuted, setMuted } from "./sound";
import { setSetting, useSettings, type Banlist, type Speed } from "./settings";

// a row of choices, one lit
function Choice<T extends string | boolean>({ value, options, onPick, label }: { value: T; options: { value: T; text: string }[]; onPick: (value: T) => void; label: string }) {
  return (
    <div className="choice" role="radiogroup" aria-label={label}>
      {options.map((one) => (
        <button key={String(one.value)} role="radio" aria-checked={one.value === value} className={`choice-option ${one.value === value ? "on" : ""}`} onClick={() => onPick(one.value)}>
          {one.text}
        </button>
      ))}
    </div>
  );
}

function Row({ name, hint, children }: { name: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <span className="settings-name">
        <b>{name}</b>
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </div>
  );
}

interface Props {
  banlistName: string;
  deckName?: string;
  canInstall: boolean;
  onInstall: () => void;
  onBanlist: (file: Banlist) => void;
  onClearDeck?: () => void;
  onResetAll: () => void;
  onBack: () => void;
}

export function SettingsScreen({ banlistName, deckName, canInstall, onInstall, onBanlist, onClearDeck, onResetAll, onBack }: Props) {
  const settings = useSettings();
  const [muted, setMutedState] = useState(isMuted());
  useEffect(() => {
    const off = onMuted(setMutedState);
    return () => void off();
  }, []);
  return (
    <>
      <div className="screen-head">
        <button className="icon-button" onClick={onBack} aria-label="Menu">
          ‹
        </button>
        <h2>Settings</h2>
      </div>
      <div className="settings">
        <section className="settings-group">
          <p className="section-label">Duel</p>
          <Row name="Sound">
            <Choice label="Sound" value={!muted} options={[{ value: true, text: "On" }, { value: false, text: "Off" }]} onPick={(on) => setMuted(!on)} />
          </Row>
          <Row name="Animation speed" hint="How long each activation and summon stays on screen">
            <Choice<Speed>
              label="Animation speed"
              value={settings.speed}
              options={[
                { value: "normal", text: "Normal" },
                { value: "fast", text: "Fast" },
                { value: "instant", text: "Instant" },
              ]}
              onPick={(speed) => setSetting("speed", speed)}
            />
          </Row>
          <Row name="Keyword colours" hint="Game words picked out in effect text">
            <Choice label="Keyword colours" value={settings.keywords} options={[{ value: true, text: "On" }, { value: false, text: "Off" }]} onPick={(on) => setSetting("keywords", on)} />
          </Row>
        </section>

        <section className="settings-group">
          <p className="section-label">Cards</p>
          <Row name="Ban list" hint={banlistName ? `Decks checked against ${banlistName}` : "Loading…"}>
            <Choice<Banlist>
              label="Ban list"
              value={settings.banlist}
              options={[
                { value: "0TCG", text: "TCG" },
                { value: "OCG", text: "OCG" },
              ]}
              onPick={(file) => (setSetting("banlist", file), onBanlist(file))}
            />
          </Row>
        </section>

        <section className="settings-group">
          <p className="section-label">Data on this device</p>
          {onClearDeck && (
            <Row name={`Clear "${deckName}"`} hint="Its replays, working lines and results. The deck stays.">
              <button className="button small danger" onClick={onClearDeck}>
                Clear
              </button>
            </Row>
          )}
          <Row name="Reset everything" hint="Every deck, replay and setting. Back up in Sync first.">
            <button className="button small danger" onClick={onResetAll}>
              Reset
            </button>
          </Row>
        </section>

        {canInstall && (
          <button className="button settings-install" onClick={onInstall}>
            Install RKAPro as an app (works offline)
          </button>
        )}
        <p className="settings-version">RKAPro {__APP_VERSION__}</p>
      </div>
    </>
  );
}
