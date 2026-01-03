
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Square, Loader2, Trash2, Circle, ListChecks, FileText, Upload, AlertTriangle, Crown, Lock } from 'lucide-react';
import AudioVisualizer from './AudioVisualizer';
import { AppState, ProcessingMode, UserProfile, FREE_LIMIT_SECONDS } from '../types';

const SILENT_AUDIO_URI = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD//////////////////////////////////wAAADFMYXZjNTguNTQuAAAAAAAAAAAAAAAAJAAAAAAAAAAAASAAxIirAAAA//OEAAAAAAAAAAAAAAAAAAAAAAA';

interface RecorderProps {
  appState: AppState;
  onChunkReady: (blob: Blob) => void;
  onProcessAudio: (mode: ProcessingMode) => void;
  onDiscard: () => void;
  onRecordingChange: (isRecording: boolean) => void;
  onFileUpload: (file: File) => void;
  audioUrl: string | null;
  debugLogs: string[];
  user: UserProfile | null;
  onUpgrade: () => void;
  onLogin: () => void;
  onRecordingTick?: (seconds: number) => void;
}

type AudioSource = 'microphone' | 'system';

const Recorder: React.FC<RecorderProps> = ({ 
  appState, 
  onChunkReady, 
  onProcessAudio, 
  onDiscard,
  onRecordingChange,
  onFileUpload,
  audioUrl, 
  debugLogs,
  user,
  onUpgrade,
  onLogin,
  onRecordingTick
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioSource, setAudioSource] = useState<AudioSource>('microphone');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!navigator.mediaDevices?.getDisplayMedia || /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        setIsMobile(true);
    }
    const audio = new Audio(SILENT_AUDIO_URI);
    audio.loop = true;
    audio.volume = 0.01;
    silentAudioRef.current = audio;
    return () => {
      cleanupResources();
    };
  }, []);

  // Sync recording time to parent for live gauge
  useEffect(() => {
    if (onRecordingTick) onRecordingTick(recordingTime);
  }, [recordingTime, onRecordingTick]);

  // Usage Monitor logic - More aggressive check
  useEffect(() => {
    if (isRecording) {
      if (!user) {
        stopRecording();
        onLogin();
        return;
      }
      
      if (!user.isPro) {
        const totalUsedSoFar = user.secondsUsed + recordingTime;
        if (totalUsedSoFar >= FREE_LIMIT_SECONDS) {
          stopRecording();
          setLimitReached(true);
        }
      }
    }
  }, [recordingTime, isRecording, user, onLogin]);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [debugLogs]);

  const cleanupResources = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
    }
  };

  const getSupportedMimeType = () => {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/wav'];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return undefined;
  };

  const startRecording = async () => {
    if (!user) {
      onLogin();
      return;
    }
    
    if (limitReached && !user.isPro) return;
    
    try {
      if (silentAudioRef.current) silentAudioRef.current.play().catch(() => {});

      let finalStream: MediaStream;
      if (audioSource === 'system') {
          const displayStream = await navigator.mediaDevices.getDisplayMedia({ 
            video: true,
            audio: { echoCancellation: false } 
          });
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          audioContextRef.current = audioCtx;
          const dest = audioCtx.createMediaStreamDestination();
          audioCtx.createMediaStreamSource(displayStream).connect(dest);
          audioCtx.createMediaStreamSource(micStream).connect(dest);
          finalStream = dest.stream;
          streamRef.current = displayStream; 
      } else {
        finalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = finalStream;
      }
      
      setStream(finalStream);
      const mimeType = getSupportedMimeType();
      const mediaRecorder = new MediaRecorder(finalStream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) onChunkReady(e.data); };
      mediaRecorder.start(1000); 
      setIsRecording(true);
      onRecordingChange(true);
      const startTime = Date.now();
      timerRef.current = window.setInterval(() => { setRecordingTime(Math.floor((Date.now() - startTime) / 1000)); }, 1000);
    } catch (error) {
      alert("Microphone access denied.");
    }
  };

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      cleanupResources();
      setStream(null);
      streamRef.current = null;
      setIsRecording(false);
      onRecordingChange(false);
    }
  }, [onRecordingChange]);

  const toggleRecording = () => isRecording ? stopRecording() : startRecording();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) onFileUpload(e.target.files[0]);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isProcessing = appState === AppState.PROCESSING;
  const hasRecordedData = audioUrl !== null;

  if (isProcessing) {
    return (
      <div className="w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-8 flex flex-col items-center">
         <div className="flex flex-col items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center border border-blue-100">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            </div>
            <div className="text-center">
              <p className="text-slate-800 font-bold text-xl tracking-tight">AI Pipeline Active</p>
              <p className="text-slate-500 text-sm font-medium">Processing your meeting...</p>
            </div>
         </div>
         <div className="w-full bg-slate-900 text-slate-300 p-4 rounded-xl text-[11px] font-mono h-48 overflow-y-auto border border-slate-800 shadow-inner">
            {debugLogs.map((log, i) => (
              <div key={i} className="mb-1 border-b border-slate-800 pb-1 last:border-0 opacity-80">
                <span className="text-blue-400 mr-2">[{i+1}]</span> {log}
              </div>
            ))}
            <div ref={logsEndRef} />
         </div>
      </div>
    );
  }

  return (
    <div className="relative w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-6 md:p-8 flex flex-col items-center transition-all">
      
      {/* Login Required Overlay */}
      {!user && (
        <div className="absolute inset-0 z-30 bg-slate-50/80 backdrop-blur-[2px] rounded-2xl flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-300">
          <div className="p-4 bg-blue-50 rounded-full mb-4">
            <Lock className="w-8 h-8 text-blue-500" />
          </div>
          <h3 className="text-lg font-bold text-slate-800 mb-2">Sign in to start</h3>
          <p className="text-slate-500 text-sm mb-6 max-w-[200px]">
            Please sign in with Google to use your free 5 hours of monthly note taking.
          </p>
          <button 
            onClick={onLogin}
            className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white rounded-full font-bold shadow-md hover:bg-blue-700 transition-all"
          >
            Sign In with Google
          </button>
        </div>
      )}

      {/* Limit Reached Overlay */}
      {limitReached && user && (
        <div className="absolute inset-0 z-20 bg-white/95 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-300">
          <div className="p-4 bg-orange-50 rounded-full mb-4">
            <AlertTriangle className="w-10 h-10 text-orange-500" />
          </div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">Free Monthly Limit Reached</h3>
          <p className="text-slate-600 text-sm mb-6 max-w-xs">
            You've used your free monthly allowance. Your current recording has been saved. Upgrade for unlimited use!
          </p>
          <div className="flex flex-col gap-3 w-full">
            <button 
              onClick={onUpgrade}
              className="w-full flex items-center justify-center gap-2 py-3 px-6 bg-blue-600 text-white rounded-xl font-bold shadow-lg hover:bg-blue-700 transition-all"
            >
              <Crown className="w-5 h-5 fill-current" />
              Unlock Unlimited for €10
            </button>
            <button 
              onClick={() => {
                setLimitReached(false);
                setRecordingTime(0);
              }}
              className="text-slate-400 text-sm font-medium hover:text-slate-600"
            >
              Back to Recorder
            </button>
          </div>
        </div>
      )}

      {!isMobile && (
        <div className={`w-full mb-6 transition-opacity ${isRecording || !user ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
          <div className="flex bg-slate-100 p-1 rounded-lg w-full">
            <button onClick={() => setAudioSource('microphone')} disabled={isRecording || !user} className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-all ${audioSource === 'microphone' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Microphone</button>
            <button onClick={() => setAudioSource('system')} disabled={isRecording || !user} className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-all ${audioSource === 'system' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>System + Mic</button>
          </div>
        </div>
      )}

      <div className={`w-full h-24 mb-6 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100 overflow-hidden relative ${!user ? 'grayscale opacity-50' : ''}`}>
        {isRecording || hasRecordedData ? <AudioVisualizer stream={stream} isRecording={isRecording} /> : <div className="text-slate-400 text-sm font-medium">Ready to record</div>}
      </div>

      <div className={`text-5xl font-mono font-semibold mb-8 tracking-wider ${isRecording ? 'text-red-500' : 'text-slate-700'} ${!user ? 'opacity-30' : ''}`}>
        {formatTime(recordingTime)}
      </div>

      <div className="flex flex-col items-center justify-center w-full mb-6 gap-4">
        <button
          onClick={toggleRecording}
          disabled={!user || (limitReached && !user?.isPro)}
          className={`group flex items-center justify-center w-20 h-20 rounded-full shadow-md transition-all duration-200 focus:outline-none ${
            isRecording ? 'bg-slate-900 hover:bg-slate-800' : 'bg-red-500 hover:bg-red-600 disabled:bg-slate-300'
          }`}
        >
          {isRecording ? <Square className="w-8 h-8 text-white fill-current" /> : <Circle className="w-8 h-8 text-white fill-current" />}
        </button>
        
        {!isRecording && !hasRecordedData && user && (
            <div>
                <input type="file" accept="audio/*" ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 text-slate-500 hover:text-blue-600 text-sm font-medium transition-colors px-4 py-2 rounded-full hover:bg-blue-50">
                    <Upload className="w-4 h-4" /> Upload Audio File
                </button>
            </div>
        )}
        <p className="mt-2 text-slate-400 text-sm font-medium">
          {isRecording ? "Recording..." : !user ? "Sign in to record" : limitReached ? "Limit Reached" : hasRecordedData ? "Paused" : "Start Recording"}
        </p>
      </div>

      {!isRecording && hasRecordedData && user && (
        <div className="w-full border-t border-slate-100 pt-6 text-center">
          {audioUrl && (
            <div className="w-full bg-slate-50 p-3 rounded-xl border border-slate-200 mb-6 flex flex-col gap-2">
              <span className="text-xs font-semibold text-slate-500 ml-1 uppercase text-left">Preview</span>
              <audio controls src={audioUrl} className="w-full h-8" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 w-full mb-3">
            <button onClick={() => onProcessAudio('NOTES_ONLY')} className="flex flex-col items-center justify-center p-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-all text-blue-700 shadow-sm">
              <ListChecks className="w-5 h-5 mb-1" />
              <span className="font-bold text-sm">Summary</span>
            </button>
            <button onClick={() => onProcessAudio('TRANSCRIPT_ONLY')} className="flex flex-col items-center justify-center p-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-xl transition-all text-purple-700 shadow-sm">
              <FileText className="w-5 h-5 mb-1" />
              <span className="font-bold text-sm">Transcription</span>
            </button>
          </div>
          <button onClick={onDiscard} className="w-full py-2 px-4 rounded-lg text-sm font-medium text-red-500 hover:bg-red-50 flex items-center justify-center gap-2">
            <Trash2 className="w-4 h-4" /> Discard
          </button>
        </div>
      )}
    </div>
  );
};

export default Recorder;
