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

export interface Collision {
  readonly channel: number;
  /** Every section sharing the channel, e.g. `["payment", "semaphore green"]`. */
  readonly labels: readonly string[];
}

export function aiCollisions(channels: AiChannels): Collision[] {
  const byChannel = new Map<number, string[]>();
  const add = (channel: number, label: string) => {
    const labels = byChannel.get(channel);
    if (labels) labels.push(label);
    else byChannel.set(channel, [label]);
  };

  for (const [section, channel] of Object.entries(channels.indicators)) add(channel, section);
  for (const [side, channel] of Object.entries(channels.bagTag)) add(channel, `bag-tag ${side}`);
  for (const [color, lamps] of Object.entries(channels.semaphore)) {
    // Semaphore yellow is red and green lit together, so it necessarily reuses both their channels.
    // Reporting that as a collision would bury the real ones in noise it can do nothing about.
    if (lamps.length > 1) continue;
    for (const channel of lamps) add(channel, `semaphore ${color}`);
  }

  return [...byChannel]
    .filter(([, labels]) => labels.length > 1)
    .map(([channel, labels]) => ({ channel, labels }))
    .sort((a, b) => a.channel - b.channel);
}
