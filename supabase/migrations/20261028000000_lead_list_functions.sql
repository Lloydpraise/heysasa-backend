-- The Leads page used to build its list from thousands of small requests: every message of the business (to work out who
-- spoke last and what still waits for a reply), and three requests per campaign-enrolled lead (one lead = enrollment,
-- campaign, last sent message). These two functions return the same facts in one query each.
-- SECURITY INVOKER (the default): row level security applies exactly as it did for the old direct queries.

create or replace function public.lead_message_stats(p_business_id text)
returns table (
  contact_id bigint,
  latest_direction text,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  unanswered_count integer
)
language sql
stable
set search_path = public
as $$
  select a.contact_id,
         a.latest_direction,
         a.last_in,
         a.last_out,
         (select count(*)::integer
            from public.messages m
           where m.contact_id = a.contact_id
             and m.direction = 'in'
             and (a.last_out is null or m.created_at > a.last_out))
    from (
      select m.contact_id,
             (array_agg(m.direction order by m.created_at desc))[1] as latest_direction,
             max(m.created_at) filter (where m.direction = 'in') as last_in,
             max(m.created_at) filter (where m.direction = 'out') as last_out
        from public.messages m
       where m.business_id = p_business_id
         and m.contact_id is not null
       group by m.contact_id
    ) a
$$;

create or replace function public.lead_campaign_enrollments(p_business_id text)
returns table (
  lead_id bigint,
  campaign_id uuid,
  campaign_name text,
  status text,
  current_step integer,
  last_message text,
  last_sent_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select distinct on (e.lead_id)
         e.lead_id,
         c.id,
         c.name,
         e.status,
         coalesce(e.current_step, 0),
         q.final_message,
         q.processed_at
    from public.campaign_enrollments e
    join public.campaigns c on c.id = e.campaign_id and c.business_id = p_business_id
    left join lateral (
      select f.final_message, f.processed_at
        from public.follow_up_queue f
       where f.business_id = p_business_id
         and f.campaign_id = e.campaign_id
         and f.contact_id = e.lead_id
         and f.status = 'sent'
       order by f.processed_at desc nulls last
       limit 1
    ) q on true
   where e.status in ('pending', 'active')
   order by e.lead_id, e.next_send_at nulls last
$$;

-- Signed-in users only (the anon role must not be able to call these).
revoke all on function public.lead_message_stats(text) from public, anon;
revoke all on function public.lead_campaign_enrollments(text) from public, anon;
grant execute on function public.lead_message_stats(text) to authenticated, service_role;
grant execute on function public.lead_campaign_enrollments(text) to authenticated, service_role;
