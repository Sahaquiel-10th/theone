import { useEffect, useId, useRef } from "react";
import { advanceEyeSpring, companionAperture, companionBlink, companionGaze } from "./oneEyeMotion";
import "./one-companion-eye.css";

type CompanionMood = "idle" | "attentive" | "thinking" | "pleased" | "cozy" | "angry" | "surprised" | "curious";
type Axis = { position: number; velocity: number };

const MOOD_OPENNESS: Record<CompanionMood, number> = {
  idle: 1, attentive: 1.025, thinking: .96, pleased: .95,
  cozy: .91, angry: .96, surprised: 1.04, curious: 1.02
};

/** A quiet companion: the shell stays still; attention lives in the pupil and lids. */
export function OneCompanionEye({ mood }: { mood: CompanionMood }) {
  const clipId = `one-companion-${useId().replace(/:/g, "")}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const apertureRef = useRef<SVGPathElement>(null);
  const pupilRef = useRef<SVGGElement>(null);
  const moodRef = useRef(mood);
  const actionsRef = useRef({ greet: () => {}, changeMood: () => {} });
  moodRef.current = mood;

  useEffect(() => {
    const button = buttonRef.current;
    const aperture = apertureRef.current;
    const pupil = pupilRef.current;
    if (!button || !aperture || !pupil) return;

    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointerQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
    const timers = new Set<number>();
    let reduced = reducedQuery.matches;
    let finePointer = pointerQuery.matches;
    let disposed = false;
    let frame = 0;
    let lastTime = 0;
    let nearby = false;
    let hovered = false;
    let keyboardFocused = false;
    let lastPointerAt = -Infinity;
    let gazeTarget = { x: 0, y: 0 };
    let horizontal: Axis = { position: 0, velocity: 0 };
    let vertical: Axis = { position: 0, velocity: 0 };
    let lid: Axis = { position: MOOD_OPENNESS[moodRef.current], velocity: 0 };
    let warmth: Axis = { position: 0, velocity: 0 };
    let blink: { started: number; gentle: boolean } | null = null;
    let reducedGreeting = false;

    function later(callback: () => void, delay: number) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (!disposed) callback();
      }, delay);
      timers.add(timer);
      return timer;
    }

    function render(open = lid.position) {
      const friendliness = reduced ? (hovered || keyboardFocused || reducedGreeting ? 1 : 0) : warmth.position;
      aperture!.setAttribute("d", companionAperture(open, friendliness));
      pupil!.setAttribute("transform", `translate(${horizontal.position.toFixed(3)} ${vertical.position.toFixed(3)})`);
    }

    function wake() {
      if (disposed || document.hidden || reduced || frame) return;
      lastTime = performance.now();
      frame = requestAnimationFrame(animate);
    }

    function animate(now: number) {
      frame = 0;
      if (disposed || document.hidden || reduced) return;
      const seconds = Math.min((now - lastTime) / 1000, .064);
      lastTime = now;
      // A returning glance is a little slower than a new point of interest.
      const frequency = nearby ? 19 : 13;
      horizontal = advanceEyeSpring(horizontal.position, horizontal.velocity, gazeTarget.x, seconds, frequency);
      vertical = advanceEyeSpring(vertical.position, vertical.velocity, gazeTarget.y, seconds, frequency);
      const targetOpen = hovered || keyboardFocused ? Math.max(1, MOOD_OPENNESS[moodRef.current]) : MOOD_OPENNESS[moodRef.current];
      const targetWarmth = hovered || keyboardFocused ? 1 : 0;
      lid = advanceEyeSpring(lid.position, lid.velocity, targetOpen, seconds, 15);
      warmth = advanceEyeSpring(warmth.position, warmth.velocity, targetWarmth, seconds, 13);
      const blinkAmount = blink ? companionBlink(now - blink.started, blink.gentle) : 1;
      if (blink && now - blink.started >= (blink.gentle ? 730 : 265)) {
        blink = null;
        button!.dataset.companionState = nearby ? "watching" : "resting";
      }
      render(lid.position * blinkAmount);
      const moving = Math.abs(horizontal.position - gazeTarget.x) + Math.abs(vertical.position - gazeTarget.y)
        + Math.abs(horizontal.velocity) + Math.abs(vertical.velocity)
        + Math.abs(lid.position - targetOpen) + Math.abs(lid.velocity)
        + Math.abs(warmth.position - targetWarmth) + Math.abs(warmth.velocity) > .015;
      // No perpetual animation loop while ONE is simply resting.
      if (moving || blink) frame = requestAnimationFrame(animate);
    }

    function startBlink(gentle: boolean) {
      if (document.hidden || reduced || (blink && (!gentle || blink.gentle))) return;
      blink = { started: performance.now(), gentle };
      button!.dataset.companionState = gentle ? "greeting" : "blinking";
      wake();
    }

    function scheduleBlink() {
      later(() => {
        startBlink(false);
        scheduleBlink();
      }, 4800 + Math.random() * 3800);
    }

    function scheduleGlance() {
      later(() => {
        if (!document.hidden && !reduced && !hovered && !keyboardFocused && (!nearby || performance.now() - lastPointerAt > 4500) && !blink) {
          const direction = Math.random() > .5 ? 1 : -1;
          gazeTarget = { x: direction * (2.5 + Math.random() * 2), y: (Math.random() - .5) * 2 };
          nearby = false;
          wake();
          // A brief look, a pause to take it in, then attention comes home.
          later(() => {
            if (!nearby && !hovered) {
              gazeTarget = { x: 0, y: 0 };
              wake();
            }
          }, 950 + Math.random() * 750);
        }
        scheduleGlance();
      }, 3400 + Math.random() * 4200);
    }

    function restartAutonomy() {
      timers.forEach(timer => window.clearTimeout(timer));
      timers.clear();
      if (reduced || document.hidden) return;
      scheduleBlink();
      scheduleGlance();
    }

    function followPointer(event: PointerEvent) {
      if (reduced || !finePointer || document.hidden || event.pointerType !== "mouse") return;
      const bounds = button!.getBoundingClientRect();
      const gaze = companionGaze(event.clientX - bounds.left - bounds.width / 2, event.clientY - bounds.top - bounds.height / 2);
      nearby = gaze.nearby;
      lastPointerAt = performance.now();
      gazeTarget = { x: gaze.x, y: gaze.y };
      if (!blink) button!.dataset.companionState = nearby ? "watching" : "resting";
      wake();
    }

    function releaseAttention() {
      nearby = false;
      hovered = false;
      gazeTarget = { x: 0, y: 0 };
      wake();
    }

    function enter(event: PointerEvent) {
      if (event.pointerType !== "mouse" || !finePointer) return;
      hovered = true;
      if (reduced) render(MOOD_OPENNESS[moodRef.current]);
      else wake();
    }

    function leave() {
      hovered = false;
      if (reduced) render(MOOD_OPENNESS[moodRef.current]);
      else wake();
    }

    function focus() {
      // Pointer clicks may leave DOM focus behind; only keyboard focus holds attention.
      keyboardFocused = button!.matches(":focus-visible");
      if (reduced) render(MOOD_OPENNESS[moodRef.current]);
      else wake();
    }

    function blur() {
      keyboardFocused = false;
      if (reduced) render(MOOD_OPENNESS[moodRef.current]);
      else wake();
    }

    function pointerDown() {
      keyboardFocused = false;
      if (reduced) render(MOOD_OPENNESS[moodRef.current]);
      else wake();
    }

    function keyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      keyboardFocused = true;
      if (reduced) render(MOOD_OPENNESS[moodRef.current]);
      else wake();
    }

    function changePreferences() {
      reduced = reducedQuery.matches;
      finePointer = pointerQuery.matches;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      blink = null;
      reducedGreeting = false;
      nearby = false;
      hovered = false;
      gazeTarget = { x: 0, y: 0 };
      horizontal = { position: 0, velocity: 0 };
      vertical = { position: 0, velocity: 0 };
      lid = { position: MOOD_OPENNESS[moodRef.current], velocity: 0 };
      warmth = { position: keyboardFocused ? 1 : 0, velocity: 0 };
      button!.dataset.companionState = "resting";
      render();
      restartAutonomy();
    }

    function visibilityChanged() {
      if (document.hidden) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        blink = null;
        reducedGreeting = false;
        button!.dataset.companionState = "resting";
      } else {
        releaseAttention();
        render(MOOD_OPENNESS[moodRef.current]);
      }
      restartAutonomy();
    }

    actionsRef.current = {
      greet() {
        if (document.hidden) return;
        if (reduced) {
          if (reducedGreeting) return;
          reducedGreeting = true;
          button!.dataset.companionState = "greeting";
          render(.9);
          later(() => {
            reducedGreeting = false;
            button!.dataset.companionState = "resting";
            render(MOOD_OPENNESS[moodRef.current]);
          }, 650);
        } else {
          startBlink(true);
        }
      },
      changeMood() {
        if (reduced) {
          lid = { position: MOOD_OPENNESS[moodRef.current], velocity: 0 };
          render();
        } else wake();
      }
    };

    render();
    restartAutonomy();
    window.addEventListener("pointermove", followPointer, { passive: true });
    document.addEventListener("pointerleave", releaseAttention);
    window.addEventListener("blur", releaseAttention);
    document.addEventListener("visibilitychange", visibilityChanged);
    button.addEventListener("pointerenter", enter);
    button.addEventListener("pointerleave", leave);
    button.addEventListener("pointerdown", pointerDown);
    button.addEventListener("keydown", keyDown);
    button.addEventListener("focus", focus);
    button.addEventListener("blur", blur);
    reducedQuery.addEventListener("change", changePreferences);
    pointerQuery.addEventListener("change", changePreferences);

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      timers.forEach(timer => window.clearTimeout(timer));
      window.removeEventListener("pointermove", followPointer);
      document.removeEventListener("pointerleave", releaseAttention);
      window.removeEventListener("blur", releaseAttention);
      document.removeEventListener("visibilitychange", visibilityChanged);
      button.removeEventListener("pointerenter", enter);
      button.removeEventListener("pointerleave", leave);
      button.removeEventListener("pointerdown", pointerDown);
      button.removeEventListener("keydown", keyDown);
      button.removeEventListener("focus", focus);
      button.removeEventListener("blur", blur);
      reducedQuery.removeEventListener("change", changePreferences);
      pointerQuery.removeEventListener("change", changePreferences);
      actionsRef.current = { greet() {}, changeMood() {} };
    };
  }, []);

  useEffect(() => actionsRef.current.changeMood(), [mood]);

  return (
    <button
      ref={buttonRef}
      className="one-presence one-companion-eye"
      type="button"
      aria-label="和 ONE 打个招呼"
      data-companion-state="resting"
      onClick={() => actionsRef.current.greet()}
    >
      <svg className="one-hero-eye companion-art" viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <path ref={apertureRef} d={companionAperture(MOOD_OPENNESS[mood])} />
          </clipPath>
        </defs>
        <rect className="companion-shell" x="2" y="2" width="96" height="96" rx="25" />
        <g clipPath={`url(#${clipId})`}>
          <rect className="companion-white" x="10" y="9" width="80" height="82" />
          <g ref={pupilRef}>
            <path className="companion-pupil" d="M53 26C49.3 40.2 47.9 57.7 48.9 75" />
          </g>
        </g>
      </svg>
    </button>
  );
}
