// One clock for everything drawn in the sky. Evolution runs at millions of
// years per second, far too fast to draw: a million years is 365 million
// days, so every frame would skip millions of sunrises and the sun and
// clouds would strobe. Instead the sky shows a time-lapse of sample days
// from the current era, and the sun, clouds and storms all advance on that
// same day clock, so clouds drift as far in a day as real winds carry them.

// Seconds of screen time per simulated day by default.
export const DEFAULT_SECONDS_PER_DAY = 12;
// Typical wind speed carrying the cloud field (m/s) and Earth's radius: the
// cloud field turns at Earth's angular rate whatever the planet's size.
const WIND = 10, EARTH_RADIUS = 6.371e6;
// The cloud renderer's spin speed is tuned in turns per second of its clock.
const CLOUD_DEFAULT_SPIN = 0.00065;
const WIND_TURNS_PER_SECOND = WIND / (2 * Math.PI * EARTH_RADIUS);

export function skyClock({ running = true, myrPerSecond = 1, secondsPerDay = DEFAULT_SECONDS_PER_DAY } = {}) {
  const perDay = Math.max(1, secondsPerDay);
  // Paused evolution leaves the sky in real time: one second per second.
  const simSecondsPerSecond = running ? 86400 / perDay : 1;
  const daysPerSecond = simSecondsPerSecond / 86400;
  // Years of evolution that pass during each day drawn.
  const yearsPerDayShown = running ? 1e6 * myrPerSecond / daysPerSecond : 0;
  return {
    simSecondsPerSecond,
    daysPerSecond,
    sunDegreesPerSecond: 360 * daysPerSecond,
    // Multiplier on the cloud renderer's clock so the default spin matches real winds.
    cloudTimeScale: simSecondsPerSecond * WIND_TURNS_PER_SECOND / CLOUD_DEFAULT_SPIN,
    yearsPerDayShown,
  };
}

export function describeSkyClock(clock, running = true) {
  if (!running) return 'Evolution paused: the sky runs in real time.';
  const day = 1 / clock.daysPerSecond;
  const years = clock.yearsPerDayShown;
  const span = years >= 1e9 ? `${+(years / 1e9).toFixed(2)} billion` : `${+(years / 1e6).toFixed(1)} million`;
  return `Sky time-lapse: one day every ${+day.toFixed(1)} s, with clouds and storms moving at real wind speeds for that day. Each day shown spans ${span} years of evolution, so it is a sample of the era's weather, not every day.`;
}
