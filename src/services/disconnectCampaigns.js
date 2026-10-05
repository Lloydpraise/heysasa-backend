export async function pauseCampaignsForDisconnectedInstance(supabase, { businessId, instanceName }) {
    const { data, error } = await supabase
        .from('campaigns')
        .update({ status: 'paused', failure_reason: 'whatsapp_disconnected', failed_at: null })
        .eq('business_id', businessId)
        .eq('whatsapp_instance_name', instanceName)
        .eq('status', 'active')
        .select('id');

    if (error) throw error;
    return data ?? [];
}
