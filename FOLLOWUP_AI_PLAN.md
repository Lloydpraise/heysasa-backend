# Follow-up AI — plan (v2, 13 Oct 2026)

Goal: for every ad, the Follow-up AI figures out the whole follow-up job by itself (flow, KLT sequence, media, timing),
the owner approves it, the existing campaign + sender pipes carry it out, and the AI keeps steering each lead
(reschedule, reorder, rewrite, stop) using what the chat AI, the owner and the lead have actually said.
One objective: sell as much as possible without spamming.

Status: nothing built yet. This file replaces the earlier proposal.

---------------------------------------------------------------------------------------------------------------------

## 1. Decisions already made (from Lloyd)

- Follow-up AI becomes its own tracked, upgradable AI system (like the chat AI): own skills, own turn log, own billing.
- Billed like the chat AI (8x). Everything it does is billed.
- Campaigns stay as they are. The AI writes the content, KLT order and media into the existing campaign tables.
- Ad leads get this by default. No consent step: the owner is responsible for consent. A lead who says stop, or turns very
  negative, is caught by the feedback loop and opted out of all campaigns.
- Meta Marketing API: later. For now the ad data comes from the WhatsApp ad referral, and the owner can edit it by hand.
- Approvals: granular by default (item by item); "approve everything once" is an option. Message approval before send stays.
- Approvals will live on a Home section built last. Until then they appear on the existing ad follow-up campaigns. See HOME.md.
- Failing message: do what campaigns do today (skip, keep the reason) and ask the owner to fix it (Home).
- Missing testimonial/media: skip that step and ask the owner to add it (Home). The owner can also attach media in the campaign builder.
- Sequence length 5 to 13 content steps, chosen by the AI per ad.
- Timing has two separate controls: the exact send time (lead's active hour) and the minimum gap between messages.
- A reply pauses the lead. At the next scheduled time the AI catches up on everything first, then decides.

---------------------------------------------------------------------------------------------------------------------

## 2. What already exists and gets reused

| Existing pipe | Where | How we use it |
|---|---|---|
| Ad capture (headline, body, thumbnail, ad id) | `src/services/dbService.js` `recordAdAttribution`, tables `ad_attributions`, `contacts.ad_*` | Trigger for ad intake |
| One list per ad | `sync_ad_lists()` | The ad campaign targets the ad's list |
| Chat flow (trigger by ad_id, goal, instructions, skill_keys) | `chat_flows`, `sasa-brain/core/flows.ts` | The AI writes one per ad |
| Campaign tables | `campaigns`, `campaign_steps` (content, media, delay_hours), `campaign_enrollments` | The AI writes steps here. No new campaign engine |
| Campaign scheduler, worker, sender, antiban, daily cap, quiet hours | `campaignScheduler.js`, `worker.js`, `sender-baileys/*` | Unchanged transport. We only choose `next_send_at` and add a pre-send director |
| Rewrite + QC | `rewriteSuggestedMessage`, `lib/qc.js`, `followup_qc` prompt | Extended, not replaced |
| Review before send | `campaigns.auto_approve=false`, `follow_up_queue.approval_status` | Unchanged |
| Reply intent, opt-out | `campaignReplyIntentClassifier.js`, `optInClassifier.js`, `contacts.do_not_contact` | Feeds the feedback loop |
| Activity patterns | `contact_activity_patterns.active_hours`, `contacts.optimal_contact_hour` | Send-time choice |
| Testimonials / tips / offers | `followup_materials` (+ `image_url`) | Content and media source |
| Media upload | `campaignMediaService.js` → bucket `customer_images` | Owner attaches media |
| KLT labels and colours | `constants/followupSequence.js` (`KLT_CONFIG`) | Badges on steps |
| Billing runners | `billing_runners`, `bill_ai_usage`, `chatAi/billing.js` pattern | New runner `followup_ai` |
| Propose-and-approve pattern | `businessAi/agent/domains/chatai.js` `save_flow` | Same shape for the AI's proposals |
| Prompts editable from admin | `src/aiPromptCatalog.js` + `ai_bots_config` | New prompts live here |

The old 11-step sequence is not used by the engine. It stays a UI constant; the Follow-up AI replaces it for ad leads.

---------------------------------------------------------------------------------------------------------------------

## 3. The Follow-up AI system

Lives in the follow-up engine as its own folder, so it is not buried in someone's code.

```
followup-engine/src/followupAi/
  index.js          registers the loops (intake, author, director)
  adIntake.js       finds new or edited ads, validates the data, copies the image to our storage
  playbookAuthor.js writes the flow + the 5-13 steps + media choice for one ad
  director.js       before each send: catch up, check relevance, decide
  sendWindow.js     picks the exact send time and enforces the minimum gap
  leadTimeline.js   one shared view of a lead: who said what, what was promised, what changed
  skills.js         loads the right skill(s) for the step / situation
  qc.js             service floor + relevance check (wraps lib/qc.js)
  feedback.js       reads replies to follow-ups, opts out, produces health numbers
  billing.js        runner followup_ai
```

### Its four jobs

**A. Author the playbook (once per ad, again when the ad is edited)**
Input: effective ad (headline, body, image) + business persona pack + products + materials + business-level lessons.
Output, as staged items (not live yet):
1. A chat flow: goal and specific instructions for leads from this ad, with `skill_keys`, trigger `{ad_ids:[ad]}`.
2. 5 to 13 campaign steps. Each has: KLT phase, touchpoint type, message brief, desired gap (hours), media choice.
   Length depends on the offer (price, complexity, buying cycle). The skill `sequence_designer` sets the rules.
3. Media for each step in this order: real item from `followup_materials` (testimonial image etc.) → the ad's own image →
   nothing. A proof step with no real testimonial is marked `needs_media` and skipped until the owner adds one.
Nothing invented: no testimonials, prices or offers that are not in the ad, products or materials.

**B. Schedule smartly (reusing campaign scheduling)**
Sets `campaign_enrollments.next_send_at`. See section 5.

**C. Direct each send (catch up, relevance, reorder)**
Runs inside the worker right before a due campaign item is made ready. See section 6.

**D. Close the feedback loop**
Reads what leads do after each follow-up and writes it back so the system can show it is working. See section 8.

---------------------------------------------------------------------------------------------------------------------

## 4. Ad data: make sure it exists, let the owner fix it

What the WhatsApp referral gives us: `title` (headline), `body` (primary text), `thumbnailUrl`, `sourceId`, `sourceUrl`.
What I found:
- The Analytics → Ads section and the Lists screens already render thumbnail, headline and body when they exist. If they look
  empty, the data is probably missing in `ad_attributions` / `contacts`, not missing in the UI. We need to check real rows.
- Thumbnail URLs from Meta are usually signed and expire, and the thumbnail is small. Storing only the URL will rot.

Plan:
1. `adIntake.js` runs when `recordAdAttribution` sees a new ad id (and on a poll for edits). It checks headline, body and image:
   - missing or very short body/headline → flag `data_quality: weak` on the ad.
   - image: download once and copy to Supabase Storage (`customer_images`, folder `<business>/ads/`), keep the original URL too.
2. New table `ad_playbooks` (one per business + ad) holds: auto values, owner overrides (`override_headline`, `override_body`),
   `images` (the WhatsApp thumbnail + any uploaded creatives, with `chosen_image`), status, linked `flow_id` / `campaign_id`, version.
   Effective value = override if set, else auto.
3. Frontend: an Ad editor (Analytics → Ads detail and the ad list's drawer): edit headline and body, upload images, choose which
   image is used, see a "data quality" badge. Saving marks the playbook for regeneration.
4. Regeneration rule: steps that have not been sent to anyone are rewritten. Steps already sent stay as sent. The owner sees what changed
   and approves it (granular by default).

---------------------------------------------------------------------------------------------------------------------

## 5. Scheduling: two timings

**Exact send time** — when the lead is most likely to be reading.
1. Lead's own active hours (`contact_activity_patterns.active_hours`, business timezone).
2. If the lead has fewer than ~5 inbound messages (most new ad leads), use the business's busiest inbound hours (last 60 days).
   Their first message time is also a hint: that is when they were on their phone.
3. If neither exists, the business default hour.
Then clamp: active days, quiet hours, and the daily cap (a full day pushes the send to the next day's window).
Add jitter (random minutes) and a no-repeat rule: a new send must differ from the previous send's clock time by at least 60 minutes,
so a lead never gets 12:00, 12:00, 12:00 for 13 days. When the lead has one active hour only, the AI moves within +/- 1-2 hours.

**Minimum gap** — protects from spam whatever the active hour is.
- Effective gap = max(step's desired gap, business minimum gap). Business minimum gap is a new setting for all leads
  (default suggestion: 20 hours; editable in Preferences → Follow-up).
- The step's desired gap comes from its KLT phase (Know/Like are tighter, Trust/Convert are wider) and the AI can stretch it.

**First step** — only after the lead has been quiet for a while (the chat AI is the one working a live chat). Default suggestion: 12 hours
of silence from the lead and from the owner. Editable.

The scheduler stores `next_send_at` plus a short `schedule_reason` on the enrollment, so "why Thursday 12:10" can be shown.

Where it plugs in:
- `campaignScheduler.js` seeds enrollments with `next_send_at: null` (due immediately). For AI-managed campaigns the AI sets the time right after seeding.
- `postSend.js` currently sets `next_send_at = now + delay_hours`. For AI-managed campaigns it calls `sendWindow.scheduleNext()` instead.

---------------------------------------------------------------------------------------------------------------------

## 6. The director: what happens at the scheduled time

Trigger: a due campaign item for an AI-managed campaign (inside `worker.js`, before the item is made ready).

1. Build the lead timeline (section 7) since the last follow-up we sent.
2. Cheap path first: nothing happened since the step was written (no inbound, no owner or chat AI message, stage and intent unchanged)
   → run QC only and send. No extra model call. This keeps unit economics sane.
3. Otherwise one model call with the `director` skill and the timeline. It must answer: is this step still relevant?
   - `send` as written
   - `rewrite` (the point is right, the wording must reflect what happened)
   - `reorder` (pick a better remaining step for this lead, e.g. intent rose → testimonial or offer instead of "follow us" or founder story)
   - `reschedule` (lead active now, chat in progress, owner chatting, handoff open → move to the next suitable slot; never a permanent skip)
   - `skip_step` (no longer makes sense)
   - `stop` (won, lost, opt-out, strongly negative → also triggers opt-out when the lead asked to stop)
4. Whatever it decides goes through QC (section 9), then the normal approval and sender path.
5. Every decision is written to `followup_ai_turns` with its reason, tokens and cost.

Reorder is per lead: `campaign_enrollments.next_step_override` points the scheduler at a different remaining step. The campaign's steps are not changed.

---------------------------------------------------------------------------------------------------------------------

## 7. Chat AI and Follow-up AI share one picture of the lead

Problem today: the follow-up thread is formatted as "Business" / "Customer" only, so it cannot tell the owner, the chat AI and its own
messages apart. The chat AI sees follow-ups only as "[automatic follow-up]" lines.

Fix:
1. `leadTimeline.js` (engine) builds one ordered view with roles: customer, owner (`human`), chat AI (`chat_ai`), follow-up AI (`follow_up_ai`),
   plus follow-up queue events (sent, cancelled because the lead replied, skipped and why), handoffs, stage, intent, objections, last activity.
   It also computes "since the last follow-up": new messages by who, intent and stage change, anything promised (price, offer, appointment) by the
   owner or chat AI so the follow-up honours it.
2. New table `lead_ai_state` (one row per lead): last actor, the follow-up AI's plan ("next: testimonial, Thu 12:10"), a short summary of what the chat AI
   and the owner agreed with the lead, `hold_followups_until` + reason, and updated-by.
3. Chat AI side (`sasa-brain`): reads `lead_ai_state` into the customer file, so it knows what is coming and does not contradict it, and gets a
   `hold_followups` tool (write phase) for cases like "lead said call me tomorrow". The follow-up AI must respect the hold.
4. Owner chatting in the app counts as activity: the director reschedules instead of sending into a live chat.

---------------------------------------------------------------------------------------------------------------------

## 8. Replies, feedback loop and opt-out

Today a reply cancels pending queue items (`cancelPendingFollowUps` in `webhookHandler.js`).
From reading the code I think this leaves the enrollment due, so the campaign scheduler may re-queue the same step on its next tick and the worker then
skips it as `lead_recently_active` until two hours pass. That would be row churn rather than a clean pause. I have not run it; it needs a test before we change it.

Plan: for AI-managed campaigns a reply pauses the enrollment (keeps its schedule, writes a `last_reply_at` and the reply's intent), nothing is re-queued, and the
director does the catch-up at the scheduled time (section 6).

Feedback loop (`feedback.js`):
- Reuse `campaignReplyIntentClassifier` on replies to follow-ups (action / positive / neutral / negative / opt_out).
- Stop, equivalent, or strongly negative → opt out of all campaigns (existing `do_not_contact` + exit enrollments) and log why.
  The follow-up AI can also trigger this itself from the director.
- Health numbers per ad and per step: sent, read, replied, action, opt-out, negative, qc_failed, skipped, rescheduled, and the director's decision mix.
  This is how we know it works, and what Home will show.

---------------------------------------------------------------------------------------------------------------------

## 9. QC: three layers

1. **Existing rules** (`followup_qc`): length, language, competitor, price accuracy, no repeat, no spam, one CTA, appropriate.
2. **Customer-service floor** (new, same for every business, voice cannot override it). Draft rules, for Lloyd to edit:
   1. Responds to or moves forward what the lead last said; never ignores it.
   2. One clear, low-effort next step.
   3. No pressure, false urgency, false scarcity or guilt.
   4. Facts only from the ad, products, materials or the chat. No invented prices, discounts, results or testimonials.
   5. Respects history: does not re-introduce, repeat what the chat AI or owner already said, or contradict a promise made.
   6. Respectful and human: no begging, no shouting, matches the lead's language.
   7. Does not claim actions that did not happen.
   8. Easy exit: honours stop requests instantly; the final step offers a graceful exit.
   Voice wins whenever it passes the floor; the floor wins when they conflict (the owner who writes curtly still gets polite follow-ups).
3. **Relevance** (director): is this still the right message for this lead now.
Failure behaviour: same as campaigns today (row marked skipped with `qc_failed` and the issues kept). The owner is asked to fix it on Home.
The same floor check also scores the persona pack at generation time, so a pack that mirrors a bad chat style is caught early.

---------------------------------------------------------------------------------------------------------------------

## 10. Skills (tracked and upgradable, injected only when needed)

Tables `followup_ai_default_skills` (ours) and `followup_ai_skills` (per business copy), same shape as chat skills.
The director and the author load only the skills a step needs, which keeps prompts short and results consistent.

Starting library:
- `sequence_designer` — picks 5 to 13 steps for an ad (by price, complexity, ad type), KLT order, at least one proof step, no wasted steps
- `ad_first_touch` (Know) — continues from the exact ad; if the chat AI already talked, builds on it
- `social_proof` (Know/Like) — real testimonials only, media attached
- `value_tip` (Like) — one useful tip, no pitch
- `objection_reopen` (Like/Trust) — uses the lead's recorded objections
- `founder_story` and `expert_authority` (Trust)
- `soft_checkin` (Trust)
- `offer_or_close` (Trust/Convert) — only offers that exist
- `honest_scarcity` (Trust/Convert) — only real stock or deadlines
- `final_offer` and `graceful_exit` (Convert)
- `reengage_after_chat` — lead chatted with the chat AI or owner, then went silent
- `hot_lead_accelerator` — intent rising: proof or offer first
- `cold_lead_gentle` — intent falling: lighter, lower-pressure touches
- `director` — the catch-up and decide rules
- `media_picker` — which real media fits which step
- `scheduling_rules` — gap, active hours, no-repeat time

---------------------------------------------------------------------------------------------------------------------

## 11. Billing and tracking

- New runner `followup_ai` in `billing_runners` with its own multiplier key (default 8x, same place `ai_multiplier_chat` is set), editable in /admin.
- Every model call (author, director, QC, classifier) is billed, passing `purpose` so it shows under the right runner.
  Finding: today the follow-up AI's rewrite and QC calls do not pass `purpose`, so `callBot` bills them as `unspecified`. Needs a look at what multiplier that gets.
- Playbook generation is billed per ad (and per edit). Director only calls the model when something changed (section 6).
- `followup_ai_turns` logs each decision: kind, input digest, decision, reason, tokens, cost, QC result, outcome. Same idea as `chat_ai_turns`.
- The `heysasa` business type stays free, like chat.

---------------------------------------------------------------------------------------------------------------------

## 12. Data model (one migration: `20261013000000_followup_ai.sql`)

New tables
- `followup_ai_default_skills`, `followup_ai_skills`
- `ad_playbooks` (ad data + overrides + images + status + links + version)
- `ad_playbook_items` (staged flow and steps: kind, step number, KLT phase, touchpoint type, content, media, gap, status draft/approved/rejected/needs_media, qc notes)
- `lead_ai_state`
- `followup_ai_turns`

New columns
- `campaigns`: `ai_managed`, `ad_id`, `flow_id`, `playbook_id`, `min_gap_hours` (override)
- `campaign_steps`: `touchpoint_type`, `klt_phase`, `playbook_item_id`
- `campaign_enrollments`: `next_step_override`, `schedule_reason`, `last_reply_at`, `last_director_at`
- `businesses`: `followup_min_gap_hours`, `followup_ai_scheduling` (off | draft | auto), `followup_approval_default` (granular | all)
- `billing_runners`: row `followup_ai`

Approving an item copies it to the live tables (`chat_flows`, `campaign_steps`). Existing campaigns without `ai_managed` behave exactly as today.

---------------------------------------------------------------------------------------------------------------------

## 13. Frontend (`heysasareact`)

- Ad editor (Analytics → Ads, and the ad list drawer): headline, body, image options, data-quality badge, "regenerate follow-ups".
- Ad follow-up campaign view: the staged playbook with approve / edit / reject per item, "approve all", the flow shown as one item, needs-media slots
  with upload (`uploadCampaignImage`) or pick from materials, KLT badges (`KLT_CONFIG`), schedule reason per lead, director decisions in `CampaignActivityLog`.
- Preferences → Follow-up: minimum gap, AI scheduling mode, default approval style.
- Home (last): everything in HOME.md.

---------------------------------------------------------------------------------------------------------------------

## 14. Build order (each phase is shippable)

0. Verify and fix basics: check real `ad_attributions` rows for headline/body/thumbnail; test the reply/requeue behaviour; confirm the `unspecified` billing runner.
1. Foundations: migration, runner and billing, skills tables + seed, `followupAi` skeleton, `leadTimeline`, `lead_ai_state`, `followup_ai_turns`.
2. Scheduler + director on today's ad campaigns (the 3-step preset already exists). Biggest win for the least new surface.
3. Ad intake + playbook author + staged items + per-item approval in the campaign view.
4. Ad editor and regeneration.
5. Feedback loop, opt-out, health numbers.
6. Chat AI side: reads `lead_ai_state`, `hold_followups` tool; later a QC reviewer for chat turns.
7. Home.

When code is delivered, each file will come with its folder and whether it is new or a replacement.

---------------------------------------------------------------------------------------------------------------------

## 15. Things I assumed and need Lloyd to confirm

1. Sequence cap: the worker stalls a lead at `followup_max_per_lead` (default 12) and `follow_up_count` is lifetime per lead and counts campaign sends, so a 13-step
   sequence can never fully send, and a lead who got earlier follow-ups has fewer left. Options: raise the default to 13+, or exempt AI-managed ad campaigns and count per campaign.
2. After an ad edit, only unsent steps are rewritten (steps already sent to some leads stay).
3. Defaults: business minimum gap 20h, first step after 12h of silence, no-repeat clock-time window 60 min.
4. "Yes" on the scheduling-zone question is read as: a new setting for AI scheduling (off / draft / auto), separate from the age-based zones.
5. Opt-out from the AI = existing `do_not_contact` (stops all follow-ups, not only campaigns). Say if you want campaign-only.
6. Director and author model: same default as chat (`gpt-5-mini`, low effort), configurable per business.
7. The sentiment gate in `worker.js` compares `sentiment_score` to the strings 'aggressive'/'negative' while the analyser writes numbers from -1 to 1. I could not confirm
   which one `messages.sentiment_score` really holds. If it is numeric the gate never fires; this needs a check.
