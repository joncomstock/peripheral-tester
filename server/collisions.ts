/**
 * Which indicator channels are addressed by more than one section.
 *
 * The known case is `payment` = 1 and semaphore green = 1: the driver ships both because
 * `payment` was never confirmed on hardware, so pressing `payment` may light the semaphore instead.
 * That fact is written down in the driver's `defaults.ts`, and a written-down fact stops being true
 * the moment someone passes a `config` — which is the whole point of this tool. So it is computed
 * from the live channel map instead, and a collision nobody has documented shows up the same way
 * the documented one does.
 *
 * Indicators, bag-tag sides and semaphore lamps share the `AI` address space. The strip is `AL`,
 * a different space, so strip green = 4 and `boardingPassPrinter` = 4 are not a collision.
 *
 * The parameter is structural rather than the driver's `LightboardConfig` so this module — and its
 * test — depend on nothing. `LightboardConfig` satisfies it.
 */
export interface AiChannels {
  readonly indicators: Readonly<Record<string, number>>;
  readonly bagTag: Readonly<Record<string, number>>;
  readonly semaphore: Readonly<Record<string, readonly number[]>>;
}

/**
 * One section addressing a channel.
 *
 * `id` is the claimant's identity in the driver's own vocabulary — `kind:name`, where the name is
 * whatever discriminates that kind (a section, a bag-tag side, a semaphore colour). It exists
 * because the UI has to get from "who else is on this pin" back to the row for that section, and
 * doing it by matching `label` meant two layers had to agree on formatting forever. They did not:
 * `semaphore green` never matched the row it named, so the marker for the shipped default collision
 * navigated nowhere.
 *
 * `label` is for reading. Never match on it.
 */
export interface Claimant {
  readonly id: string;
  readonly label: string;
}

export interface Collision {
  readonly channel: number;
  /** Every section sharing the channel, in the order the map declares them. */
  readonly claimants: readonly Claimant[];
}

export function aiCollisions(channels: AiChannels): Collision[] {
  const byChannel = new Map<number, Claimant[]>();
  const add = (channel: number, claimant: Claimant) => {
    const claimants = byChannel.get(channel);
    if (claimants) claimants.push(claimant);
    else byChannel.set(channel, [claimant]);
  };

  for (const [section, channel] of Object.entries(channels.indicators)) {
    add(channel, { id: `indicator:${section}`, label: section });
  }
  for (const [side, channel] of Object.entries(channels.bagTag)) {
    add(channel, { id: `bagTag:${side}`, label: `bag-tag ${side}` });
  }
  for (const [color, lamps] of Object.entries(channels.semaphore)) {
    // Semaphore yellow is red and green lit together, so it necessarily reuses both their channels.
    // Reporting that as a collision would bury the real ones in noise it can do nothing about.
    if (lamps.length > 1) continue;
    for (const channel of lamps) add(channel, { id: `semaphore:${color}`, label: `semaphore ${color}` });
  }

  return [...byChannel]
    .filter(([, claimants]) => claimants.length > 1)
    .map(([channel, claimants]) => ({ channel, claimants }))
    .sort((a, b) => a.channel - b.channel);
}
