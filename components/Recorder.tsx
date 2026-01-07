
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Square, Loader2, Trash2, Circle, ListChecks, FileText, Upload, AlertTriangle, Crown, RotateCcw, CheckCircle2, Clock } from 'lucide-react';
import AudioVisualizer from './AudioVisualizer';
import { AppState, ProcessingMode, UserProfile, FREE_LIMIT_SECONDS, PipelineStep } from '../types';

const SILENT_AUDIO_URI = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD//////////////////////////////////wAAADFMYXZjNTguNTQuAAAAAAAAAAAAAAAAJAAAAAAAAAAAASAAxIirAAAA//OEAAAAAAAAAAAAAAAAAAAAAAA';

interface RecorderProps {
  appState: AppState;
  onChunkReady: (blob: Blob) => void;
  onProcessAudio: (mode: ProcessingMode) => void;
  onDiscard: () => void;
  onRecordingChange: (isRecording: boolean) => void;
  onFileUpload: (file: File) => void;
  audioUrl: string | null;
  pipelineSteps: PipelineStep[]; // CHANGED: Now receives structured steps instead of strings
  user: UserProfile | null;
  onUpgrade: () => void;
  onLogin: () => void;
  onRecordingTick?: (seconds: number) => void;
  isLocked?: boolean;
  pendingRecovery?: { sessionId: string; title: string; duration: number } | null;
  onRecover: () => void;
  recoveredSeconds?: number;
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
  pipelineSteps,
  user,
  onUpgrade,
  onLogin,
  onRecordingTick,
  isLocked = false,
  pendingRecovery,
  onRecover,
  recoveredSeconds = 0
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
  const stepsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (recoveredSeconds >= 0 && !isRecording) {
      setRecordingTime(recoveredSeconds);
    }
  }, [recoveredSeconds, isRecording]);

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

  useEffect(() => {
    if (onRecordingTick) onRecordingTick(recordingTime);
  }, [recordingTime, onRecordingTick]);

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
    if (stepsEndRef.current && appState === AppState.PROCESSING) {
        // Auto-scroll to the current active step
        const activeStep = document.querySelector('.pipeline-step-active');
        if (activeStep) {
            activeStep.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
  }, [pipelineSteps, appState]);

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
    const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac', 'audio/wav'];
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
      const startTime = Date.now() - (recordingTime * 1000);
      timerRef.current = window.setInterval(() => { setRecordingTime(Math.floor((Date.now() - startTime) / 1000)); }, 1000);
    } catch (error) {
      console.error("Recording error:", error);
      setIsRecording(false);
      onRecordingChange(false);
    }
  };

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        console.error("Stop recording failed:", e);
      }
    }
    cleanupResources();
    setStream(null);
    streamRef.current = null;
    setIsRecording(false);
    onRecordingChange(false);
  }, [onRecordingChange]);

  const toggleRecording = () => isRecording ? stopRecording() : startRecording();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!user) {
      onLogin();
      return;
    }
    if (e.target.files && e.target.files.length > 0) onFileUpload(e.target.files[0]);
  };

  const formatTime = (seconds: number) => {
    const s = isNaN(seconds) || seconds < 0 ? 0 : Math.floor(seconds);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isProcessing = appState === AppState.PROCESSING;
  const hasRecordedData = audioUrl !== null;

  if (isProcessing) {
    return (
      <div className="w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-8 flex flex-col items-center">
         <div className="flex flex-col items-center gap-4 mb-8">
            <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center border border-blue-100 relative">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
              <div className="absolute inset-0 rounded-full border-4 border-blue-100 opacity-30 animate-ping"></div>
            </div>
            <div className="text-center">
              <p className="text-slate-800 font-bold text-xl tracking-tight">Processing Meeting</p>
              <p className="text-slate-500 text-sm font-medium">Please wait while we secure and analyze your audio</p>
            </div>
         </div>
         
         <div className="w-full bg-slate-50 p-6 rounded-xl border border-slate-100 max-h-[400px] overflow-y-auto custom-scrollbar relative">
            <div className="space-y-4">
                {pipelineSteps.map((step, idx) => {
                    const isActive = step.status === 'processing';
                    const isDone = step.status === 'completed';
                    const isPending = step.status === 'pending';
                    const isError = step.status === 'error';

                    return (
                        <div 
                            key={step.id} 
                            className={`flex items-start gap-3 transition-all duration-300 ${isActive ? 'pipeline-step-active scale-[1.02]' : 'opacity-80'}`}
                        >
                            <div className="mt-0.5 shrink-0">
                                {isDone && <CheckCircle2 className="w-5 h-5 text-green-500" />}
                                {isActive && <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />}
                                {isPending && <Circle className="w-5 h-5 text-slate-300" />}
                                {isError && <AlertTriangle className="w-5 h-5 text-red-500" />}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                    <p className={`text-sm font-semibold ${isActive ? 'text-blue-700' : isDone ? 'text-slate-700' : isError ? 'text-red-600' : 'text-slate-400'}`}>
                                        {step.label}
                                    </p>
                                    {step.detail && (
                                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${isActive ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                                            {step.detail}
                                        </span>
                                    )}
                                </div>
                                {isActive && (
                                    <div className="h-1 w-full bg-slate-100 rounded-full mt-2 overflow-hidden">
                                        <div className="h-full bg-blue-500 animate-[shimmer_2s_infinite_linear] w-[40%] rounded-full relative overflow-hidden after:absolute after:inset-0 after:bg-gradient-to-r after:from-transparent after:via-white/30 after:to-transparent after:animate-[shimmer_1s_infinite]"></div>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
                <div ref={stepsEndRef} className="h-4" />
            </div>
         </div>
      </div>
    );
  }

  return (
    <div className="relative w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-6 md:p-8 flex flex-col items-center transition-all overflow-hidden">
      
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
        <div className={`w-full mb-6 transition-opacity ${isRecording ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
          <div className="flex bg-slate-100 p-1 rounded-lg w-full">
            <button onClick={() => setAudioSource('microphone')} disabled={isRecording} className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-all ${audioSource === 'microphone' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Microphone</button>
            <button onClick={() => setAudioSource('system')} disabled={isRecording} className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-all ${audioSource === 'system' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>System + Mic</button>
          </div>
        </div>
      )}

      <div className={`w-full h-24 mb-6 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100 overflow-hidden relative`}>
        {isRecording || hasRecordedData ? <AudioVisualizer stream={stream} isRecording={isRecording} /> : <div className="text-slate-400 text-sm font-medium">{isLocked ? 'Restoring Session...' : 'Ready to record'}</div>}
      </div>

      <div className={`text-5xl font-mono font-semibold mb-8 tracking-wider ${isRecording ? 'text-red-500' : 'text-slate-700'}`}>
        {formatTime(recordingTime)}
      </div>

      <div className="flex flex-col items-center justify-center w-full gap-4">
        <button
          onClick={toggleRecording}
          disabled={(limitReached && !user?.isPro) || isLocked}
          className={`group flex items-center justify-center w-20 h-20 rounded-full shadow-md transition-all duration-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
            isRecording ? 'bg-slate-900 hover:bg-slate-800' : 'bg-red-500 hover:bg-red-600 disabled:bg-slate-300'
          }`}
        >
          {isRecording ? <Square className="w-8 h-8 text-white fill-current" /> : isLocked ? <Loader2 className="w-8 h-8 text-white animate-spin" /> : <Circle className="w-8 h-8 text-white fill-current" />}
        </button>
        
        {!hasRecordedData && (
          <div className="h-[80px] flex flex-col items-center justify-center w-full">
              {!isRecording && (
                  <div className="flex flex-col items-center gap-2 animate-in fade-in duration-300">
                      <input type="file" accept="audio/*" ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
                      <button 
                        onClick={() => fileInputRef.current?.click()} 
                        disabled={isLocked}
                        className="flex items-center gap-2 text-slate-500 hover:text-blue-600 text-sm font-medium transition-colors px-4 py-1.5 rounded-full hover:bg-blue-50 disabled:opacity-50"
                      >
                          <Upload className="w-4 h-4" /> Upload Audio File
                      </button>

                      {pendingRecovery && (
                        <button 
                          onClick={onRecover} 
                          disabled={isLocked}
                          className="flex items-center gap-2 text-slate-500 hover:text-blue-600 text-sm font-medium transition-colors px-4 py-1.5 rounded-full hover:bg-blue-50 disabled:opacity-50"
                        >
                            {isLocked ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Recover Previous Recording
                        </button>
                      )}
                  </div>
              )}
          </div>
        )}
      </div>

      {!isRecording && hasRecordedData && (
        <div className="w-full border-t border-slate-100 pt-6 text-center mt-2 animate-in slide-in-from-top-2 duration-300">
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
