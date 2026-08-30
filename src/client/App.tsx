/**
 * The application shell and router — SRS §10.2.
 *
 * A small history-API router rather than a routing library: the navigation map
 * is five screens deep, and a dependency would be weight for nothing. The
 * Worker serves index.html for any non-asset path, so deep links work.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, setSessionLostHandler, type Dealer } from './lib';
import { ErrorState, Loading, Toast } from './components';
import { AllTransactions, DealerList, Home, NewDealer } from './screens/Home';
import { DealerDetail } from './screens/DealerDetail';
import { TransactionForm } from './screens/TransactionForm';
import { PaymentForm } from './screens/PaymentForm';
import { AuditView, GateDisabledBanner, Login, Settings, type AuthState } from './screens/Auth';

type Route =
  | { name: 'home' }
  | { name: 'list'; type: 'supplier' | 'buyer' }
  | { name: 'dealer'; id: number }
  | { name: 'transaction'; id: number; mode: 'purchase' | 'sale' }
  | { name: 'payment'; id: number }
  | { name: 'all' }
  | { name: 'new-dealer' }
  | { name: 'settings' }
  | { name: 'audit' };

function parse(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'purchase') return { name: 'list', type: 'supplier' };
  if (parts[0] === 'sale') return { name: 'list', type: 'buyer' };
  if (parts[0] === 'transactions') return { name: 'all' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'audit') return { name: 'audit' };
  if (parts[0] === 'dealers') {
    if (parts[1] === 'new') return { name: 'new-dealer' };
    const id = Number(parts[1]);
    if (Number.isInteger(id) && id > 0) {
      if (parts[2] === 'transaction') {
        return { name: 'transaction', id, mode: parts[3] === 'purchase' ? 'purchase' : 'sale' };
      }
      if (parts[2] === 'payment') return { name: 'payment', id };
      return { name: 'dealer', id };
    }
  }
  return { name: 'home' };
}

/**
 * The gate, client side — SRS §16.1.
 *
 * This decides what is DRAWN, never what is permitted: every figure comes from
 * `/api`, which is behind the server gate. If this component were bypassed
 * entirely the attacker would still see an empty shell.
 */
export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authFailed, setAuthFailed] = useState(false);

  const refreshAuth = useCallback(() => {
    setAuthFailed(false);
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json() as Promise<AuthState>)
      .then(setAuth)
      .catch(() => setAuthFailed(true));
  }, []);

  useEffect(refreshAuth, [refreshAuth]);

  // A 401 from anywhere drops straight back to the login screen, rather than
  // leaving each screen to render its own puzzled error.
  useEffect(() => {
    setSessionLostHandler(() => setAuth((a) => (a ? { ...a, authenticated: false } : a)));
  }, []);

  if (authFailed) {
    return <ErrorState message="Could not reach the server." onRetry={refreshAuth} />;
  }
  if (!auth) return <Loading what="the application" />;
  if (!auth.authenticated) return <Login auth={auth} onSignedIn={refreshAuth} />;

  return (
    <>
      {auth.gate === 'disabled' && <GateDisabledBanner />}
      <SignedIn auth={auth} onAuthChanged={refreshAuth} />
    </>
  );
}

function SignedIn({ auth, onAuthChanged }: { auth: AuthState; onAuthChanged: () => void }) {
  const [route, setRoute] = useState<Route>(() => parse(window.location.pathname));
  const [toast, setToast] = useState<string | null>(null);

  const navigate = useCallback((path: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setRoute(parse(path));
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parse(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Intercept in-app links so the SPA handles them without a full reload.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href?.startsWith('/') || anchor.hasAttribute('download')) return;
      e.preventDefault();
      navigate(href);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [navigate]);

  const showToast = useCallback((message: string) => setToast(message), []);

  return (
    <>
      <Chrome route={route} navigate={navigate} />
      <Screen
        route={route}
        navigate={navigate}
        showToast={showToast}
        auth={auth}
        onAuthChanged={onAuthChanged}
      />
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </>
  );
}

function Chrome({ route, navigate }: { route: Route; navigate: (path: string) => void }) {
  if (route.name === 'home') return null;
  return (
    <div className="border-b border-[var(--color-line)] bg-[var(--color-surface)] p-2">
      <button type="button" className="btn" onClick={() => navigate('/')}>
        ← Home
      </button>
    </div>
  );
}

function Screen({
  route,
  navigate,
  showToast,
  auth,
  onAuthChanged,
}: {
  route: Route;
  navigate: (path: string, replace?: boolean) => void;
  showToast: (message: string) => void;
  auth: AuthState;
  onAuthChanged: () => void;
}) {
  switch (route.name) {
    case 'home':
      return (
        <Home
          onOpenList={(type) => navigate(type === 'supplier' ? '/purchase' : '/sale')}
          onOpenAll={() => navigate('/transactions')}
          onNewDealer={() => navigate('/dealers/new')}
        />
      );

    case 'list':
      return <DealerList type={route.type} />;

    case 'all':
      return <AllTransactions />;

    case 'settings':
      return <Settings auth={auth} onChanged={onAuthChanged} />;

    case 'audit':
      return <AuditView />;

    case 'new-dealer':
      return (
        <NewDealer
          onSaved={(id) => navigate(`/dealers/${id}`, true)}
          onCancel={() => navigate('/')}
        />
      );

    case 'dealer':
    case 'transaction':
    case 'payment':
      return <WithDealer route={route} navigate={navigate} showToast={showToast} />;
  }
}

/** Loads the dealer once for the three screens that need one. */
function WithDealer({
  route,
  navigate,
  showToast,
}: {
  route: Extract<Route, { name: 'dealer' | 'transaction' | 'payment' }>;
  navigate: (path: string, replace?: boolean) => void;
  showToast: (message: string) => void;
}) {
  const [dealer, setDealer] = useState<Dealer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ dealer: Dealer }>(`/api/dealers/${route.id}`)
      .then((d) => setDealer(d.dealer))
      .catch(() => setError('Could not load that dealer.'));
  }, [route.id]);

  useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!dealer) return <Loading what="dealer" />;

  if (route.name === 'transaction') {
    return (
      <TransactionForm
        dealer={dealer}
        mode={route.mode}
        onSaved={(message) => {
          showToast(message);
          navigate(`/dealers/${dealer.id}`, true);
        }}
        onCancel={() => navigate(`/dealers/${dealer.id}`)}
      />
    );
  }

  if (route.name === 'payment') {
    return (
      <PaymentForm
        dealer={dealer}
        onSaved={(message) => {
          showToast(message);
          navigate(`/dealers/${dealer.id}`, true);
        }}
        onCancel={() => navigate(`/dealers/${dealer.id}`)}
      />
    );
  }

  return (
    <DealerDetail
      key={version}
      dealer={dealer}
      onAddTransaction={(mode) => navigate(`/dealers/${dealer.id}/transaction/${mode}`)}
      onAddPayment={() => navigate(`/dealers/${dealer.id}/payment`)}
      onChanged={() => {
        // A void changes the headline as well as the history, so refresh the
        // dealer and remount the detail screen.
        load();
        setVersion((v) => v + 1);
      }}
      toast={showToast}
    />
  );
}
