
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
      // Key format: job_id/segment_index/chunk_index (segmentIndex can be 'raw' or number)
      const key = `${jobId}/${segmentIndex}/${chunkIndex}`;
      await store.set(key, data);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'check_status') {
        const store = getStore({ name: "meeting-results", consistency: "strong" });
        
        // Fetch both potential states
        const summaryState = await store.get(`${jobId}_summary`, { type: "json" }) as any || { events: [] };
        const transcriptState = await store.get(`${jobId}_transcript`, { type: "json" }) as any || { events: [] };

        // Aggregate Events (Sort by timestamp)
        const allEvents = [...(summaryState.events || []), ...(transcriptState.events || [])];
        allEvents.sort((a, b) => a.timestamp - b.timestamp);

        // Determine Aggregate Status
        let overallStatus = 'PROCESSING';
        const sumDone = summaryState.status === 'COMPLETED' || summaryState.status === 'ERROR';
        const transDone = transcriptState.status === 'COMPLETED' || transcriptState.status === 'ERROR';

        // Check completion logic
        // Note: Logic depends on what tasks were actually requested. 
        // We assume if data is present it was requested.
        // If neither exists yet, we are processing.
        
        if (summaryState.status === 'COMPLETED' && transcriptState.status === 'COMPLETED') {
            overallStatus = 'COMPLETED';
        } 
        // If one failed and the other is done/failed
        else if ((sumDone && transDone) && (summaryState.status === 'ERROR' || transcriptState.status === 'ERROR')) {
            // Both finished but at least one error
             if (summaryState.status === 'ERROR' && transcriptState.status === 'ERROR') {
                 overallStatus = 'ERROR';
             } else {
                 // Partial success is treated as COMPLETED for the UI to show what we have
                 overallStatus = 'COMPLETED';
             }
        }

        // Aggregate Results
        const resultText = `${summaryState.result || ''}\n\n${transcriptState.result || ''}`.trim();

        // Aggregate Usage
        let totalInput = 0; 
        let totalOutput = 0;
        const usageDetails = [];
        
        if (summaryState.usage) {
             totalInput += summaryState.usage.totalInputTokens || 0;
             totalOutput += summaryState.usage.totalOutputTokens || 0;
             if(summaryState.usage.details) usageDetails.push(...summaryState.usage.details);
        }
        if (transcriptState.usage) {
             totalInput += transcriptState.usage.totalInputTokens || 0;
             totalOutput += transcriptState.usage.totalOutputTokens || 0;
             if(transcriptState.usage.details) usageDetails.push(...transcriptState.usage.details);
        }

        const responseData = {
            status: overallStatus,
            events: allEvents,
            result: resultText,
            usage: {
                totalInputTokens: totalInput,
                totalOutputTokens: totalOutput,
                totalTokens: totalInput + totalOutput,
                details: usageDetails
            },
            // Propagate error message if global fail
            error: overallStatus === 'ERROR' ? (summaryState.error || transcriptState.error) : undefined
        };

        return new Response(JSON.stringify(responseData), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response("Invalid Action", { status: 400, headers: corsHeaders });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};
