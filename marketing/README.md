# Elite Detailing — Marketing System

Everything marketing-related for Elite Detailing lives under this `marketing/` folder and the agents in `.claude/agents/`. This file is the one-stop overview.

## What's running automatically (no action needed)
- **Daily Video Ideas** — every day, a new thread with 2 video ideas to film and post that day. Saved to `marketing/daily-ideas/<date>.md`.
- **Weekly Ad Scripts** — every Monday, a new thread with 2 researched ad scripts (ceramic coating + detailing). Saved to `marketing/ad-scripts/<date>.md`.

Both send a push notification when ready. Both check their own history first so they don't repeat themselves.

## Files in this folder
- `business-facts.md` — the single source of truth for real business facts (services, pricing, warranty, location, reviews, contact info). Every agent reads this before writing anything, so content uses real numbers instead of made-up ones. **Update this file whenever prices/offers/facts change.**
- `daily-ideas/` — one file per day of video ideas (auto-generated)
- `ad-scripts/` — one file per week of ad scripts (auto-generated)
- `weekly-plans/` — earlier full weekly content-calendar plans (from before the system was split into daily + weekly)

## Agents (in `.claude/agents/`) — invoke any of these anytime by name
- `daily-video-idea` — today's 2 video ideas (runs automatically, can also be asked for on demand)
- `ad-script-researcher` — this week's 2 ad scripts, research-backed (runs automatically, can also be asked for on demand)
- `weekly-video-planner` — a full week's content calendar (5+ videos), for when you want more than just daily ideas
- `social-post-writer` — a one-off caption/post for something specific
- `review-responder` — replies to a customer review, or a review-request message
- `promo-campaign-planner` — a new promo/offer idea and structure
- `email-sms-copywriter` — email or SMS marketing copy
- `seo-content-writer` — website/blog copy

## Current focus
Content is scoped to **car detailing and ceramic coating only**. The business also offers PPF, window tint, wraps, marine/aircraft detailing, and fleet/executive services (see `business-facts.md`) — those are out of scope for marketing content unless you ask to include them.

## Open items needing your input
- Detailing package prices (not public on the site — ceramic coating prices are confirmed in `business-facts.md`)
- Any active promo/offer you want featured
