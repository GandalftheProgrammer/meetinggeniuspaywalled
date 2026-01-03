
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { FileText, ListChecks, ArrowLeft, FileAudio, Download, Eye, CheckCircle } from 'lucide-react';
import { MeetingData, ProcessingMode } from '../types';

interface ResultsProps {
  data: MeetingData;
  title: string;
  onReset: () => void;
  onGenerateMissing: (mode: ProcessingMode) => void;
  isProcessingMissing: boolean;
  isDriveConnected: boolean;
  onConnectDrive: () => void;
  audioBlob: Blob | null;
  initialMode?: ProcessingMode;
  sessionDateString?: string;
}

const Results: React.FC<ResultsProps> = ({ 
  data, 
  title, 
  onReset, 
  audioBlob,
  initialMode = 'NOTES_ONLY',
  sessionDateString = ''
}) => {
  const [showNotes, setShowNotes] = useState(initialMode !== 'TRANSCRIPT_ONLY');
  const [showTranscript, setShowTranscript] = useState(initialMode !== 'NOTES_ONLY');

  const hasNotes = data.summary && data.summary.trim().length > 0;
  const hasTranscript = data.transcription && data.transcription.trim().length > 0;

  const cleanTitle = title.replace(/[()]/g, '').trim();
  const baseName = `${cleanTitle} on ${sessionDateString}`;

  const notesMarkdown = `
# ${cleanTitle} notes

*Recorded on ${sessionDateString}*

## Summary
${data.summary.trim() || "No summary returned."}

## Conclusions & Insights
${data.conclusions.length > 0 ? data.conclusions.map(d => `- ${d}`).join('\n') : "No conclusions recorded."}

## Action Items
${data.actionItems.length > 0 ? data.actionItems.map(item => `- [ ] ${item}`).join('\n') : "No action items identified."}
  `.trim();

  const transcriptMarkdown = `# ${cleanTitle} transcript\n\n*Recorded on ${sessionDateString}*\n\n${data.transcription.trim() || "No transcript returned."}`;

  const downloadBlob = (blob: Blob, suffix: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const extension = blob.type.includes('wav') ? 'wav' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    const fileName = `${baseName} - ${suffix}`.replace(/[/\\?%*:|"<>]/g, '-');
    link.download = `${fileName}.${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadAsDoc = (markdown: string, suffix: string) => {
    let htmlBody = markdown
      .replace(/^# (.*$)/gm, '<h1 style="color:#1e3a8a; margin-bottom:12px; font-size: 24pt;">$1</h1>')
      .replace(/^## (.*$)/gm, '<h2 style="color:#1e3a8a; margin-top:24px; margin-bottom:12px; font-size: 16pt;">$1</h2>')
      .replace(/^\*Recorded on (.*)\*$/gm, '<p style="color: #64748b; font-style: italic; margin-bottom: 20px;">Recorded on $1</p>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/- \[ \] (.*$)/gm, '<li style="margin-bottom:0;">☐ $1</li>')
      .replace(/- (.*$)/gm, '<li style="margin-bottom:0;">$1</li>');

    htmlBody = htmlBody.replace(/<\/li>\s+(?=<li)/g, '</li>');
    htmlBody = htmlBody.replace(/((?:<li[\s\S]*?<\/li>)+)/g, '<ul style="margin-top:0; margin-bottom:12px; padding-left:20px;">$1</ul>');

    const lines = htmlBody.split('\n');
    const processedLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('<h1') || trimmed.startsWith('<h2') || trimmed.startsWith('<p') || trimmed.startsWith('<ul') || trimmed.startsWith('<li') || trimmed.startsWith('</ul')) {
            return trimmed;
        }
        return `<p style="margin-bottom: 12px;">${trimmed}</p>`;
    });

    const finalHtmlBody = processedLines.filter(l => l).join('');
    const htmlContent = `<html><body style="font-family:Arial, sans-serif; color:#334155; line-height:1.6; padding:20px;">${finalHtmlBody}</body></html>`;
    const blob = new Blob(['\ufeff', htmlContent], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const fileName = `${baseName} - ${suffix}`.replace(/[/\\?%*:|"<>]/g, '-');
    link.download = `${fileName}.doc`;
    link.click();
  };

  const renderRevealButton = (type: 'notes' | 'transcript') => (
    <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4 p-8 border-2 border-dashed border-slate-100 rounded-xl bg-slate-50/50">
      <div className="p-3 bg-white rounded-full shadow-sm">
         {type === 'notes' ? <ListChecks className="w-6 h-6 text-slate-300" /> : <FileText className="w-6 h-6 text-slate-300" />}
      </div>
      <div className="text-center">
        <p className="text-slate-600 font-medium mb-3">
          {type === 'notes' ? "Summary is ready" : "Transcript is ready"}
        </p>
        <button 
          onClick={() => type === 'notes' ? setShowNotes(true) : setShowTranscript(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg text-sm font-semibold shadow-sm"
        >
          <Eye className="w-4 h-4" />
          Reveal {type === 'notes' ? "Summary" : "Transcript"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="w-full max-w-6xl mx-auto animate-in fade-in slide-in-from-bottom-8 duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <button onClick={onReset} className="flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors text-sm font-bold">
            <ArrowLeft className="w-4 h-4" />
            Back to record
          </button>
          <div className="flex items-center gap-1.5 px-3 py-1 bg-green-50 text-green-700 rounded-full text-[10px] font-bold border border-green-100 uppercase tracking-tight">
            <CheckCircle className="w-3 h-3" />
            Saved to Drive & History
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
           {audioBlob && <button onClick={() => downloadBlob(audioBlob, 'audio')} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-semibold transition-all shadow-sm"><FileAudio className="w-4 h-4" />Audio</button>}
           {hasNotes && <button onClick={() => downloadAsDoc(notesMarkdown, 'notes')} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-semibold transition-all shadow-sm"><Download className="w-4 h-4" />Notes</button>}
           {hasTranscript && <button onClick={() => downloadAsDoc(transcriptMarkdown, 'transcription')} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-semibold transition-all shadow-sm"><Download className="w-4 h-4" />Transcript</button>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-[calc(100vh-250px)] min-h-[500px]">
        <div className="flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-blue-500" />
            <h2 className="font-bold text-slate-800">Structured Notes</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {showNotes ? (
              hasNotes ? <div className="prose prose-professional prose-sm max-w-none"><ReactMarkdown>{notesMarkdown}</ReactMarkdown></div> : <p className="text-slate-400 italic">No notes data...</p>
            ) : renderRevealButton('notes')}
          </div>
        </div>

        <div className="flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
            <FileText className="w-5 h-5 text-purple-500" />
            <h2 className="font-bold text-slate-800">Full Transcription</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {showTranscript ? (
              hasTranscript ? <div className="prose prose-professional prose-sm max-w-none"><ReactMarkdown>{data.transcription}</ReactMarkdown></div> : <p className="text-slate-400 italic">No transcript data...</p>
            ) : renderRevealButton('transcript')}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Results;
