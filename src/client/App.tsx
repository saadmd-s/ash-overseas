/**
 * PHASE 0 placeholder.
 *
 * The real interface starts in Phase 2 (SRS §23), built mobile-first for a
 * 360 px phone. Nothing here renders money — when it does, it will go through
 * formatPaise() and balanceHeadline() from src/money, never ad-hoc formatting.
 */
export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '40rem' }}>
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>ASH Overseas — Ledger</h1>
      <p style={{ color: '#4b5563' }}>
        Phase 0 scaffold. The ledger core lands in Phase 1, the interface in Phase 2.
      </p>
      <p style={{ color: '#4b5563' }}>
        See <code>docs/IMPLEMENTATION_PLAN.md</code>.
      </p>
    </main>
  );
}
