alter table if exists evolution."Message"
    add column if not exists "new" boolean not null default false;