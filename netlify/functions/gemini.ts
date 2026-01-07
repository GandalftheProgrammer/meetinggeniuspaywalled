
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

        if (summaryState.status === 'COMPLETED' && transcriptState.status === 'COMPLETED') {
            overallStatus = 'COMPLETED';
        } 
        else if ((sumDone && transDone) && (summaryState.status === 'ERROR' || transcriptState.status === 'ERROR')) {
             if (summaryState.status === 'ERROR' && transcriptState.status === 'ERROR') {
                 overallStatus = 'ERROR';
             } else {
                 overallStatus = 'COMPLETED'; // Partial success
             }
        }

        // Aggregate Results with separator
        let resultText = summaryState.result || '';
        if (transcriptState.result) {
            // Force a separator if we have both, or if we just have transcript
            resultText += `\n\n[TRANSCRIPT]\n\n${transcriptState.result}`;
        }

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
            // Include raw output for debugging as requested
            debug: {
                rawSummary: summaryState.result,
                rawTranscript: transcriptState.result,
                summaryStatus: summaryState.status,
                transcriptStatus: transcriptState.status
            },
            error: overallStatus === 'ERROR' ? (summaryState.error || transcriptState.error) : undefined
        };

        return new Response(JSON.stringify(responseData), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response("Invalid Action", { status: 400, headers: corsHeaders });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};
