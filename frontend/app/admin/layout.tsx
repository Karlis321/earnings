import Link from "next/link";

const NAV = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/securities/new", label: "Add security" },
  { href: "/admin/sources", label: "Custom sources" },
  { href: "/admin/feedback", label: "Feedback & signals" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto grid max-w-[1800px] grid-cols-[220px_1fr] gap-8 px-10 py-8">
      <nav className="flex flex-col gap-1" aria-label="Admin navigation">
        <div className="mono-eyebrow mb-2">Admin</div>
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className="rounded-button px-3 py-[7px] text-[13px] text-tx2 hover:bg-hover hover:text-tx"
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <div>{children}</div>
    </div>
  );
}
