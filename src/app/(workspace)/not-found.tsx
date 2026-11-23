import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">404</p>
      <h1 className="mt-1 text-[20px] font-semibold">Page or record not found</h1>
      <p className="mt-2 text-[13px] text-ink-2">The address may be mistyped, or the record does not exist or is not available to you.</p>
      <Link href="/" className="mt-4 inline-block text-[13px] font-medium text-accent-ink hover:underline">
        Back to overview
      </Link>
    </div>
  );
}
