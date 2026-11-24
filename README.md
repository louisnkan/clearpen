# Clearpen

**AI writing and tone refinement for Nigerian students and professionals.**

Live: [clearpen.live](https://clearpen.live) · Blog: [write.clearpen.live](https://write.clearpen.live)

## The problem

Many students and young professionals in Nigeria write well in their own voice but struggle to get the tone right in formal writing: job applications, work emails, assignments. Clearpen refines a draft so it sounds clear and professional while keeping the writer's meaning.

## What it does

- Takes your draft and refines its tone for formal English
- Sign in with Google or an email one-time code
- Free tier with usage limits, plus a paid Pro plan
- ✏️ Exports your refined text as PDF (delete this line if it's not live)

## How it's built

- Frontend: single-file HTML app, deployed on Vercel
- AI: Anthropic API, called through a serverless function (`/api/refine.js`)
- Auth and database: Supabase (Google OAuth, email OTP)
- Payments: Paystack
- Protection: server-side IP rate limiting
- Analytics: Google Analytics 4, Microsoft Clarity

## Built from a phone

Clearpen was designed, coded, debugged and shipped entirely from a mobile phone, using a GitHub-to-Vercel workflow with no laptop. AI assisted with coding, debugging and prompt design.

## Status

✏️ Live and in active development. Early testers have shaped the UX.

## Author

Built by [Louis](https://github.com/louisnkan) as part of a 12-projects-in-12-months challenge, under Louis IV Studio.
