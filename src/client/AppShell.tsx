/**
 * The application shell — the skeleton every authenticated screen renders
 * inside.
 *
 * It is route-aware and has two genuinely different layouts either side of the
 * `lg` breakpoint (1024px): a fixed sidebar on desktop, a fixed bottom tab bar
 * on mobile. Not one layout that shrinks — two, because the thumb reaches the
 * bottom of a phone and the cursor reaches the left of a monitor, and pretending
 * otherwise produces a design that serves neither.
 *
 * The design target is a 360px phone, because that is where records are
 * actually entered: standing in a yard, one-handed. Desktop is the enhancement.
 */

import type { ReactNode } from 'react';
import {
  Home as HomeIcon,
  Landmark,
  LogOut,
  Plus,
  ScrollText,
  ShoppingCart,
  Tag,
  UserCircle2,
  Users,
} from 'lucide-react';
import { IconButton } from './ui';

export type NavKey = 'home' | 'purchase' | 'sale' | 'dealers' | 'other';

const NAV: { key: NavKey; label: string; path: string; icon: typeof HomeIcon }[] = [
  { key: 'home', label: 'Home', path: '/', icon: HomeIcon },
  { key: 'purchase', label: 'Purchase', path: '/purchase', icon: ShoppingCart },
  { key: 'sale', label: 'Sale', path: '/sale', icon: Tag },
  { key: 'dealers', label: 'Dealers', path: '/dealers', icon: Users },
];

export function AppShell({
  active,
  title,
  username,
  auditActive,
  accountActive,
  navigate,
  onSignOut,
  children,
}: {
  active: NavKey;
  title: string;
  username: string | null;
  auditActive?: boolean;
  accountActive?: boolean;
  navigate: (path: string) => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:flex">
      <Sidebar active={active} navigate={navigate} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          title={title}
          username={username}
          auditActive={auditActive}
          accountActive={accountActive}
          navigate={navigate}
          onSignOut={onSignOut}
        />

        {/*
          `pb-24` clears the fixed tab bar so the last row of a list is never
          hidden behind it, and `lg:pb-8` drops that padding on desktop where
          no tab bar exists.
        */}
        <main className="flex-1 p-4 pb-24 lg:p-8 lg:pb-8">{children}</main>
      </div>

      <BottomTabs active={active} navigate={navigate} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Sidebar({ active, navigate }: { active: NavKey; navigate: (path: string) => void }) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-outline-variant bg-surface-bright lg:flex">
      <div className="flex items-center gap-3 p-6">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-on-primary"
        >
          <Landmark size={20} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-headline-sm text-primary">ASH Overseas</span>
          <span className="block text-label-caps uppercase text-on-surface-variant">
            Trading ledger
          </span>
        </span>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV.map(({ key, label, path, icon: Icon }) => {
          const isActive = key === active;
          return (
            <button
              key={key}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => navigate(path)}
              // The active state changes THREE things — background, weight and
              // colour — so it is unmistakable rather than merely tinted.
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-body-md transition-colors ${
                isActive
                  ? 'bg-surface-container font-semibold text-primary'
                  : 'font-medium text-on-surface-variant hover:bg-surface-container-low'
              }`}
            >
              <Icon size={20} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="p-3">
        <button
          type="button"
          onClick={() => navigate('/dealers/new')}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90"
        >
          <Plus size={18} aria-hidden="true" />
          New dealer
        </button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

/**
 * Four controls, right-aligned. Each collapses progressively rather than
 * disappearing: the username hides below `sm`, the New button drops to a bare
 * `+`. Nothing becomes unreachable on a narrow screen.
 */
function Header({
  title,
  username,
  auditActive,
  accountActive,
  navigate,
  onSignOut,
}: {
  title: string;
  username: string | null;
  auditActive?: boolean;
  accountActive?: boolean;
  navigate: (path: string) => void;
  onSignOut: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-outline-variant bg-surface-bright px-4 lg:px-8">
      {/* The brand travels with the header on mobile, where there is no rail. */}
      <span className="flex min-w-0 items-center gap-2 lg:hidden">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-on-primary"
        >
          <Landmark size={18} />
        </span>
        {/*
          The wordmark is dropped below `sm`. At 360px it truncated to
          "ASH Ov...", which is worse than no wordmark at all: it costs the
          width the four controls beside it need, and an ellipsed brand looks
          broken rather than compact. The mark carries the identity, and the
          tab bar says which screen you are on.
        */}
        <span className="hidden truncate text-headline-sm text-primary sm:inline">
          ASH Overseas
        </span>
      </span>

      <h1 className="hidden min-w-0 flex-1 truncate text-headline-sm text-on-surface lg:block">
        {title}
      </h1>

      <div className="ml-auto flex items-center gap-2">
        <IconButton label="Audit log" active={auditActive} onClick={() => navigate('/audit')}>
          <ScrollText size={18} />
        </IconButton>

        <button
          type="button"
          onClick={() => navigate('/settings')}
          className={`flex items-center gap-2 rounded-lg px-2 py-2 text-body-md transition-colors ${
            accountActive
              ? 'bg-surface-container text-primary'
              : 'text-on-surface-variant hover:bg-surface-container-low'
          }`}
        >
          <UserCircle2 size={18} aria-hidden="true" />
          <span className="hidden max-w-32 truncate sm:inline">{username ?? 'Account'}</span>
          <span className="sr-only">Account settings</span>
        </button>

        {/* The only hover-to-red in the header, marking the destructive one. */}
        <IconButton label="Sign out" className="hover:text-negative" onClick={onSignOut}>
          <LogOut size={18} />
        </IconButton>

        <button
          type="button"
          onClick={() => navigate('/dealers/new')}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-label-caps font-semibold text-on-primary transition-opacity hover:opacity-90"
        >
          <Plus size={18} aria-hidden="true" />
          <span className="hidden sm:inline">New dealer</span>
          <span className="sr-only sm:hidden">New dealer</span>
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------

function BottomTabs({ active, navigate }: { active: NavKey; navigate: (path: string) => void }) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-outline-variant bg-surface-bright lg:hidden"
      // Clears the iPhone home indicator rather than sitting under it. Paired
      // with `viewport-fit=cover` in index.html; neither works alone.
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {NAV.map(({ key, label, path, icon: Icon }) => {
        const isActive = key === active;
        return (
          <button
            key={key}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => navigate(path)}
            className="flex flex-col items-center gap-1 py-2"
          >
            {/*
              The active indicator is a PILL behind the icon, not just a colour
              change. On a small screen the pill is what makes the current tab
              obvious at a glance.
            */}
            <span
              className={`grid h-8 w-14 place-items-center rounded-full transition-colors ${
                isActive ? 'bg-surface-container-high text-primary' : 'text-on-surface-variant'
              }`}
            >
              <Icon size={21} aria-hidden="true" />
            </span>
            {/*
              ACKNOWLEDGED EXCEPTION to the "no raw sizes" rule: 12px was
              measurably too wide for four labels at 360px. This is one of two
              such exceptions in the application; the other is the audit-log
              JSON block.
            */}
            <span
              className={`text-[11px] leading-none ${
                isActive ? 'font-semibold text-primary' : 'text-on-surface-variant'
              }`}
            >
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
