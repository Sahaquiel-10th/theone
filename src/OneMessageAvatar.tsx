/** The project mark as a quiet message author. It has no mood or interaction. */
export function OneMessageAvatar({ decorative = true, className = '' }: {
  decorative?: boolean;
  className?: string;
}) {
  return <img
    className={`one-message-avatar ${className}`.trim()}
    src="/one-mark.svg"
    alt={decorative ? '' : 'ONE'}
    aria-hidden={decorative || undefined}
    width={44}
    height={44}
    draggable={false}
    decoding="async"
  />;
}
