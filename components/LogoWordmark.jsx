import Link from "next/link";
import LogoMailcru from "@/components/LogoMailcru";
import { cn } from "@/lib/utils";

export default function LogoWordmark({ href, className, children }) {
	const Wordmark = href ? Link : "span";

	return (
		<Wordmark href={href} className={cn("flex items-center gap-2", className)}>
			<LogoMailcru />
			<span className="text-[17px] font-semibold tracking-tight">MailCru</span>
			{children}
		</Wordmark>
	);
}
