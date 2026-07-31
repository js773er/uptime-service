import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="max-w-xl text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          Know when your site goes down.
        </h1>
        <p className="mt-4 text-zinc-600">
          Checks every minute from Sydney, tracks incidents, and emails you the
          moment something breaks — with a public status page you can share.
        </p>
        <div className="mt-8">
          <Link
            href="/dashboard"
            className="rounded-md bg-zinc-900 px-5 py-2.5 text-white hover:bg-zinc-700"
          >
            Open dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
