import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const digitsOf = (v: unknown) => String(v ?? '').replace(/\D/g, '')

// Where does a reply to this contact go?
//  1. a real phone number          -> the digits
//  2. a @lid social_id (no phone)  -> the LID JID (WhatsApp hides the number for
//                                     these customers; Evolution routes the JID)
//  3. a phone-JID social_id        -> its digits
// A stored "phone" equal to the LID digits is the old intake bug, not a number.
function resolveTarget(contact: { phone?: string | null; social_id?: string | null }): string | null {
  const socialId = String(contact.social_id ?? '').trim()
  const isLid = /^\d+@lid$/.test(socialId)
  const lidDigits = isLid ? digitsOf(socialId.split('@')[0]) : ''
  const phoneDigits = digitsOf(contact.phone)

  if (phoneDigits && phoneDigits !== lidDigits && phoneDigits.length >= 8 && phoneDigits.length <= 15) return phoneDigits
  if (isLid) return `${lidDigits}@lid`
  if (/^\d{8,15}@s\.whatsapp\.net$/.test(socialId)) return digitsOf(socialId.split('@')[0])
  return null
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { leadId, text, businessId } = await req.json()
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // 1. Get the customer's address
    const { data: contact } = await supabase
      .from('contacts')
      .select('phone, social_id')
      .eq('id', leadId)
      .eq('business_id', businessId)
      .single()
    if (!contact) throw new Error("Contact not found")

    const number = resolveTarget(contact)
    if (!number) throw new Error("This contact has no phone number or WhatsApp ID to send to")

    // 2. Call Evolution API
    const instanceName = `heysasa_${businessId}`
    const response = await fetch(`${Deno.env.get('EVOLUTION_API_URL')}/message/sendText/${instanceName}`, {
      method: 'POST',
      headers: {
        'apikey': Deno.env.get('EVOLUTION_API_KEY')!,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ number, text })
    })

    // The old version returned { sent: true } even when Evolution rejected the
    // message, so the dashboard showed a reply as sent that never went out.
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      return new Response(JSON.stringify({ sent: false, error: `Evolution ${response.status}: ${detail}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 502
      })
    }

    return new Response(JSON.stringify({ sent: true, to: number.includes('@') ? 'whatsapp-id' : 'phone' }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  } catch (err) {
    return new Response(JSON.stringify({ sent: false, error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400
    })
  }
})
