/** ONE's gaze is expressed in SVG units, independent of the displayed logo size. */
export function companionGaze(dx: number, dy: number, radius = 460) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || radius <= 0) return { x: 0, y: 0, nearby: false };
  const distance = Math.hypot(dx, dy);
  if (distance >= radius) return { x: 0, y: 0, nearby: false };
  // Ease attention away at the edge, so crossing the tracking boundary never snaps.
  const falloff = 1 - smoothStep(Math.max(0, (distance / radius - .65) / .35));
  return {
    x: Math.tanh(dx / 150) * 7.5 * falloff,
    y: Math.tanh(dy / 180) * 3.2 * falloff,
    nearby: true
  };
}

function smoothStep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** Exact critically damped spring: smooth following without elastic overshoot. */
export function advanceEyeSpring(position: number, velocity: number, target: number, seconds: number, frequency = 18) {
  const dt = Math.max(0, Math.min(seconds, .064));
  const offset = position - target;
  const impulse = velocity + frequency * offset;
  const decay = Math.exp(-frequency * dt);
  return {
    position: target + (offset + impulse * dt) * decay,
    velocity: (velocity - frequency * impulse * dt) * decay
  };
}

export function companionBlink(elapsed: number, gentle: boolean) {
  const close = gentle ? 180 : 85;
  const hold = gentle ? 90 : 25;
  const open = gentle ? 460 : 155;
  if (elapsed < close) return 1 - .985 * smoothStep(elapsed / close);
  if (elapsed < close + hold) return .015;
  if (elapsed < close + hold + open) return .015 + .985 * smoothStep((elapsed - close - hold) / open);
  return 1;
}

/** The aperture closes around an unchanged pupil, like two real eyelids. */
export function companionAperture(openness: number, friendliness = 0) {
  const open = Math.max(.015, Math.min(1.05, openness));
  const top = 50 - 37 * open;
  const bottom = 50 + (37 - friendliness * 5) * open;
  const upperHandle = 50 - 21 * open;
  const lowerHandle = 50 + (21 - friendliness * 2) * open;
  return `M12 50C12 ${upperHandle} 29 ${top} 50 ${top}C71 ${top} 88 ${upperHandle} 88 50C88 ${lowerHandle} 71 ${bottom} 50 ${bottom}C29 ${bottom} 12 ${lowerHandle} 12 50Z`;
}
