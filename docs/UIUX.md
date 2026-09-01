# UI/UX Specification

**Product:** ASH Overseas Trading Ledger
**Version:** 1.0 — aligned to SRS v1.0 (Simplified scope)
**Date:** 29 August 2026
**Status:** Derived from [SRS.md](../SRS.md) §10

> **[SRS.md](../SRS.md) is authoritative.** §10 defines the interface
> requirements; this document expands them into implementable detail —
> components, tokens, copy rules, and accessibility criteria.
>
> **The SRS is complete.** §18 specifies **Tailwind CSS v4 with design tokens in
> one `@theme` block** — tokens are the single source of truth, and **no
> hard-coded hex or px belongs in a component**. Icons are `lucide-react`; the
> typeface is **self-hosted Inter** (`@fontsource-variable/inter`), because
> §16.2's CSP forbids CDN assets.
>
> The specific values in §4 remain proposals. Express them as `@theme` tokens;
> the palette is open (see §4.2), the mechanism is not.
>
> **§4 is now settled.** [DESIGN.md](DESIGN.md) records the shipped palette,
> type scale and component class strings, and `src/client/styles.css` is the
> token source of truth. Where this document and DESIGN.md disagree on a visual
> value, DESIGN.md wins; where either disagrees with the SRS on a rule, the SRS
> wins.

---

## 1. Design Priorities

From §10.1. The owner enters records **on a phone, on the move, often in a
hurry** — sometimes at a weighbridge, sometimes mid-negotiation. Three
priorities follow:

### Mobile-first, thumb-first

Design for a **360 px-wide phone first**; desktop is the enhancement. Primary
actions sit within thumb reach at the bottom of the viewport. Tap targets are
**≥ 44 px**.

### The balance is the hero

Every dealer screen leads with the plain-language headline in large type, with an
icon and a text label — **never colour alone**.

### Show the math live

The transaction form shows the running base total, GST, and grand total as the
owner types. **No surprises on save.**

## 2. The Language Rule

This is the most important interface constraint in the product, and it is
absolute.

**The user never sees the words "debit" or "credit", and never sees a bare `+` or
`−`.** (§5, §10.8)

| Internal state              | What the user reads      |
| --------------------------- | ------------------------ |
| `running_balance_paise > 0` | **"Dealer owes you ₹X"** |
| `running_balance_paise < 0` | **"You owe dealer ₹X"**  |
| `running_balance_paise = 0` | **"Settled"**            |

Appendix B's `balanceHeadline` always takes the dealer's name, so the produced
copy is _"Kumar Traders owes you ₹3,23,000"_ — which reads better than the
generic form and removes any doubt about direction.

Payment direction is likewise plain language — **"Received from dealer"** and
**"Paid to dealer"** — never debit/credit (§10.7).

**The wording is defined in code, not in the UI layer.** SRS Appendix B provides
`balanceHeadline(paise, dealerName)`, returning `"<dealer> owes you ₹X"`,
`"You owe <dealer> ₹X"`, or `"Settled"`. Components call it; they do not
reimplement it. That is what keeps the language rule from drifting screen by
screen.

### 2.1 The one exception

Column S of the Excel export carries a **numerically signed** balance so Excel
can sum and chart it, with the plain-language direction in the adjacent column T
(§11.4). A spreadsheet needs an arithmetic value; a human reading it still gets
the words.

## 3. Component Inventory

| Component           | Responsibility                      | Key rules                                                                                                                                                    |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BalanceHeadline`   | The hero balance                    | Renders `balanceHeadline()` from the money module (Appendix B) — the UI never formats a balance itself. Icon + text; screen-reader text spells out direction |
| `BalanceInline`     | Balance in a list row               | Same language rules, compact                                                                                                                                 |
| `MoneyInput`        | Rupee entry → integer paise         | **Emits paise only**; never holds a float                                                                                                                    |
| `MoneyDisplay`      | Render an amount                    | Wraps `formatPaise()`; the only money renderer                                                                                                               |
| `DatePicker`        | Calendar date entry                 | Max = today in **IST**; emits `YYYY-MM-DD` text                                                                                                              |
| `DealerPicker`      | Searchable dealer select            | Excludes archived by default                                                                                                                                 |
| `ModeToggle`        | Purchase / Sale                     | Pre-set from entry point                                                                                                                                     |
| `BankAccountToggle` | OD / Current segmented control      | Required on transactions; defaults to last used                                                                                                              |
| `LineItemRow`       | One item line                       | Item optional; quantity + rate required                                                                                                                      |
| `TotalsPanel`       | Live base / GST / total / round-off | Recomputes on every keystroke                                                                                                                                |
| `LedgerRow`         | One history entry                   | Shows running balance after that entry                                                                                                                       |
| `FilterBar`         | Date / type / mode / bank filters   | Must render the "N of M" notice when active                                                                                                                  |
| `VoidDialog`        | Void confirmation                   | **Names the entry and the amount**                                                                                                                           |
| `ExportMenu`        | Format choice + trigger             | Passes current filters through                                                                                                                               |
| `Toast`             | Save feedback                       | Names what was saved                                                                                                                                         |

## 4. Visual Tokens

**Mechanism is specified; values are not.** §18 requires these to live in one
Tailwind v4 `@theme` block as the single source of truth, with no hard-coded hex
or px in any component. The particular numbers and colours below are proposals —
adjust freely. The **semantics** in §2 and the accessibility criteria in §8 are
what must not change.

### 4.1 Type scale

Typeface: **Inter**, self-hosted via `@fontsource-variable/inter`.

| Role             | Size       | Weight                |
| ---------------- | ---------- | --------------------- |
| Balance headline | 32 / 40 px | 700                   |
| Screen title     | 20 px      | 600                   |
| Body             | 16 px      | 400                   |
| Amount in a row  | 16 px      | 600, tabular numerals |
| Label / meta     | 13 px      | 400                   |

**Amounts always use tabular (monospaced) numerals** so digits align down a
column and a misread is less likely.

### 4.2 Colour

Colour is **always secondary** to icon and text. It never carries meaning alone
(§10.10).

| Role                    | Light                        | Dark      |
| ----------------------- | ---------------------------- | --------- |
| Receivable ("owes you") | `#0F7B4F`                    | `#4ADE80` |
| Payable ("you owe")     | `#B4451F`                    | `#FB923C` |
| Settled                 | `#4B5563`                    | `#9CA3AF` |
| Voided row              | 55% opacity + strike-through | same      |

**The accent colour is an open item** — SRS §22 lists the business name, logo,
and colour accent for the login screen and export title block as still to be
confirmed. Ship with a neutral accent until then.

Deliberately **not** red/green as the sole signal: red-green colour blindness is
common, and neither state is an "error" — a payable is a normal position.

### 4.3 Spacing and targets

4 px base unit. Tap targets **≥ 44 px**. Minimum 8 px between adjacent targets.
Bottom action bar clears the home indicator on iOS.

## 5. Screen Specifications

### 5.1 Home (§10.3)

- Two large primary buttons: **Purchase** and **Sale**.
- Dealer list with current balance and direction inline, **most recently active
  first**.
- Quick access to **New dealer** and **All transactions**.
- Export entry point for dealer balances.

### 5.2 Dealer list (§10.4)

Searchable, filtered by dealer type. Each row: name + current balance with
direction. A "new entry" action from this screen pre-sets the mode.

### 5.3 Dealer detail (§10.5)

```
┌────────────────────────────────────┐
│  ← Kumar Traders            [···]  │
├────────────────────────────────────┤
│                                    │
│   ↓  You owe dealer                │   ← icon + label + amount
│      ₹3,23,000                     │   ← 32px, tabular
│                                    │
├────────────────────────────────────┤
│  [ Filters ▾ ]      [ Export ▾ ]   │
├────────────────────────────────────┤
│  15 Aug 2026   Paid          OD    │
│  ₹1,00,000            ₹3,23,000 ▸  │   ← amount, running balance
├────────────────────────────────────┤
│  10 Aug 2026   Purchase      OD    │
│  ₹59,000              ₹4,23,000 ▸  │
├────────────────────────────────────┤
│  05 Aug 2026   Sale          Cur   │
│  ₹2,36,000            ₹3,64,000 ▸  │
├────────────────────────────────────┤
│                                    │
│  [ + Transaction ]   [ + Payment ] │   ← thumb reach
└────────────────────────────────────┘
```

- History newest first, with an option to reverse the order. **The default is
  an open item** — SRS §22 leaves newest-first vs oldest-first to be confirmed;
  both must be supported either way.
- Each row: date, label (Sale / Purchase / Received / Paid), invoice no. or
  reference, amount, bank tag, and **the running balance after that entry**.
- Voided rows struck through with their reversal adjacent.
- Tapping a row opens the detail sheet: every line item, base, discount, freight,
  GST rate and amount, round-off, grand total, notes, and that record's audit
  trail.

### 5.4 New transaction form (§10.6)

Field order matches how the owner reads a docket:

| #   | Field                  | Behaviour                                                                       |
| --- | ---------------------- | ------------------------------------------------------------------------------- |
| 1   | Mode                   | Pre-set from entry point                                                        |
| 2   | Dealer                 | Pre-set when entered from a dealer screen                                       |
| 3   | Date                   | Defaults to today; **future dates blocked**                                     |
| 4   | Invoice No.            | Optional free text                                                              |
| 5   | Item                   | Optional free text, autocomplete from past entries                              |
| 6   | Quantity               | Required, ≥ 0; unit is optional free text beside it                             |
| 7   | Rate                   | Required, ≥ 0, in rupees                                                        |
| 8   | **Base total**         | Computed, read-only                                                             |
| 9   | _(+ add another item)_ | Repeats 5–7                                                                     |
| 10  | GST %                  | Pre-filled 18, editable, 0–100                                                  |
| 11  | GST amount             | Computed, read-only                                                             |
| 12  | **Total amount**       | Computed, read-only; round-off shown when non-zero                              |
| 13  | Bank account           | OD / Current segmented; required; defaults to last used                         |
| 14  | _More options_         | Collapsed: reference tag, discount, freight, return marker, invoice date, notes |

**One line by default.** The majority of entries use a single line; "add another
item" is an action, not a pre-expanded list (FR-T3).

**Autocomplete never constrains.** Item and unit suggestions come from previously
saved entries but are never required and never limit what can be typed (FR-T10).

**GST rate 0** displays the GST row as `—`, not `₹0.00` (§8.3).

### 5.5 New payment form (§10.7)

Dealer, date, **direction as two plain-language options**, amount, method,
reference, bank tag (hidden when method is cash), notes. Same money input and
draft persistence rules.

### 5.6 Audit log

Read-only, newest first, cursor-paginated. Each row: action, entity, timestamp,
and an expandable before/after view.

## 6. Money Input Behaviour (§10.6)

The single most safety-critical component in the interface.

- The owner types rupees: `3,13,830` or `313830.50`.
- The component **parses to integer paise and emits paise only.** Form state
  never holds a float rupee value.
- **Live-formats to Indian grouping while typing** — `3,13,830`.
- **Curtails input beyond two decimal places.**
- **Treats empty as "not entered", never as zero.** An empty discount is absent,
  not ₹0 — the distinction matters for validation messages.
- `inputmode="decimal"` so phones show a numeric keypad.

### 6.1 Draft persistence

In-progress input autosaves to `localStorage`, so a dropped connection or an
accidental back-navigation never loses a half-typed entry. Cleared on successful
save.

Deliberately **not** full offline sync, which would conflict with the single
source of truth. Drafts store paise, matching form state.

## 7. Display Rules (§10.8)

| Item                   | Rule                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amounts                | `₹1,23,456.78` — Indian grouping, via the single `formatPaise()` using `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })`, **formatted from paise** |
| Balances               | Always plain-language direction, never a bare sign                                                                                                                    |
| Dates                  | `DD MMM YYYY` — e.g. `15 Aug 2026`                                                                                                                                    |
| Voided entries         | Struck through, reversal adjacent                                                                                                                                     |
| GST at 0%              | Row shows `—`, not `₹0.00`                                                                                                                                            |
| Zero amounts in export | Debit/Credit columns blank when zero                                                                                                                                  |

**No ad-hoc formatting anywhere.** One utility, one call site pattern.

## 8. Accessibility (§10.10)

Non-negotiable criteria:

- **Semantic HTML** — real `<button>`, `<label>`, `<table>` where tabular.
- **Real `<label>` elements** bound to every input, not placeholder-as-label.
- **Visible focus rings** — never `outline: none` without a replacement.
- **AA contrast** minimum on all text.
- **No meaning conveyed by colour alone** — every balance direction carries an
  icon and a text label.
- **Screen-reader text spelling out the balance direction.** The visual headline
  may abbreviate; the accessible name never does.

```html
<div class="headline">
  <span aria-hidden="true">↓</span>
  <span class="sr-only">You owe this dealer three lakh twenty-three thousand rupees</span>
  <span aria-hidden="true">You owe dealer ₹3,23,000</span>
</div>
```

- Tap targets ≥ 44 px with ≥ 8 px separation.
- Form errors associated via `aria-describedby`, announced on failure.
- The void confirmation dialog traps focus and is dismissible by Escape.

## 9. States and Feedback (§10.10)

Every screen defines **loading**, **empty**, and **error** states explicitly. See
[APP_FLOW.md §9](APP_FLOW.md) for the per-screen table.

- Saves give clear success feedback — **a toast naming what was saved**, e.g.
  "Saved SALE-2026-08-0039 — ₹2,69,323".
- On save failure the input is preserved and an actionable error is shown.
- The dealer detail error state shows **an error, never a guessed number**.

## 10. The Filter Notice

When any history filter is active, the interface **must** display a clear notice
(§6.6):

```
┌──────────────────────────────────────────┐
│  ⓘ Filtered — showing 1 of 2 entries     │
│    Bank account: OD          [ Clear ]   │
└──────────────────────────────────────────┘
```

The headline balance and the running-balance column are **always computed over
all entries**, never over the filtered subset. The filter is presentational.

This exists so a filtered view can never be misread as the full position — the
failure mode it prevents is the owner glancing at a filtered screen and quoting
the wrong number.

## 11. PWA (§10.10)

Installable — manifest and icon — so the owner launches it like an app.

**Cache the application shell only. Never cache financial data.** A stale balance
is a dangerous balance. Every `/api/*` request is network-only.

## 12. Copy Guidelines

| Do                                      | Don't                |
| --------------------------------------- | -------------------- |
| "Kumar Traders owes you ₹34,408"        | "Balance: +34,408"   |
| "You owe dealer ₹3,23,000"              | "Cr 3,23,000"        |
| "Settled"                               | "₹0.00"              |
| "Received from dealer"                  | "Credit"             |
| "Paid to dealer"                        | "Debit"              |
| "Void SALE-2026-08-0039 for ₹2,19,952?" | "Delete this entry?" |
| "Filtered — showing 1 of 2 entries"     | _(silence)_          |
| "Saved SALE-2026-08-0039 — ₹2,69,323"   | "Success"            |

Never the word "delete" anywhere in the interface — nothing is ever deleted, and
the copy should not suggest otherwise.
