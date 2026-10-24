export type OneEyeMood = "idle" | "attentive" | "thinking" | "pleased" | "cozy" | "angry" | "surprised" | "curious";

export function OneEye({
  mood = "idle",
  size = "md",
  decorative = false,
  className = ""
}: {
  mood?: OneEyeMood;
  size?: "xs" | "sm" | "md" | "lg" | "hero";
  decorative?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`one-eye one-eye-${size} mood-${mood} ${className}`.trim()}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "ONE 猫眼标志"}
      aria-hidden={decorative || undefined}
    >
      <span className="one-eye-white"><span className="one-eye-pupil" /></span>
      <span className="one-eye-lid one-eye-lid-top" />
      <span className="one-eye-lid one-eye-lid-bottom" />
    </span>
  );
}
