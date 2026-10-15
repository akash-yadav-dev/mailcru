import { getAppUrl } from "@/lib/config";

// The dashboard, the admin, the APIs and tracked links. / stays open: on MailCru Cloud, signed-out visitors get
// the landing page there. Archive hosts get their own robots.txt (proxy.js).
const PRIVATE_PATHS = [
	"/account",
	"/admin",
	"/api/",
	"/api-keys",
	"/billing",
	"/campaigns",
	"/contacts",
	"/domains",
	"/mcp",
	"/newsletters",
	"/restore",
	"/c/",
	"/o/",
];

export default function robots() {
	return {
		rules: { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
		sitemap: `${getAppUrl()}/sitemap.xml`,
	};
}
