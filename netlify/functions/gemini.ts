
import { getStore } from "@netlify/blobs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  try {
    const payload = await req.json();
    const { action, jobId } = payload;

    if (action === 'upload_chunk') {
      const { chunkIndex, segmentIndex, data } = payload;
      const store = getStore({ name: "meeting-uploads", consistency: "strong" });
      // Key format: job_id/segment_index/chunk_index
      const key = `${jobId}/${segmentIndex}/${chunkIndex}`;
      await store.set(key, data);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'upload_raw') {
      const { data } = payload;
      const store = getStore({ name: "meeting-uploads", consistency: "strong" });
      // Store raw file separately
      const key = `${jobId}/raw`;
      await store.set(key, data);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'check_status') {
        const store = getStore({ name: "meeting-results", consistency: "strong" });
        const data = await store.get(jobId, { type: "json" });
        if (!data) return new Response(JSON.stringify({ status: 'PROCESSING' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response("Invalid Action", { status: 400, headers: corsHeaders });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};
