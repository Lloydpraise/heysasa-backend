alter table public.follow_up_queue
    add column if not exists media jsonb;

comment on column public.follow_up_queue.media is
    'Optional outbound WhatsApp media: {type, url, mime_type, file_name, caption}';