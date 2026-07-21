import Link from 'next/link';

export const metadata = { title: '403 Forbidden | Health Chain' };

export default function ForbiddenPage() {
  return (
    <main id="main-content" className="min-h-screen flex flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-4xl font-bold text-brand-black">403 — Forbidden</h1>
      <p className="text-gray-600 max-w-md">
        You do not have permission to access this page. Admin access is required.
      </p>
      <Link
        href="/dashboard"
        className="mt-4 px-6 py-2 bg-[#D32F2F] text-white rounded-lg hover:bg-[#B71C1C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 transition-colors"
      >
        Return to Dashboard
      </Link>
    </main>
  );
}
