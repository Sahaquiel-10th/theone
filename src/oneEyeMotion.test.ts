import assert from "node:assert/strict";
import test from "node:test";
import { advanceEyeSpring, companionAperture, companionBlink, companionGaze } from "./oneEyeMotion";

test("companion gaze is bounded and releases gradually at its outer edge", () => {
  assert.deepEqual(companionGaze(0, 0), { x: 0, y: 0, nearby: true });
  for (let x = -700; x <= 700; x += 25) {
    for (let y = -700; y <= 700; y += 25) {
      const gaze = companionGaze(x, y);
      assert.ok(Math.abs(gaze.x) <= 7.5);
      assert.ok(Math.abs(gaze.y) <= 3.2);
    }
  }
  assert.ok(Math.abs(companionGaze(459, 0).x) < .002);
  assert.deepEqual(companionGaze(461, 0), { x: 0, y: 0, nearby: false });
  assert.deepEqual(companionGaze(NaN, 0), { x: 0, y: 0, nearby: false });
});

test("critically damped pupil settles without springy overshoot", () => {
  let axis = { position: 0, velocity: 0 };
  for (let frame = 0; frame < 100; frame += 1) {
    axis = advanceEyeSpring(axis.position, axis.velocity, 7, 1 / 60);
    assert.ok(axis.position >= 0 && axis.position <= 7);
  }
  assert.ok(Math.abs(axis.position - 7) < .001);
  axis = advanceEyeSpring(axis.position, axis.velocity, 0, 1 / 60);
  assert.ok(axis.position > 6 && axis.position < 7, "return starts smoothly, not an instant reset");
});

test("natural and affectionate blinks return fully open", () => {
  assert.equal(companionBlink(0, false), 1);
  assert.equal(companionBlink(95, false), .015);
  assert.equal(companionBlink(265, false), 1);
  assert.equal(companionBlink(225, true), .015);
  assert.ok(companionBlink(400, true) < 1);
  assert.equal(companionBlink(730, true), 1);
});

test("friendly eyelid response eases in and out rather than switching shape", () => {
  let warmth = advanceEyeSpring(0, 0, 1, 1 / 60, 13);
  assert.ok(warmth.position > 0 && warmth.position < .03, "first hover frame stays close to resting shape");
  for (let frame = 0; frame < 90; frame += 1) {
    warmth = advanceEyeSpring(warmth.position, warmth.velocity, 1, 1 / 60, 13);
    assert.ok(warmth.position >= 0 && warmth.position <= 1);
  }
  assert.ok(warmth.position > .999);
  warmth = advanceEyeSpring(warmth.position, warmth.velocity, 0, 1 / 60, 13);
  assert.ok(warmth.position > .97, "pointer exit also eases away without a jump");
});

test("aperture stays rounded and finite at every blink position", () => {
  for (let opening = 0; opening < 1.1; opening += .01) {
    const aperture = companionAperture(opening, 1);
    assert.ok(aperture.startsWith("M12 50C12"));
    assert.equal((aperture.match(/C/g) || []).length, 4);
    assert.ok(aperture.endsWith("12 50Z"));
    assert.ok(!aperture.includes("NaN"));
  }
  assert.ok(companionAperture(1).includes("50 13"), "resting eye is near circular, not a slit");
});
