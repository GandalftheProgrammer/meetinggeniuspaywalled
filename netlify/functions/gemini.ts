
import { getStore } from "@netlify/blobs";

// This function handles Synchronous tasks:
// 1. Upload Chunks to Storage (Fast)
// 2. Check Status (Fast - Reads from Blob)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req: Request) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders,
    });
  }

  if (req.method !== 'POST') {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        return new Response(JSON.stringify({ error: "API_KEY not configured on server" }), { 
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
    
    const payload = await req.json();
    const { action } = payload;

    // --- ACTION 1: UPLOAD CHUNK TO STORAGE ---
    // Saves a 4MB chunk to Netlify Blobs
    if (action === 'upload_chunk') {
      const { jobId, chunkIndex, data } = payload;
      
      if (!jobId || chunkIndex === undefined || !data) {
          return new Response("Missing chunk data", { status: 400, headers: corsHeaders });
      }

      // Use a dedicated store for temporary uploads
      const store = getStore({ name: "meeting-uploads", consistency: "strong" });
      
      // Key format: job_id/chunk_index
      const key = `${jobId}/${chunkIndex}`;
      
      // Save data (Base64 string)
      await store.set(key, data);

      return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // --- ACTION 2: CHECK JOB STATUS (Polling) ---
    if (action === 'check_status') {
        const { jobId } = payload;
        if (!jobId) return new Response("Missing jobId", { status: 400, headers: corsHeaders });

        // Connect to Netlify Blobs (Results store)
        const store = getStore({ name: "meeting-results", consistency: "strong" });
        
        const data = await store.get(jobId, { type: "json" });

        if (!data) {
            // Job not finished or doesn't exist yet
            return new Response(JSON.stringify({ status: 'PROCESSING' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    return new Response("Invalid Action", { status: 400, headers: corsHeaders });

  } catch (error: any) {
    console.error('Backend Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};
