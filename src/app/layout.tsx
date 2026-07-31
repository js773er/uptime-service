import { ClerkProvider, SignInButton, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Uptime",
  description: "Monitor your sites and get alerted when they go down",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { userId } = await auth();

  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">
          <header className="border-b border-zinc-200 bg-white">
            <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
              <Link href="/" className="font-semibold tracking-tight">
                ⏱ Uptime
              </Link>
              <nav className="flex items-center gap-4 text-sm">
                {userId ? (
                  <>
                    <Link href="/dashboard" className="hover:underline">
                      Dashboard
                    </Link>
                    <UserButton />
                  </>
                ) : (
                  <SignInButton mode="modal">
                    <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-white hover:bg-zinc-700">
                      Sign in
                    </button>
                  </SignInButton>
                )}
              </nav>
            </div>
          </header>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
