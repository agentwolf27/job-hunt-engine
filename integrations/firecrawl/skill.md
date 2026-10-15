# firecrawl

Use when the job-board APIs (Greenhouse, Ashby, Lever) don't cover a source:
- Hiring posts and news: `node plugins.mjs run firecrawl search "<query>"`. Costs 1 credit per result.
- A company whose careers page isn't on a supported ATS: give its `tracked_companies` entry in portals.yml `provider: firecrawl`. Costs about 1 to 5 credits per scan.

The free tier is 1,000 credits, one time. Prefer the ATS APIs, keep `limit` small, and never point this at linkedin.com.
