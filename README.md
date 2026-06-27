# Kwazy Pricing Desk

Internal margin calculator: TBO supplier cost vs. competitor retail (MMT, Goibibo, Booking.com). Solves for the maximum markup that keeps your all-in price at or below the cheapest competitor, then shows reward headroom and net margin per room-night.

## How it works

- **TBO price** is entered tax-inclusive (your net cost basis).
- **GST slab** is set by the *value of supply* (your final selling price to the customer), per GST 2.0 effective 22 Sep 2025:
  - up to ₹1,000/night: nil
  - ₹1,001–₹7,500/night: 5%, no ITC
  - above ₹7,500/night: 18%, with ITC
- **ITC case (18%):** markup is added on the TBO base (net of TBO's embedded tax, which you reclaim).
- **No-ITC case (5% / nil):** markup is added on the TBO gross (embedded tax is unrecoverable, so it stays in your cost).
- **Markup** is solved so your all-in price (base/gross + markup + GST on markup) exactly matches the cheapest competitor entered.
- **OPEX** defaults to 6% of GTV (selling price); editable.
- **Reward rate** is a variable you set. "Max reward" shows the break-even reward rate (net profit = 0).

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Vercel

Push this folder to a GitHub repo, then import it at vercel.com/new. No environment variables or backend needed; it's a fully static client-side app. Build command and output are auto-detected (Next.js).
