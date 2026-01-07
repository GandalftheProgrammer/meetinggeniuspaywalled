
import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import Footer from './components/Footer';
import PrivacyPolicy from './components/PrivacyPolicy';
import TermsOfService from './components/TermsOfService';
import { AppState, MeetingData, ProcessingMode, GeminiModel, UserProfile, PipelineStep, PipelineUpdate } from './types';
import { processMeetingAudio, INITIAL_PIPELINE_STEPS, log } from './services/geminiService';
import { initDrive, connectToDrive, uploadAudioToDrive, uploadTextToDrive, disconnectDrive, checkDriveStatus, getAccessToken, ensureValidToken } from './services/driveService';
import { saveChunkToDB, getPendingSessions, getChunksForSession, cleanupOldSessions, deleteSessionData } from './services/db';
import { Zap, Shield, Cloud, Loader2 } from 'lucide-react';

declare const google: any;

type View = 'main' | 'privacy' | 'terms';

let googleInitialized = false;

const App: React.FC = () => {
  const [view, setView] = useState<View>('main');
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-2.5-flash');
  const [lastRequestedMode, setLastRequestedMode] = useState<ProcessingMode>('NOTES_ONLY');
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(() => {
    try {
      const cached = localStorage.getItem('mg_user_profile');
      return cached ? JSON.parse(cached) : null;
    } catch { return null; }
  });

  const [pendingSession, setPendingSession] = useState<{sessionId: string; title: string; duration: number; startTime: string} | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const sessionIdRef = useRef<string>(`session_${Date.now()}`);
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [isConnectingDrive, setIsConnectingDrive] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState<Date | null>(null);
  const [isGoogleBusy, setIsGoogleBusy] = useState(false);
  const [currentRecordingSeconds, setCurrentRecordingSeconds] = useState(0);
  const tokenClientRef = useRef<any>(null);

  // New Pipeline Logging State
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>(INITIAL_PIPELINE_STEPS);

  const updatePipelineStep = (update: PipelineUpdate) => {
      setPipelineSteps(prev => prev.map(step => {
          // If we are updating a specific step, update it
          if (step.id === update.stepId) {
             return { ...step, status: update.status, detail: update.detail || step.detail };
          }
          // Catch-up Logic:
          // If the incoming update says step X is processing/completed,
          // imply that all steps BEFORE X are completed (if they aren't already marked completed).
          // This fixes "missed" polls where a step finished too fast to be seen.
          if (step.id < update.stepId && step.status !== 'completed' && update.status !== 'error') {
             return { ...step, status: 'completed' };
          }
          return step;
      }));
  };

  const getAccurateAudioDuration = async (blob: Blob): Promise<number> => {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const duration = audioBuffer.duration;
      await audioCtx.close();
      return duration;
    } catch (e) {
      console.error("Audio duration decoding failed:", e);
      return 0;
    }
  };

  const checkForRecoverableSessions = async () => {
    try {
      await cleanupOldSessions();
      const pending = await getPendingSessions();
      if (pending && pending.length > 0) {
        const latest = pending[0]; 
        setPendingSession(latest);
      } else {
        setPendingSession(null);
      }
    } catch (err) {
      console.error("Recovery check failed:", err);
    }
  };

  const handleRecover = async () => {
    if (!pendingSession) return;
    try {
        setIsGoogleBusy(true); 
        const chunks = await getChunksForSession(pendingSession.sessionId);
        
        if (chunks && chunks.length > 0) {
          const type = chunks[0].type || 'audio/webm';
          const blob = new Blob(chunks, { type });
          const actualDuration = await getAccurateAudioDuration(blob);
          
          sessionIdRef.current = pendingSession.sessionId;
          audioChunksRef.current = chunks;
          setCombinedBlob(blob);
          
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          const newUrl = URL.createObjectURL(blob);
          setAudioUrl(newUrl);
          setTitle(pendingSession.title || "");
          
          if (pendingSession.startTime) {
              setSessionStartTime(new Date(pendingSession.startTime));
          }
          setCurrentRecordingSeconds(actualDuration > 0 ? Math.floor(actualDuration) : pendingSession.duration);
          
          setAppState(AppState.PAUSED);
          setPendingSession(null);
        }
    } catch (err) {
        console.error("Recovery execution failed:", err);
        setError("Failed to recover recording.");
    } finally {
        setIsGoogleBusy(false);
    }
  };

  const syncUserProfile = async (email: string, uid: string) => {
    try {
      const res = await fetch('/.netlify/functions/get-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, uid })
      });
      if (!res.ok) throw new Error("Sync failed");
      const profile = await res.json();
      setUser(profile);
      localStorage.setItem('mg_user_profile', JSON.stringify(profile));
      localStorage.setItem('mg_logged_in', 'true');
      
      if (localStorage.getItem('mg_drive_connected') === 'true' && !getAccessToken()) {
        setIsConnectingDrive(true);
        const token = await checkDriveStatus(uid);
        setIsDriveConnected(!!token);
        setIsConnectingDrive(false);
      } else if (getAccessToken()) {
        setIsDriveConnected(true);
      }
    } catch (err) { console.error("Profile sync error:", err); } 
  };

  useEffect(() => {
    checkForRecoverableSessions();
    if (user) syncUserProfile(user.email, user.uid);

    const params = new URLSearchParams(window.location.search);
    const page = params.get('p');
    if (page === 'privacy') setView('privacy');
    if (page === 'terms') setView('terms');

    const handleCredentialResponse = async (response: any) => {
      const decoded = JSON.parse(atob(response.credential.split('.')[1]));
      await syncUserProfile(decoded.email, decoded.sub);
      setIsGoogleBusy(false);
    };

    const CLIENT_ID = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID;

    const setupGoogle = () => {
      if (!(window as any).google || googleInitialized) return;
      try {
        google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: handleCredentialResponse,
          auto_select: false, 
          use_fedcm_for_prompt: true 
        });
        
        tokenClientRef.current = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: 'email profile openid',
          callback: async (tokenResponse: any) => {
            if (tokenResponse.access_token) {
              const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
              }).then(r => r.json());
              await syncUserProfile(info.email, info.sub);
            }
            setIsGoogleBusy(false);
          },
        });

        googleInitialized = true;
        if (user?.uid) initDrive(user.uid, (token) => setIsDriveConnected(!!token));
      } catch (err) {
        console.error("Google script error:", err);
      }
    };

    const checkInterval = setInterval(() => {
      if ((window as any).google) { setupGoogle(); clearInterval(checkInterval); }
    }, 100);
    return () => clearInterval(checkInterval);
  }, []);

  useEffect(() => {
    if (user?.uid && googleInitialized) {
      initDrive(user.uid, (token) => setIsDriveConnected(!!token));
    }
  }, [user?.uid]);

  const handleLogin = () => {
    if (isGoogleBusy) return;
    setIsGoogleBusy(true);
    setTimeout(() => setIsGoogleBusy(false), 8000);
    try {
      if (tokenClientRef.current) tokenClientRef.current.requestAccessToken();
      else if ((window as any).google?.accounts?.id) google.accounts.id.prompt();
    } catch (e) { setIsGoogleBusy(false); }
  };

  const handleConnectDrive = () => {
    if (isGoogleBusy || !user) return;
    connectToDrive();
  };

  const handleDisconnectDriveOnly = async () => {
    if (!user) return;
    setIsConnectingDrive(true);
    await disconnectDrive(user.uid);
    setIsDriveConnected(false);
    setIsConnectingDrive(false);
  };

  const handleLogout = () => {
    if ((window as any).google?.accounts?.id) google.accounts.id.disableAutoSelect();
    setUser(null);
    setIsDriveConnected(false);
    localStorage.removeItem('mg_logged_in');
    localStorage.removeItem('mg_user_profile');
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    if (!combinedBlob || !user) { handleLogin(); return; }
    
    setLastRequestedMode(mode);
    let finalTitle = title.trim() || "Meeting";
    setTitle(finalTitle);
    setAppState(AppState.PROCESSING);
    setError(null);
    setPipelineSteps(INITIAL_PIPELINE_STEPS); // Reset UI

    try {
      // Step 1: Input Received
      log(1, "Input Received", { title: finalTitle, blobSize: combinedBlob.size });
      updatePipelineStep({ stepId: 1, status: 'processing' });
      await new Promise(r => setTimeout(r, 600)); // Visible delay for comfort
      updatePipelineStep({ stepId: 1, status: 'completed' });

      // Build filenames
      const startTime = sessionStartTime || new Date();
      const datePart = startTime.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const hours = startTime.getHours().toString().padStart(2, '0');
      const mins = startTime.getMinutes().toString().padStart(2, '0');
      const secs = startTime.getSeconds().toString().padStart(2, '0');
      
      const timePartFilename = `${hours}h${mins}m${secs}s`;
      const timePartInternal = `${hours}:${mins}`;
      const dateTimeStrFilename = `${datePart} at ${timePartFilename}`;
      const dateTimeStrInternal = `${datePart} at ${timePartInternal}`;
      
      const cleanTitle = finalTitle.replace(/[()]/g, '').trim();

      // Step 2: Drive Backup (Conditional)
      log(2, "Secure Drive Backup", { isConnected: localStorage.getItem('mg_drive_connected') === 'true' });
      updatePipelineStep({ stepId: 2, status: 'processing' });
      if (localStorage.getItem('mg_drive_connected') === 'true') {
        try {
            const token = await ensureValidToken(user.uid);
            if (token) {
                const audioFileName = `${cleanTitle} on ${dateTimeStrFilename} - audio.m4a`;
                await uploadAudioToDrive(audioFileName, combinedBlob, user.uid);
                updatePipelineStep({ stepId: 2, status: 'completed', detail: 'Audio Secured' });
            } else {
                 updatePipelineStep({ stepId: 2, status: 'completed', detail: 'Skipped (No Token)' });
            }
        } catch (e: any) { 
            updatePipelineStep({ stepId: 2, status: 'error', detail: 'Failed' });
            console.warn("Backup failed", e);
        }
      } else {
        updatePipelineStep({ stepId: 2, status: 'completed', detail: 'Not Connected' });
      }

      // Step 3-18: Gemini Service
      const newData = await processMeetingAudio(
          combinedBlob, 
          combinedBlob.type || 'audio/webm', 
          'ALL', 
          selectedModel, 
          updatePipelineStep, // Pass the UI updater
          user.uid
      );
      
      setMeetingData(newData);
      setAppState(AppState.COMPLETED);
      syncUserProfile(user.email, user.uid);

      // Final Sync Step (UI)
      if (localStorage.getItem('mg_drive_connected') === 'true') {
        try {
            if (newData.summary || newData.conclusions.length > 0) {
              // Construct Markdown for Drive
              // We use ## for headers so the Drive Service converts them to H2
              const notesMd = `[NOTES] ${cleanTitle}\nRecorded on ${dateTimeStrInternal}\n\n## Summary\n${newData.summary}\n\n## Conclusions & Insights\n${newData.conclusions.map(i => `- ${i}`).join('\n')}\n\n## Action Points\n${newData.actionItems.map(i => `- ${i}`).join('\n')}`;
              
              await uploadTextToDrive(`${cleanTitle} on ${dateTimeStrFilename} - notes`, notesMd, 'Notes', user.uid);
            }
            if (newData.transcription?.trim()) {
              const transcriptMd = `[TRANSCRIPT] ${cleanTitle}\nRecorded on ${dateTimeStrInternal}\n\n${newData.transcription}`;
              await uploadTextToDrive(`${cleanTitle} on ${dateTimeStrFilename} - transcript`, transcriptMd, 'Transcripts', user.uid);
            }
            updatePipelineStep({ stepId: 18, status: 'completed', detail: 'Synced' });
        } catch (e: any) { 
            updatePipelineStep({ stepId: 18, status: 'error', detail: 'Sync Failed' });
        }
      } else {
          updatePipelineStep({ stepId: 18, status: 'completed', detail: 'Local Only' });
      }
      
      cleanupOldSessions();
    } catch (apiError: any) {
      setError(apiError.message || 'Processing failed');
      setAppState(AppState.PAUSED); 
    }
  };

  const handleDiscard = async () => {
    await deleteSessionData(sessionIdRef.current);
    setAppState(AppState.IDLE);
    audioChunksRef.current = [];
    setCombinedBlob(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setMeetingData(null);
    setPipelineSteps(INITIAL_PIPELINE_STEPS);
    setTitle("");
    setError(null);
    setCurrentRecordingSeconds(0);
    setSessionStartTime(null);
    setPendingSession(null);
    checkForRecoverableSessions();
  };

  const handleNavigate = (newView: View) => { setView(newView); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  const renderMainView = () => (
    <div className="flex flex-col items-center space-y-8 animate-in fade-in duration-500">
      <div className="w-full max-w-lg space-y-2">
        <label htmlFor="title" className="block text-sm font-semibold text-slate-600 ml-1">Meeting Title</label>
        <input
          type="text"
          id="title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            localStorage.setItem(`title_${sessionIdRef.current}`, e.target.value);
          }}
          placeholder="Meeting Title"
          className="w-full px-4 py-3 rounded-xl border border-slate-200 shadow-sm focus:ring-2 focus:ring-blue-500 outline-none"
          disabled={appState === AppState.PROCESSING || appState === AppState.RECORDING}
        />
      </div>
      <Recorder 
        appState={appState}
        onChunkReady={(c) => {
          audioChunksRef.current.push(c);
          const start = sessionStartTime || new Date();
          saveChunkToDB(
              { sessionId: sessionIdRef.current, index: audioChunksRef.current.length, chunk: c, timestamp: Date.now() },
              currentRecordingSeconds,
              start.toISOString()
          );
        }}
        onProcessAudio={handleProcessAudio}
        onDiscard={handleDiscard}
        onRecordingChange={(is) => {
          if (is) {
            if (!user) { handleLogin(); return; }
            if (appState !== AppState.PAUSED) {
                sessionIdRef.current = `session_${Date.now()}`;
                audioChunksRef.current = [];
                const start = new Date();
                setSessionStartTime(start);
                setCurrentRecordingSeconds(0);
            }
            setAppState(AppState.RECORDING);
          } else if (appState === AppState.RECORDING) {
            setAppState(AppState.PAUSED);
            const blob = new Blob(audioChunksRef.current, { type: audioChunksRef.current[0]?.type || 'audio/webm' });
            setCombinedBlob(blob);
            if (audioUrl) URL.revokeObjectURL(audioUrl);
            setAudioUrl(URL.createObjectURL(blob));
          }
        }}
        onFileUpload={(f) => {
          if (!user) { handleLogin(); return; }
          audioChunksRef.current = [];
          setCombinedBlob(f);
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          setAudioUrl(URL.createObjectURL(f));
          setAppState(AppState.PAUSED);
          const start = new Date(f.lastModified);
          setSessionStartTime(start);
          if (!title) setTitle(f.name.replace(/\.[^/.]+$/, ""));
        }}
        audioUrl={audioUrl}
        pipelineSteps={pipelineSteps}
        user={user}
        onUpgrade={() => {}} 
        onLogin={handleLogin}
        onRecordingTick={setCurrentRecordingSeconds}
        isLocked={isGoogleBusy}
        pendingRecovery={pendingSession}
        onRecover={handleRecover}
        recoveredSeconds={currentRecordingSeconds}
      />
      
      {appState === AppState.IDLE && (
        <div className="w-full max-w-4xl mx-auto mt-20 border-t border-slate-200 pt-16 mb-20 animate-in fade-in slide-in-from-bottom-4 duration-700">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 text-center hover:shadow-md transition-all">
              <Zap className="w-10 h-10 text-blue-600 mx-auto mb-4" />
              <h3 className="font-bold text-slate-800 mb-2">Instant Summaries</h3>
              <p className="text-sm text-slate-500">Record on phone or laptop to get structured notes and action items.</p>
            </div>
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 text-center hover:shadow-md transition-all">
              <Cloud className="w-10 h-10 text-green-600 mx-auto mb-4" />
              <h3 className="font-bold text-slate-800 mb-2">Drive Integration</h3>
              <p className="text-sm text-slate-500">Securely sync your transcripts and notes directly to your own Google Drive.</p>
            </div>
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 text-center hover:shadow-md transition-all">
              <Shield className="w-10 h-10 text-purple-600 mx-auto mb-4" />
              <h3 className="font-bold text-slate-800 mb-2">Privacy First</h3>
              <p className="text-sm text-slate-500">Your data is yours. We don’t store or sell your recordings.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header 
        isDriveConnected={isDriveConnected} 
        isConnectingDrive={isConnectingDrive}
        onConnectDrive={handleConnectDrive} 
        onDisconnectDrive={handleDisconnectDriveOnly} 
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        user={user}
        onLogin={handleLogin}
        onLogout={handleLogout}
        onUpgrade={() => {}}
        currentRecordingSeconds={currentRecordingSeconds}
        isLocked={isGoogleBusy}
      />
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-8 md:py-12">
        {view === 'main' ? (
          <>
            {error && <div className="max-w-md mx-auto mb-8 p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-center text-sm font-bold shadow-sm">{error}</div>}
            {appState !== AppState.COMPLETED ? renderMainView() : meetingData && <Results data={meetingData} title={title} onReset={() => setAppState(AppState.PAUSED)} onGenerateMissing={() => {}} isProcessingMissing={false} isDriveConnected={isDriveConnected} onConnectDrive={handleConnectDrive} audioBlob={combinedBlob} initialMode={lastRequestedMode} sessionDate={sessionStartTime} />}
          </>
        ) : view === 'privacy' ? <PrivacyPolicy onBack={() => handleNavigate('main')} /> : <TermsOfService onBack={() => handleNavigate('main')} />}
      </main>
      <Footer onNavigate={handleNavigate} />
    </div>
  );
};

export default App;
