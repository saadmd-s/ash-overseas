/**
 * PHASE 1 — the minimal dealer screen.
 *
 * §23: "Minimal dealer-detail screen: headline plus chronological history.
 * Function over form." The real interface, with the transaction and payment
 * forms, filters, void dialog and exports, is Phase 2.
 *
 * Two rules are already load-bearing here and must never regress:
 *   - Every balance renders through `balanceHeadline()` / `formatPaise()` from
 *     the money module. The UI never formats money itself (§10.8).
 *   - No screen shows "debit", "credit", or a bare +/− (§5, §10.8).
 */

import { useCallback, useEffect, useState } from 'react';
import { balanceHeadline, formatPaise } from '../money';

interface Dealer {
  id: number;
  name: string;
  type: 'supplier' | 'buyer' | 'both';
  isArchived: boolean;
  balancePaise: number;
}

interface LedgerEntry {
  id: number;
  entryDate: string;
  sourceType: 'transaction' | 'payment' | 'opening' | 'reversal';
  debitPaise: number;
  creditPaise: number;
  runningBalancePaise: number;
  bankAccount: 'od' | 'current' | null;
  label: string | null;
  description: string | null;
}

interface LedgerResponse {
  entries: LedgerEntry[];
  totalCount: number;
  shownCount: number;
  balancePaise: number;
}

/** `DD MMM YYYY` — §10.8. The text date is sliced, never parsed into a Date. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The amount a row moved, without ever naming the direction as debit/credit. */
function movementOf(entry: LedgerEntry): number {
  return entry.debitPaise !== 0 ? entry.debitPaise : entry.creditPaise;
}

const styles = {
  page: {
    fontFamily: 'system-ui, sans-serif',
    padding: '1rem',
    maxWidth: '52rem',
    margin: '0 auto',
  },
  headline: { fontSize: '1.75rem', fontWeight: 700, margin: '0.25rem 0' },
  muted: { color: '#4b5563' },
  row: { borderBottom: '1px solid #e5e7eb', padding: '0.6rem 0' },
  right: { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  button: {
    minHeight: '44px',
    padding: '0.5rem 1rem',
    fontSize: '1rem',
    cursor: 'pointer',
    borderRadius: '6px',
    border: '1px solid #d1d5db',
    background: '#fff',
  },
};

export function App() {
  const [dealers, setDealers] = useState<Dealer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Dealer | null>(null);

  useEffect(() => {
    fetch('/api/dealers')
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ dealers: Dealer[] }>)
          : Promise.reject(new Error('Could not load dealers.')),
      )
      .then((data) => setDealers(data.dealers))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (selected) {
    return <DealerDetail dealer={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <main style={styles.page}>
      <h1 style={{ fontSize: '1.25rem' }}>ASH Overseas — Ledger</h1>
      <p style={styles.muted}>
        Phase 1. Read-only: entry forms, filters and exports arrive in Phase 2.
      </p>

      {error && <p role="alert">{error}</p>}
      {!dealers && !error && <p style={styles.muted}>Loading…</p>}
      {dealers?.length === 0 && <p style={styles.muted}>No dealers yet.</p>}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {dealers?.map((dealer) => (
          <li key={dealer.id} style={styles.row}>
            <button
              type="button"
              onClick={() => setSelected(dealer)}
              style={{ ...styles.button, width: '100%', textAlign: 'left' }}
            >
              <strong>{dealer.name}</strong>
              <br />
              <span style={styles.muted}>{balanceHeadline(dealer.balancePaise, dealer.name)}</span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

function DealerDetail({ dealer, onBack }: { dealer: Dealer; onBack: () => void }) {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/dealers/${dealer.id}/ledger`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<LedgerResponse>)
          : Promise.reject(new Error('Could not load the history.')),
      )
      .then((d) => setData(d))
      .catch((e: Error) => setError(e.message));
  }, [dealer.id]);

  useEffect(load, [load]);

  return (
    <main style={styles.page}>
      <button type="button" onClick={onBack} style={styles.button}>
        ← All dealers
      </button>

      <h1 style={{ fontSize: '1.25rem', marginBottom: 0 }}>{dealer.name}</h1>

      {/*
        The balance is the hero (§10.1). Direction is carried by an icon AND
        text — never by colour alone (§10.10) — and the accessible name spells
        it out in full for a screen reader.
      */}
      {error ? (
        // §10.10 / APP_FLOW §9: if the balance cannot be computed with
        // certainty, show an error, never a guessed number.
        <p role="alert">{error}</p>
      ) : !data ? (
        <p style={styles.muted}>Loading…</p>
      ) : (
        <>
          <p style={styles.headline}>
            <span aria-hidden="true">
              {data.balancePaise > 0 ? '↑ ' : data.balancePaise < 0 ? '↓ ' : '• '}
            </span>
            {balanceHeadline(data.balancePaise, dealer.name)}
          </p>

          {data.shownCount !== data.totalCount && (
            <p role="status">
              Filtered — showing {data.shownCount} of {data.totalCount} entries
            </p>
          )}

          {data.entries.length === 0 ? (
            <p style={styles.muted}>No entries yet.</p>
          ) : (
            <table style={styles.table}>
              <caption style={{ textAlign: 'left', ...styles.muted }}>
                Every entry in date order, with the running balance after each.
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Date
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Entry
                  </th>
                  <th scope="col" style={styles.right}>
                    Amount
                  </th>
                  <th scope="col" style={styles.right}>
                    Balance after
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => (
                  <tr key={entry.id} style={styles.row}>
                    <td>{formatDate(entry.entryDate)}</td>
                    <td>
                      {entry.label}
                      {entry.bankAccount && (
                        <span style={styles.muted}>
                          {' '}
                          · {entry.bankAccount === 'od' ? 'OD' : 'Current'}
                        </span>
                      )}
                    </td>
                    <td style={styles.right}>{formatPaise(movementOf(entry))}</td>
                    <td style={styles.right}>
                      {/* Plain language, never a bare sign (§10.8). */}
                      {balanceHeadline(entry.runningBalancePaise, dealer.name)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}
