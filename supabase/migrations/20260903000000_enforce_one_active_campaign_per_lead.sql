create or replace function public.enforce_one_active_campaign_per_lead()
returns trigger
language plpgsql
as $$
declare
    conflict_campaign_id uuid;
begin
    if new.status not in ('pending', 'active', 'awaiting_opt_in') then
        return new;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(new.lead_id::text, 0));

    select ce.campaign_id
      into conflict_campaign_id
      from public.campaign_enrollments ce
      join public.campaigns c on c.id = ce.campaign_id
     where ce.lead_id = new.lead_id
    and ce.status in ('pending', 'active', 'awaiting_opt_in')
       and c.status = 'active'
       and ce.campaign_id <> new.campaign_id
     limit 1;

    if conflict_campaign_id is not null then
        raise exception 'lead % is already enrolled in active campaign %', new.lead_id, conflict_campaign_id
            using errcode = 'P0001',
                  detail = 'A lead may only belong to one active campaign at a time.';
    end if;

    return new;
end;
$$;

create or replace function public.enforce_active_campaign_has_no_conflicting_leads()
returns trigger
language plpgsql
as $$
declare
    enrolled_lead_id bigint;
    conflict_campaign_id uuid;
begin
    if new.status <> 'active' or old.status = 'active' then
        return new;
    end if;

    for enrolled_lead_id in
        select lead_id
          from public.campaign_enrollments
                 where campaign_id = new.id
                     and status in ('pending', 'active', 'awaiting_opt_in')
         order by lead_id
    loop
        perform pg_advisory_xact_lock(hashtextextended(enrolled_lead_id::text, 0));

        select ce.campaign_id
          into conflict_campaign_id
          from public.campaign_enrollments ce
          join public.campaigns c on c.id = ce.campaign_id
         where ce.lead_id = enrolled_lead_id
           and ce.status in ('pending', 'active', 'awaiting_opt_in')
           and c.status = 'active'
           and ce.campaign_id <> new.id
         limit 1;

        if conflict_campaign_id is not null then
            raise exception 'lead % is already enrolled in active campaign %', enrolled_lead_id, conflict_campaign_id
                using errcode = 'P0001',
                      detail = 'A lead may only belong to one active campaign at a time.';
        end if;
    end loop;

    return new;
end;
$$;

drop trigger if exists campaign_enrollments_one_active_campaign on public.campaign_enrollments;
create trigger campaign_enrollments_one_active_campaign
before insert or update of lead_id, campaign_id, status
on public.campaign_enrollments
for each row
execute function public.enforce_one_active_campaign_per_lead();

drop trigger if exists campaigns_one_active_campaign_per_lead on public.campaigns;
create constraint trigger campaigns_one_active_campaign_per_lead
after update of status
on public.campaigns
deferrable initially immediate
for each row
execute function public.enforce_active_campaign_has_no_conflicting_leads();
