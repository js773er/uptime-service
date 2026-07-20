"use client";

import { SignInButton, UserButton, useUser } from "@clerk/nextjs";
import Link from "next/link";

/**
 * Client-side auth state for the header. Deliberately NOT `auth()` in the
 * server layout: that would force every route dynamic and break caching of
 * the public status pages.
 */
export function NavAuth() {
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) {
    return <div className="h-8 w-20" aria-hidden />;
  }

  if (isSignedIn) {
    return (
      <>
        <Link href="/dashboard" className="hover:underline">
          Dashboard
        </Link>
        <UserButton />
      </>
    );
  }

  return (
    <SignInButton mode="modal">
      <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-white hover:bg-zinc-700">
        Sign in
      </button>
    </SignInButton>
  );
}
