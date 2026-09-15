alter table public.campaigns
    add column if not exists completed_at timestamptz;

create or replace function public.complete_campaign_if_finished(target_campaign_id uuid)
returns boolean
language plpgsql
as $$
begin
    update public.campaigns
       set status = 'completed',
           completed_at = coalesce(completed_at, now())
     where id = target_campaign_id
       and status = 'active'
       and not exists (
           select 1
             from public.campaign_enrollments
            where campaign_id = target_campaign_id
              and status in ('pending', 'active', 'awaiting_opt_in')
       );

    return found;
end;
$$;

update public.campaigns c
     set status = 'completed',
             completed_at = now()
 where c.status = 'active'
     and exists (
             select 1
                 from public.campaign_enrollments ce
                where ce.campaign_id = c.id
                    and ce.status = 'completed'
     )
     and not exists (
             select 1
                 from public.campaign_enrollments ce
                where ce.campaign_id = c.id
                    and ce.status in ('pending', 'active', 'awaiting_opt_in')
     );

create or replace function public.reopen_completed_campaign()
returns trigger
language plpgsql
as $$
begin
    if old.status = 'completed' and new.status = 'completed' then
        new.status := 'active';
        new.completed_at := null;
    elsif new.status <> 'completed' then
        new.completed_at := null;
    end if;

    return new;
end;
$$;

drop trigger if exists campaigns_reopen_completed on public.campaigns;
create trigger campaigns_reopen_completed
before update on public.campaigns
for each row
execute function public.reopen_completed_campaign();

create or replace function public.reopen_campaign_after_step_change()
returns trigger
language plpgsql
as $$
begin
    update public.campaigns
       set status = 'active',
           completed_at = null
     where id = coalesce(new.campaign_id, old.campaign_id)
       and status = 'completed';

    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

drop trigger if exists campaign_steps_reopen_completed on public.campaign_steps;
create trigger campaign_steps_reopen_completed
after insert or update or delete on public.campaign_steps
for each row
execute function public.reopen_campaign_after_step_change();