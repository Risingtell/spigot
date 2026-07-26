/**
 * The Spigot mark: one droplet, the same shape used in the project image and the
 * favicon. Inline SVG so it scales to any band without a network request.
 */

export function SpigotMark({
  className,
  tone = "amber",
  style,
}: {
  className?: string;
  tone?: "amber" | "black" | "white";
  style?: React.CSSProperties;
}) {
  const fill = tone === "black" ? "#000000" : tone === "white" ? "#ffffff" : "#f9ab24";
  return (
    <svg className={className} style={style} viewBox="0 0 64 64" role="img" aria-label="Spigot" fill="none">
      <path
        d="M32 4C32 4 12 30.5 12 42a20 20 0 0 0 40 0C52 30.5 32 4 32 4Z"
        fill={fill}
      />
    </svg>
  );
}
