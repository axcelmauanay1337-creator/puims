import Link from "next/link";

export default function RootNotFound() {
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-center">
      <h1 className="text-[20px] font-semibold">Page not found</h1>
      <Link href="/" className="mt-4 inline-block text-[13px] font-medium text-accent-ink hover:underline">
        Go to PUIMS
      </Link>
    </main>
  );
}
