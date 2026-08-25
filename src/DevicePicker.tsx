import type { DeviceId } from "./devices.ts";
import { DEVICES, KIOSKS, kioskOf, toggleDevice } from "./devices.ts";
import { useDialog } from "./dialog.ts";
import { badgeClass } from "./look.ts";
import type { Tone } from "./look.ts";

/** Not a kiosk, but the two states the dropdown has to be able to *show* alongside them. */
const EVERY = "all";
const CUSTOM = "custom";

/**
 * Which peripherals the rail carries.
 *
 * A bench is one kiosk at a time, and `hardware-libs` has drivers for more devices than any single
 * unit fits — so the rail lists what you are actually standing in front of rather than the whole
 * catalogue. Shown unprompted on a first landing, because a rail carrying every driver in
 * `hardware-libs` is a worse first impression than one question.
 *
 * Every tick applies immediately to the rail behind this sheet. There is no OK and no Cancel: a
 * commit step would mean this panel and the rail could disagree for as long as it stayed open, and
 * the whole point is to see what you are choosing. Closing it — the button, ✕, Escape or the
 * scrim — does nothing but close it.
 */
export function DevicePicker(
  { selected, firstRun, onSelect, onClose, toast }: {
    selected: DeviceId[];
    /** Nobody has chosen yet, so this opened by itself and its copy has to say why. */
    firstRun: boolean;
    onSelect: (ids: DeviceId[]) => void;
    onClose: () => void;
    toast: (text: string, tone?: Tone) => void;
  },
) {
  const panel = useDialog<HTMLDivElement>();
  const kiosk = kioskOf(selected);
  const preset = kiosk ? kiosk.id : selected.length === DEVICES.length ? EVERY : CUSTOM;

  const choosePreset = (value: string) => {
    if (value === EVERY) return onSelect(DEVICES.map((entry) => entry.id));
    const model = KIOSKS.find((each) => each.id === value);
    // Thrown rather than ignored, the way `deviceEntry` throws: every option below is rendered from
    // `KIOSKS` or one of the two constants above, so a value that matches none of them is this file
    // disagreeing with itself — and silently doing nothing is the hardest version of that to find.
    if (!model) throw new Error(`no such kiosk preset: ${value}`);
    // Copied: the preset's own array would otherwise become React state, where a later edit to that
    // state would be an edit to the catalogue.
    onSelect([...model.devices]);
  };

  const toggle = (id: DeviceId) => {
    const next = toggleDevice(selected, id);
    // Refused by identity: the rail has no screen for having nothing on it. Said out loud rather
    // than by a disabled box, which in a scrolling list has nowhere to put its reason.
    if (next === selected) {
      toast("At least one device must stay on the rail", "warn");
      return;
    }
    onSelect(next);
  };

  return (
    <div className="popover-layer">
      <button className="popover-scrim" onClick={onClose} aria-label="Close the device picker" />
      <div
        className="popover popover--centred popover--tall"
        role="dialog"
        aria-modal="true"
        aria-label="Devices on the rail"
        ref={panel}
      >
        <div className="card-head">
          <span className="tab" />
          <h2>Devices on the rail</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close the device picker">✕</button>
        </div>

        <p className="masknote">
          {firstRun
            ? "Which kiosk is this bench testing? Pick the model in front of you and its devices are ticked " +
              "for you, or build your own set below."
            : "Every device hardware-libs drives is listed, whether or not this tester has a screen for it " +
              "yet, along with the one still waiting on hardware. The rail carries the ticked ones."}
        </p>

        <div className="setting">
          <span className="setting-label">Kiosk</span>
          <select
            className="select"
            value={preset}
            onChange={(event) => choosePreset(event.target.value)}
            aria-label="Kiosk model"
          >
            {KIOSKS.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            <option value={EVERY}>Every device</option>
            {/*
              * Disabled, and still the value the control displays. Custom is a state you arrive at
              * by ticking boxes, not one there is anything to *choose* — offering it as a live
              * option would mean a press that does nothing.
              */}
            <option value={CUSTOM} disabled>Custom</option>
          </select>
          <span className="chip">{selected.length} of {DEVICES.length}</span>
        </div>

        {/*
          * What this kiosk has that nothing here can open. Without it, a preset that ticks fewer
          * boxes than the unit in front of you has devices reads as a bug rather than as the
          * honest state of the driver catalogue.
          */}
        {kiosk?.without && <p className="masknote">{kiosk.without}</p>}

        <div className="choose">
          {DEVICES.map((entry) => (
            <label className="choose-row" key={entry.id}>
              <input
                type="checkbox"
                className="choose-box"
                checked={selected.includes(entry.id)}
                onChange={() => toggle(entry.id)}
              />
              <span className="choose-text">
                <span className="choose-name">{entry.name}</span>
                <span className="choose-model">{entry.model} · {entry.bus}</span>
              </span>
              <span className={badgeClass(entry.ready ? "ok" : "neutral")}>{entry.ready ? "Screen" : "Planned"}</span>
            </label>
          ))}
        </div>

        <div className="choose-foot">
          <span className="choose-note">
            {firstRun ? "Changeable any time from the settings gear." : "Kept per machine, like the theme."}
          </span>
          <button className="button button--primary" onClick={onClose}>{firstRun ? "Start testing" : "Done"}</button>
        </div>
      </div>
    </div>
  );
}
