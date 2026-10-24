-- Security definer functions must never be callable without signing in.
-- Earlier migrations revoked these from public and authenticated but not from anon, and Supabase grants anon
-- EXECUTE by default, so anyone holding the public website key could call them (for example to schedule a
-- follow-up with any text for any business). The chat tools are for the service role only (the sasa-brain function).
-- The owner-facing ones stay open to signed-in owners and check ownership inside.
-- Trigger functions are listed too: revoking EXECUTE does not stop a trigger from firing.

revoke execute on function public.chat_tool_get_followup_plan(text, bigint, text, jsonb) from anon, public;
revoke execute on function public.chat_tool_hold_followups(text, bigint, text, jsonb) from anon, public;
revoke execute on function public.chat_tool_move_lead_stage(text, bigint, text, jsonb) from anon, public;
revoke execute on function public.chat_tool_schedule_followup(text, bigint, text, jsonb) from anon, public;

revoke execute on function public.contacts_drop_non_customer() from anon, public;
revoke execute on function public.trg_seed_chat_ai_skills() from anon, public;
revoke execute on function public.followup_ai_activate_playbook(uuid, text) from anon, public;
revoke execute on function public.mark_lead_meeting(uuid, text) from anon, public;
revoke execute on function public.schedule_lead_meeting(text, bigint, text, timestamptz, integer, text, text, text, jsonb) from anon, public;
revoke execute on function public.sync_ad_lists(text) from anon, public;

-- The dashboard calls these as a signed-in owner; the engine uses the service role.
grant execute on function public.followup_ai_activate_playbook(uuid, text) to authenticated, service_role;
grant execute on function public.mark_lead_meeting(uuid, text) to authenticated, service_role;
grant execute on function public.schedule_lead_meeting(text, bigint, text, timestamptz, integer, text, text, text, jsonb) to authenticated, service_role;
grant execute on function public.sync_ad_lists(text) to authenticated, service_role;
grant execute on function public.chat_tool_get_followup_plan(text, bigint, text, jsonb) to service_role;
grant execute on function public.chat_tool_hold_followups(text, bigint, text, jsonb) to service_role;
grant execute on function public.chat_tool_move_lead_stage(text, bigint, text, jsonb) to service_role;
grant execute on function public.chat_tool_schedule_followup(text, bigint, text, jsonb) to service_role;
