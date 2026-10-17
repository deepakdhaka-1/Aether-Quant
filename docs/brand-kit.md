# Aether Quant — working brand kit

**Status:** Provisional identity. The name has not been cleared for trademark use. Do not treat this document as a legal availability opinion.

## Brand foundation

- **Working name:** Aether Quant
- **Product:** Rules-based strategy research and execution for self-directed traders, with capital kept in the user's own account.
- **Positioning:** Systematic markets, with rules people can inspect.
- **Short description:** Research, test, and run systematic strategies across supported markets.
- **Tagline:** Clear rules. Disciplined execution.
- **Personality:** Precise, calm, transparent, and technically capable.
- **Avoid:** Promises of profit, “guaranteed” outcomes, hype, unexplained AI claims, and language that implies custody or personalized financial advice.

## Logo

The working mark combines an open A-shaped frame, a horizontal rule, and a rising signal path. The frame represents the A in Aether; the line crossing it represents measured market movement and a rule that can be inspected. The mark is custom-drawn for this product in `web/public/brand/aether-quant-mark.svg` and used by the shared app and landing-page logo component.

Use the mark in its original proportions. Keep clear space at least the width of the signal endpoint around it. Do not rotate, skew, add gradients, or place it over busy artwork. Pair it with the wordmark “Aether Quant” in BDO Grotesk, semibold; retain the space between the words. Use the dark teal mark on light surfaces and the mint signal line as the accent. The dark UI may use a light mark variant when added later.

The mark was authored in this repository; that does not prove global uniqueness. No comprehensive visual trademark search has been completed.

## Color

| Role | Name | Hex |
| --- | --- | --- |
| Primary dark | Ink | `#0C1A26` |
| Primary accent | Deep teal | `#1E6B62` |
| Signal accent | Mint | `#7CF5D4` |
| Light surface | Mist | `#F5F7F7` |
| Secondary text | Slate | `#5A6874` |
| White | Paper | `#FFFFFF` |

Use ink for primary text on light surfaces and paper for text on ink. Deep teal is the main action color; mint is a restrained signal accent. Keep text contrast accessible and do not use color alone to communicate trade direction or risk.

## Typography

- **Family:** BDO Grotesk throughout the product and site (SIL Open Font License 1.1, from
  [LCTipografi/BDO-Grotesk](https://github.com/LCTipografi/BDO-Grotesk)). Self-hosted in
  `web/app/fonts/bdo-grotesk/` with its `OFL.txt`; weights 300–700.
- **No italics, anywhere.** The family has no italic and we never let the browser fake one. For
  emphasis inside a headline, drop to a lighter weight instead.
- **Display:** BDO Grotesk semibold or bold, tight but readable line spacing.
- **Body:** BDO Grotesk regular, comfortable line height.
- **Numbers and labels:** the same family; avoid switching to a different typeface for data.

## Voice and sample copy

- State what the system does and what evidence supports it.
- Explain limits alongside performance figures.
- Prefer “rules-based,” “tested,” and “user-controlled” to promotional superlatives.

Example: “Review the rules, inspect the test, and decide whether to connect your account.”

## Name and mark availability review

Checked on **16 October 2026** with public web search and the linked public trademark portals. This is an initial conflict screen, not legal clearance.

- An active site at [aetherquant.ai](https://www.aetherquant.ai/) presents “Aether Quant” as a financial technology and quantitative trading brand. It may be related to this product; ownership has not been established here.
- [MQL5 Market](https://www.mql5.com/en/market/product/193252) lists an “Aether Quant” trading robot.
- [PyPI](https://pypi.org/project/aether-quant/) lists a quantitative trading software package under the same name.
- Search results also surfaced other “Aether Quant” products and projects. The name is therefore already in public use in overlapping fields; it cannot be described as unused based on this review.
- The [USPTO trademark search](https://tmsearch.uspto.gov/) and [WIPO Global Brand Database](https://branddb.wipo.int/) are official search portals. Their interactive result sets could not be reliably queried in this pass. The India trademark portal also did not load, so no conclusion about registrations, applications, owners, or status is made for those territories.
- No formal logo-image similarity search or common-law search has been completed. The custom SVG is not certified unique or registrable.

**Recommendation:** Keep “Aether Quant” and this mark labeled as working assets until a trademark professional checks relevant classes, territories, similar spellings and pronunciations, company names, domains, app stores, and common-law uses. The exact-name uses above are a material collision signal, particularly if they are unrelated to this business.

For a distinct alternative to clear, see the [Rulynx name and logo proposal](./name-and-logo-proposal.md).

## Source assets

- Mark: `web/public/brand/aether-quant-mark.svg`
- Shared header/app logo: `web/components/ui/Logo.tsx`
- Landing header mark: `web/components/landing/SiteChrome.tsx`
