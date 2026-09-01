# Design & Style Specification

**Product:** ASH Overseas Trading Ledger
**Token source of truth:** [`src/client/styles.css`](../src/client/styles.css) — the one `@theme` block
**Component source of truth:** [`src/client/ui.tsx`](../src/client/ui.tsx)
**Status:** Describes the shipped interface

> **[SRS.md](../SRS.md) is authoritative on every rule.** This document is
> authoritative on every _visual value_. Where the two touch — the balance
> language, the ban on bare `+`/`−`, the ban on colour-only meaning — the SRS
> wins, and §14 below records the one place that mattered.
>
> [UIUX.md](UIUX.md) left the palette open ("the specific values in §4 remain
> proposals… the palette is open, the mechanism is not"). This document closes
> it.

**The rule that governs everything here: if a value is not a token, it does not
belong in a component.** No raw hex, no raw px font sizes, no ad-hoc colours.
There are exactly two acknowledged exceptions and both are commented at the
point of use — the bottom-tab label size, and the audit-log JSON block.

---

## 1. The five rules

In priority order. Where two conflict, the higher wins.

### 1. Light, clean, institutional

Deep navy on soft-white. Calm surfaces, generous space, hairline borders. This
is a financial record, not a consumer app: it should feel like a well-kept bank
statement rather than a social feed. No gradients, no drop shadows on cards, no
illustrations, and no decorative colour anywhere except one soft glow on the
login panel.

The background is **not** pure white — it is `#f8f9ff`, a soft white with a
faint blue cast, and cards sit on top of it in pure white. That inversion is
deliberate: it gives every card a visible edge without needing a shadow, so the
interface stays flat and calm while staying legible.

### 2. Mobile-first, thumb-first

The design target is a **360 px phone**, because that is where records are
actually entered — standing in a yard, one-handed. Desktop is the enhancement.

- Every tap target is at least 44 px. Buttons use `py-2.5` / `py-3` on top of a
  text line-height, which lands at 44–48 px. This is why the height is a padding
  value rather than a fixed `h-`.
- Navigation sits at the **bottom** on mobile and in the **left rail** on
  desktop — two layouts, not one that shrinks.
- Modals are **bottom sheets** on mobile, centred dialogs from `sm` up. One
  component, two behaviours.
- Content padding is `p-4` on mobile, `p-8` at `lg`.

### 3. The balance is the hero

Every dealer screen leads with the balance in the largest type on the page
(`text-display-lg`, 32/40, weight 700). Never a bare number, never a bare sign.

Direction is carried **three ways at once** — words, icon, colour — and never by
colour alone:

| Balance  | Words             | Colour           | Icon             |
| -------- | ----------------- | ---------------- | ---------------- |
| Positive | "Dealer owes you" | `positive` green | `ArrowUpRight`   |
| Negative | "You owe dealer"  | `negative` red   | `ArrowDownRight` |
| Zero     | "Settled"         | `neutral` grey   | `Minus`          |

This is not decoration. Roughly 8% of men have some form of colour-vision
deficiency and red/green is the exact pair they lose. A ledger that says "you
owe" only in red is a ledger that lies to those users. The words carry the
meaning; the colour reinforces it.

The headline splits the sentence across two type sizes for display, but a screen
reader still hears the whole sentence from `balanceHeadline()` — the money
module's wording, unchanged, in an `sr-only` span.

### 4. Money is tabular

Every amount carries `.tnum`. Inter's default figures are proportional — a `1`
is narrower than a `0` — so a column of amounts visibly wobbles and the eye
cannot scan down it. Tabular figures give every digit the same advance width, so
decimal points line up with no explicit alignment. This applies at every size,
including the 32 px headline. Amounts are right-aligned in every list; labels
are left-aligned.

### 5. Accessible by default

Semantic HTML, real `<label>` elements wrapping their inputs, visible focus
rings, AA contrast on every token pair by construction, no meaning by colour
alone, and screen-reader text that spells out the balance direction in full.

---

## 2. How the styling is wired

| Concern    | Choice                                                         | Why                                                                                                                    |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| CSS engine | Tailwind **v4** via `@tailwindcss/vite`                        | Tokens in one `@theme` block; utilities generated on demand. No config file, no PostCSS chain, no purge list.          |
| Tokens     | CSS custom properties inside `@theme`                          | Declaring `--color-primary` generates `bg-primary`, `text-primary`, `border-primary`, `ring-primary` from one line.    |
| Font       | **Inter Variable**, self-hosted (`@fontsource-variable/inter`) | Imported once in `main.tsx`. **Not** Google Fonts — the §16.2 CSP forbids external origins.                            |
| Icons      | **`lucide-react`**                                             | Tree-shaken, crisp at any size, CSP-safe, no icon font and no FOUT.                                                    |
| Currency   | ₹ only, always via `formatPaise()`                             | Money is integer paise until the moment of render.                                                                     |
| Dark mode  | Deliberately deferred                                          | Tokens are named semantically, so a dark theme can be added later as an overriding block without touching a component. |

**The naming convention is Material 3's, and it is load-bearing.** Every colour
comes in an `x` / `on-x` pair. Text on a `bg-x` surface always uses `text-on-x`.
Follow that one rule and AA contrast holds by construction — the pairing itself
tells you which foreground belongs on which ground.

---

## 3. Colour

### Brand and core

| Token                    | Hex       | Where                                                         |
| ------------------------ | --------- | ------------------------------------------------------------- |
| `primary`                | `#091426` | Brand mark, primary buttons, page headings, the Purchase card |
| `on-primary`             | `#ffffff` | Text and icons on `primary`                                   |
| `primary-container`      | `#1e293b` | Dealer avatars, dark accent chips                             |
| `on-primary-container`   | `#d8e3fb` | Initials inside those avatars                                 |
| `secondary`              | `#5b5e67` | Muted controls                                                |
| `secondary-container`    | `#dfe2ed` | The neutral segmented track — the bank-account toggle         |
| `on-secondary-container` | `#3f424b` | Text on those                                                 |

`primary` is a **very** deep navy — near-black, not a mid-blue. That is what
makes the app read as institutional rather than as a consumer product. A
brighter brand blue would look like a fintech startup; this looks like a ledger
book.

### Surfaces

| Token                       | Hex       | Use                                             |
| --------------------------- | --------- | ----------------------------------------------- |
| `background` / `surface`    | `#f8f9ff` | The page                                        |
| `surface-bright`            | `#ffffff` | App bar, sidebar, tab bar, modal body           |
| `surface-container-lowest`  | `#ffffff` | Cards, list containers, inputs                  |
| `surface-container-low`     | `#eff4ff` | Summary panels, expanded rows, disclosure       |
| `surface-container`         | `#e5eeff` | Hover states, chips                             |
| `surface-container-high`    | `#dce9ff` | The active bottom-tab pill                      |
| `surface-container-highest` | `#d3e4fe` | Reserved for emphasis                           |
| `on-surface`                | `#0b1c30` | Primary text                                    |
| `on-surface-variant`        | `#45474c` | Secondary text, labels, inactive icons          |
| `outline`                   | `#75777d` | Strong borders                                  |
| `outline-variant`           | `#c5c6cd` | Hairlines — **the most-used border in the app** |

The ramp does the work elevation and shadow would do in a Material app. Depth is
**tint, not shadow**, which keeps the interface flat and printable-looking.

### Semantic — balance direction

| Token                   | Hex       | Meaning                        |
| ----------------------- | --------- | ------------------------------ |
| `positive`              | `#0f7b4d` | "Dealer owes you" — receivable |
| `positive-container`    | `#c9f2dc` | Soft green ground              |
| `on-positive-container` | `#06301d` | Text on it                     |
| `negative`              | `#ba1a1a` | "You owe dealer" — payable     |
| `negative-container`    | `#ffdad6` | Soft red ground                |
| `on-negative-container` | `#410002` | Text on it                     |
| `neutral`               | `#5b5e67` | "Settled"                      |

The green is deliberately **deep and desaturated**, not a bright `#22c55e`. A
saturated green reads as "success!" — a celebration. Here it means "this is a
receivable", a neutral fact about a trading position.

**`negative` doubles as the error and destructive colour.** Void buttons,
validation errors and error toasts all use it. A deliberate collapse: in this
application "money flowing the wrong way" and "something went wrong" are close
enough in the owner's mind that a second red would only add noise.

---

## 4. Typography

One family, six named steps. Size, line-height, weight and tracking are baked
into each token, so `text-display-lg` sets all four at once and no component
specifies a weight or a tracking separately.

| Utility            | Size / line-height | Weight | Tracking | Used for                            |
| ------------------ | ------------------ | ------ | -------- | ----------------------------------- |
| `text-display-lg`  | 32 / 40            | 700    | −0.02em  | The balance headline                |
| `text-headline-md` | 24 / 32            | 600    | −0.01em  | Page titles, dealer name            |
| `text-headline-sm` | 20 / 28            | 600    | —        | Card titles, modal titles, wordmark |
| `text-body-lg`     | 16 / 24            | 400    | —        | Body copy                           |
| `text-body-md`     | 14 / 20            | 400    | —        | **The default** — rows, cells       |
| `text-label-caps`  | 12 / 16            | 600    | +0.05em  | Overlines — paired with `uppercase` |

**Negative tracking on the large sizes** is not a flourish. Inter's default
spacing is tuned for body copy and looks loose at 32 px; −0.02em is what makes
the headline read as typeset rather than as scaled-up body text.

**`text-label-caps` + `uppercase`** is the pairing that unifies form labels,
ledger chips and section headers — all the same 12 px letterspaced caps in the
same muted grey. The one exception is **button text**, which uses the
label-caps size and tracking _without_ `uppercase`: shouting "SAVE SALE" at the
owner reads worse than "Save sale", and the class strings in §8 are the
canonical form.

---

## 5. Spacing, radius, elevation

Tailwind's numeric scale, unmodified. `gap-1`/`gap-2` inside a chip, `gap-3` /
`space-y-3` between form fields, `p-4` list rows and mobile pages, `p-5` card and
modal interiors, `space-y-4` / `space-y-6` between sections, `p-8` desktop pages.

**A deliberate omission, recorded because it is a real trap:** custom spacing
names `sm` / `md` / `lg` are **not** defined and must never be added. In Tailwind
v4 those names collide with the reserved size scale, so declaring `--spacing-lg`
silently breaks `max-w-lg`, `text-lg` and `rounded-lg` across the whole
application — with no error, only wrong layout.

**Radius by role, not by taste:** `rounded-lg` (8 px) for interactive controls,
`rounded-xl` (12 px) for containers, `rounded-full` for identity and status
markers. Applied consistently, radius alone tells you what kind of element you
are looking at.

**Elevation: almost none.** Cards have no shadow — a hairline border plus a
lighter surface. `shadow-sm` appears once, on the active segment of a segmented
control. `shadow-lg` appears once, on the toast, which genuinely floats.

---

## 6. Icons

`lucide-react`, `strokeWidth` 2, with a size ladder: 15–16 px inline with text,
18 px in rows, chips and header buttons, 20–22 px for navigation and page
titles, 21 px in the bottom tab bar (a touch target), 24–28 px for the login
mark, Home cards and empty states.

`ChevronRight` means **navigate away**; `ChevronDown` means **expand here**, and
rotates 180° when open. The distinction is consistent and the owner learns it
once.

---

## 7. The shell

[`AppShell.tsx`](../src/client/AppShell.tsx). Route-aware, with two layouts
either side of `lg` (1024 px).

**Desktop:** a `w-64` sidebar on `surface-bright` with a hairline right border —
brand block, four navigation destinations, a primary "New dealer" button pinned
at the bottom. The active item changes **three** things — background, weight and
colour — so it is unmistakable. Header is `sticky top-0 h-16`.

**Mobile:** the brand moves into the header; navigation becomes a fixed
`grid-cols-4` bottom tab bar. The active tab gets a **pill** behind its icon
(`h-8 w-14 rounded-full bg-surface-container-high`), not merely a colour change —
on a small screen the pill is what makes the current tab obvious at a glance.
`paddingBottom: env(safe-area-inset-bottom)` clears the iPhone home indicator,
and main content carries `pb-24` so the last list row is never hidden behind the
bar.

**The header cluster** is four controls that collapse progressively rather than
disappearing: Audit log, Account (username hidden below `sm`, `max-w-32
truncate` so a long name never breaks the header), Sign out (the only
hover-to-red in the header), and the primary New button (label hidden below
`sm`). Nothing becomes unreachable on a narrow screen.

**Navigation destinations** are Home, Purchase, Sale, Dealers. The primary
action is **New dealer**, not "New transaction" as the source spec had it — in
this data model a transaction is always entered against a dealer, so the entry
points for goods and money live on the dealer screen where the balance they will
move is already on screen.

---

## 8. Component class strings

Canonical, and defined once in [`ui.tsx`](../src/client/ui.tsx).

```
Card         rounded-xl border border-outline-variant bg-surface-container-lowest p-5
Panel        rounded-lg bg-surface-container-low p-3
Filled btn   rounded-lg bg-primary px-4 py-2.5 text-label-caps font-semibold text-on-primary
             transition-opacity hover:opacity-90 disabled:opacity-50
Outline btn  rounded-lg border border-outline-variant px-3 py-2 text-label-caps font-semibold
             transition-colors hover:bg-surface-container disabled:opacity-50
Destructive  rounded-lg bg-negative px-4 py-2.5 text-label-caps font-semibold text-on-negative
             transition-opacity hover:opacity-90 disabled:opacity-50
Input        w-full rounded-lg border border-outline-variant bg-surface-container-lowest
             px-3 py-2.5 outline-none transition-shadow focus:ring-2 focus:ring-primary
Chip         rounded-full px-2 py-0.5 text-label-caps uppercase bg-surface-container
             text-on-surface-variant          (voided: bg-negative-container / on-negative-container)
Avatar       grid size-9 shrink-0 place-items-center rounded-full bg-primary-container
             text-on-primary-container text-body-md font-semibold
List         divide-y divide-outline-variant overflow-hidden rounded-xl
             border border-outline-variant bg-surface-container-lowest
Row button   flex w-full items-center gap-3 px-4 py-3 text-left transition-colors
             hover:bg-surface-container
Toast        flex items-center gap-2 rounded-lg px-4 py-3 text-body-md shadow-lg
```

Notes that are easy to lose in a refactor:

- Hover on a filled button is `opacity-90`, **not** a different colour. One
  hover treatment means no second set of hover tokens to keep in step.
- `outline-none` is **only ever** paired with `focus:ring-2` (or `focus-within:`
  on wrapped inputs). Removing a focus indicator without replacing it is the
  single most common accessibility failure in web forms.
- `divide-y` on the list container plus `overflow-hidden` gives hairline
  separators that stop cleanly at the rounded corners, with no border under the
  last row and no `:last-child` handling.
- Every clickable row is a real `<button>`, never a `<div onClick>`.
- The money input puts the ring on the **wrapper** via `focus-within:`, so the ₹
  prefix is enclosed by the ring rather than stranded outside it, and carries
  `inputMode="decimal"` for the numeric keypad.
- The modal is one component with two presentations: `items-end` +
  `rounded-t-xl` on mobile, `sm:items-center` + `sm:rounded-xl` above. It uses
  `max-h-[92dvh]` — `dvh`, not `vh`, so it stays correct when a mobile browser
  collapses its URL bar — and closes three ways: the X, the scrim, and Escape,
  all disabled while a request is in flight.

---

## 9. States

Three, defined on every list-bearing screen, and the consistency matters more
than the sophistication — a user who has seen one empty state recognises every
other one instantly.

- **Loading** — a centred muted sentence. Never a skeleton, never a spinner.
  There are no spinners anywhere in this application.
- **Empty** — a dashed-border panel with a muted icon and a plain, actionable
  sentence. Dashed border is the app's consistent "this is a placeholder, not a
  thing" signal. Never an illustration.
- **Error** — a tinted banner in the `negative-container` pair. Inline form
  errors are lighter: bare `text-negative` under the field, with `role="alert"`.

**Disabled is uniform:** `disabled:opacity-50`, with the label swapped to a
present participle — "Saving…", "Voiding…", "Signing in…".

---

## 10. Motion

Minimal and functional. No animation library, no keyframes. `transition-colors`
on rows and icon buttons, `transition-opacity` on filled buttons,
`transition-transform` + `rotate-180` on disclosure chevrons,
`active:scale-[0.98]` on the two Home action cards. All at Tailwind's default
150 ms. Nothing eases, nothing bounces, nothing is staggered.

In a financial tool, motion that delays the user seeing a number is a cost, not
a delight.

---

## 11. Accessibility

| Decision               | Implementation                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus always visible   | `outline-none` only ever with `focus:ring-2 focus:ring-primary`; a `:focus-visible` safety net in `styles.css` for anything that styles none |
| Labels are real        | `<label>` wraps its input; where an id is needed, `useId()` supplies it                                                                      |
| Rows are buttons       | Every clickable row is a `<button>` — keyboard-focusable, correctly announced                                                                |
| Icon buttons are named | `IconButton` takes `label` as a **required** prop, so it cannot be forgotten                                                                 |
| Modals announced       | `role="dialog"`, `aria-modal`, `aria-label`, Escape to close                                                                                 |
| Toasts announced       | `aria-live="polite"`, `aria-atomic`, `role="status"`                                                                                         |
| Errors announced       | `role="alert"` on form-level errors                                                                                                          |
| Never colour alone     | Balance direction = icon + words + colour; voided rows = chip + strike-through + dimming                                                     |
| Contrast               | Every `x` / `on-x` pair is AA by construction                                                                                                |
| Mobile keyboards       | `inputMode="decimal"` on numeric fields                                                                                                      |
| Future dates blocked   | `max={today()}` on every date input, matching the server rule                                                                                |

---

## 12. PWA and platform chrome

`theme-color` is `#f8f9ff`, matching the page so the browser chrome blends in.
`color-scheme: light` in both the meta tag and `html`. Viewport is
`width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover` —
`viewport-fit=cover` pairs with `env(safe-area-inset-bottom)` on the tab bar
(neither works alone), and `maximum-scale=1.0` prevents iOS's zoom-on-focus jump
when tapping into a form field. Manifest is `standalone` / `portrait-primary`.
The service worker caches the **app shell only**, never financial data, because
a stale balance is a dangerous balance.

`-webkit-font-smoothing: antialiased` on `body` keeps Inter from rendering heavy
on macOS.

---

## 13. Where the design system is applied

| Screen             | File                                | Notes                                                                                  |
| ------------------ | ----------------------------------- | -------------------------------------------------------------------------------------- |
| Login              | `screens/Auth.tsx`                  | The only page outside the shell; the split navy/form panel and the one decorative glow |
| Home               | `screens/Home.tsx`                  | Filled/outlined action-card pair, then the dealer roster                               |
| Dealer list        | `screens/Home.tsx` (`DealerRoster`) | One component, three uses: all / suppliers / buyers; search debounced 200 ms           |
| Dealer detail      | `screens/DealerDetail.tsx`          | Balance headline, filters, ledger rows, void                                           |
| Transaction form   | `screens/TransactionForm.tsx`       | Line sub-cards, "More options" disclosure, live summary                                |
| Payment form       | `screens/PaymentForm.tsx`           | Plain-language direction, bank tag in the neutral pair                                 |
| Entry detail sheet | `screens/EntryEdit.tsx`             | Figures as text, never as inputs                                                       |
| All transactions   | `screens/Home.tsx`                  | Filters and export                                                                     |
| Audit log          | `screens/Auth.tsx`                  | Expand-in-place before/after JSON                                                      |
| Account            | `screens/Auth.tsx`                  | `max-w-xl` — the only constrained measure in the app                                   |

---

## 14. Deviations from the source specification

Three, all deliberate, all recorded in the code at the point they apply.

**1. No `+` / `−` prefix on ledger movement amounts.** The source spec's ledger
row draws the movement as `+₹2,69,323.00`. SRS §10.8 forbids it outright — "the
user never sees a bare `+`/`−`" — and where the two disagree the SRS wins. The
direction is carried instead by the label chip (SALE / PURCHASE / RECEIPT /
PAYMENT / REVERSAL) and by colour, which is the same information without the
sign. The running balance beneath keeps its own icon and words.

**2. The primary action is "New dealer", not "New transaction".** See §7.

**3. The entry detail sheet is a modal, not an expand-in-place panel.** It
carries an edit form; a form that opens inside a scrolling list row is harder to
use one-handed than a bottom sheet, and the sheet is already in the component
library. The audit log _does_ expand in place, because it is read-only.

**Two things not to change, even though simplification might tempt you:**

- **The three-signal void treatment** (chip + strike-through + dimming). It
  matters _more_ in a single-balance ledger, not less — there is no second
  account to cross-check against.
- **Tabular figures on every amount.** The export feature makes column alignment
  more visible, not less: the owner will compare the screen against the
  spreadsheet.

---

## 15. Cheat sheet

```
COLOUR
  brand        primary #091426 · on-primary #ffffff
  page         surface #f8f9ff          card    surface-container-lowest #ffffff
  panel        surface-container-low #eff4ff     hover  surface-container #e5eeff
  text         on-surface #0b1c30 · on-surface-variant #45474c
  hairline     outline-variant #c5c6cd
  receivable   positive #0f7b4d + ArrowUpRight   + "Dealer owes you"
  payable      negative #ba1a1a + ArrowDownRight + "You owe dealer"
  settled      neutral  #5b5e67 + Minus          + "Settled"

TYPE (Inter Variable)
  display-lg   32/40 700 -0.02em   balance headline
  headline-md  24/32 600 -0.01em   page title
  headline-sm  20/28 600           card / modal title
  body-lg      16/24 400           body
  body-md      14/20 400           DEFAULT
  label-caps   12/16 600 +0.05em   overlines (+ uppercase); buttons without
  .tnum on EVERY amount

SPACE   numeric scale only — never define spacing-sm/md/lg
RADIUS  lg=8 controls · xl=12 containers · full=avatars & chips
ICONS   lucide-react, strokeWidth 2, sizes 16 / 18 / 20-22 / 24-28
SHADOW  none on cards · shadow-sm on active segment · shadow-lg on toast
MOTION  transition-colors / -opacity / -transform, 150ms. Nothing else.

BREAKPOINT  lg (1024) sidebar appears, bottom tabs disappear
            sm (640)  modal becomes a centred dialog; labels appear
```
