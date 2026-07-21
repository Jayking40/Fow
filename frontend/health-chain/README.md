# Health Chain Frontend

A transparent, community-powered platform built on Stellar that connects people who need blood with donors who care. This repository contains the frontend implementation using Next.js, TypeScript, and Tailwind CSS.

## Features

### Public Interface
- Responsive Landing Page
- Engaging introduction with custom assets and typography.
- Showcased sections for organizational goals and partners.
- Interactive Step

### Admin Dashboard
- Real-time stats for Blood Units, Pending Requests, and Active Riders.
- Priority-based table view for emergency blood needs.
- Visual timeline tracking donor registrations and delivery completions.
- Interactive map interface to monitor blood deliveries in real-time with status indicators (Enroute, Picking Up, etc.).
- Responsive Sidebar

## Tech Stack

- **Framework:** [Next.js 15+](https://nextjs.org/)
- **Language:** [TypeScript](https://www.typescriptlang.org/)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/)
- **Icons:** [Lucide React](https://lucide.dev/)
- **Utilities:** `clsx`, `tailwind-merge` (for dynamic class handling)
- **Font:** Google Fonts (Roboto, Manrope, Poppins, DM Sans)

## Getting Started

### Prerequisites
Ensure you have Node.js installed on your machine.

### Installation

1. Navigate to the frontend directory:
```Bash
   cd frontend/health-chain
```
2. Install dependencies:
```Bash
npm install
```
3. Run the development server:
```Bash
npm run dev
```
4. Open http://localhost:3000 to view the Landing Page.
5. Navigate to http://localhost:3000/dashboard to view the Admin Interface.

---

## Offline Model

Riders and field staff operate in areas with unreliable connectivity. The app implements an **offline-first mutation queue** to ensure critical writes are never lost.

### How it works

1. **Offline detection** — `OfflineBanner` (`components/ui/OfflineBanner.tsx`) listens to `navigator.onLine` and the `online`/`offline` window events. A visible banner with `aria-live="polite"` notifies all users (including screen-reader users) when connectivity is lost.

2. **Outbox queue** (`lib/offlineQueue.ts`) — When a mutation (custody scan, delivery status update) is made offline, it is persisted to **IndexedDB** via `enqueue()`. Each item carries: `endpoint`, `method`, `body`, `timestamp`, and `status` (`pending | syncing | synced | failed`).

3. **Replay on reconnect** — `registerReplayOnReconnect()` wires `replayQueue()` to the `window.online` event. Mutations are replayed **in timestamp order** (FIFO). On a `409 Conflict` the server timestamp wins and the item is marked `failed` with `error: 'Conflict: needs review'` so staff can inspect it.

4. **Conflict handling** — Server timestamp wins. Rejected replays surface a `needs review` state visible in the sync-status UI.

5. **PWA baseline** — `public/manifest.json` enables installability. `theme-color` and `manifest` meta tags are set in `app/layout.tsx`.

### Caching strategy (planned service worker)

| Resource | Strategy |
|---|---|
| App shell (JS/CSS) | Precache (cache-first) |
| API GETs | Stale-while-revalidate |
| Map tiles | Cache with 50 MB size cap |
| Locale files | Cache-first |
| Auth endpoints | Network-only (never cached) |

---

## Accessibility (WCAG 2.1 AA)

- **Skip link** — First interactive element in `app/layout.tsx`; targets `#main-content`.
- **Landmark structure** — `<main id="main-content">`, `<aside aria-label="Main navigation">`, `<nav aria-label="Sidebar">` in dashboard layout.
- **Focus-visible policy** — All interactive elements use `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600`.
- **Icon buttons** — All lucide icon-only buttons carry `aria-label`; icons have `aria-hidden="true"`.
- **Toast / live regions** — `role="alert"` + `aria-live` on Toast; errors use `assertive`, others use `polite`.
- **Chart alternatives** — Recharts charts wrapped in `role="img"` with `aria-label` summary; collapsible data table fallback.
- **jsx-a11y** — All rules enforced as `error` in `eslint.config.mjs`.
- **Axe regression guard** — `jest-axe` wired into `vitest.setup.ts`; use `assertNoA11yViolations()` from `lib/testA11y.ts` in component tests.

---

## Auth & Security

- **Middleware** (`middleware.ts`) — `/dashboard` and `/admin/*` are protected. Admin routes additionally require `role === 'admin'`; non-admins are redirected to `/403`.
- **Session token** — Middleware prefers an `httpOnly` `session-token` JWT cookie (set by the backend). The Zustand `auth-storage` cookie is a fallback for basic `/dashboard` routing only and is **not trusted** for admin gating.
- **returnTo flow** — Unauthenticated deep links redirect to `/auth/signin?returnTo=<path>`; after login the user is returned to the original page.
- **Token refresh** — Single-flight refresh in `lib/api/http-client.ts`; concurrent 401s queue behind the refresh and retry once. Refresh failure triggers `hardLogout()`.
- **Cross-tab logout** — `BroadcastChannel('auth')` propagates logout to all open tabs. Call `initCrossTabLogout()` once at app startup.
- **Idle timeout** — Configurable; recommended for admin roles (wire to `useIdleTimer` or similar).