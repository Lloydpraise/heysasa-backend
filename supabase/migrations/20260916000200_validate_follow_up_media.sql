alter table public.campaign_steps
    drop constraint if exists campaign_steps_media_shape_check;

alter table public.campaign_steps
    add constraint campaign_steps_media_shape_check
    check (
        media is null
        or (
            jsonb_typeof(media) = 'object'
            and media ? 'type'
            and media->>'type' in ('image', 'video', 'audio', 'document')
            and jsonb_typeof(media->'url') = 'string'
            and media->>'url' ~ '^https?://'
        )
    );

alter table public.follow_up_queue
    drop constraint if exists follow_up_queue_media_shape_check;

alter table public.follow_up_queue
    add constraint follow_up_queue_media_shape_check
    check (
        media is null
        or (
            jsonb_typeof(media) = 'object'
            and media ? 'type'
            and media->>'type' in ('image', 'video', 'audio', 'document')
            and jsonb_typeof(media->'url') = 'string'
            and media->>'url' ~ '^https?://'
        )
    );
