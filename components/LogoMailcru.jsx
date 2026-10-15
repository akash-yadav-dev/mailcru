import { cn } from "@/lib/utils";

// An envelope in two facets: the flap and the body under it. The share images draw the same shapes, so they import these.
export const LOGO_VIEWBOX = "11 9 45 45";
export const LOGO_FACETS = { upper: "M13 18H54L33.5 34.5Z", lower: "M13 18 33.5 34.5 54 18V45H13Z" };
export const LOGO_SHADE = 0.35;

export default function LogoMailcru({ className }) {
	return (
		<svg viewBox={LOGO_VIEWBOX} aria-hidden="true" className={cn("size-6 shrink-0 text-foreground", className)}>
			<path d={LOGO_FACETS.upper} fill="currentColor" />
			<path d={LOGO_FACETS.lower} fill="currentColor" fillOpacity={LOGO_SHADE} />
		</svg>
	);
}
