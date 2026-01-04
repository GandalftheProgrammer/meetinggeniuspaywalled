
import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import Footer from './components/Footer';
import PrivacyPolicy from './components/PrivacyPolicy';
import TermsOfService from './components/TermsOfService';
import { AppState, MeetingData, ProcessingMode, GeminiModel, UserProfile } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadAudioToDrive, uploadTextToDrive, disconnectDrive, ensureValidToken } from './services/driveService';
import { saveChunkToDB, deleteSessionData } from './services/db';
import { Zap, Shield, Cloud, Loader2 } from 'lucide-react';

declare const google: any;

type View = 'main' | 'privacy' | 'terms';

// Global flags to prevent double initialization outside React lifecycle
let googleInitialized = false;
let gdriveInitialized = false;

const App: React.FC = () => {
  const [view, setView] = useState<View>('main');
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-2.5-flash');
  const [lastRequestedMode, setLastRequestedMode] = useState<ProcessingMode>('NOTES_ONLY');
  
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [currentRecordingSeconds, setCurrentRecordingSeconds] = useState(0);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  
  const audioChunksRef = useRef<Blob[]>([]);
  const sessionIdRef = useRef<string>(`session_${Date.now()}`);
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [sessionStartTime, setSessionStartTime] = useState<Date | null>(null);
  const [isGoogleBusy, setIsGoogleBusy] = useState(false);

  const tokenClientRef = useRef<any>(null);

  const addLog = (msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString('en-GB')} - ${msg}`]);
  };

  const fetchUserProfile = async (email: string, uid: string) => {
    try {
      const res = await fetch('/.netlify/functions/get-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, uid })
      });
      const profile = await res.json();
      setUser(profile);
      localStorage.setItem('mg_logged_in', 'true');
      localStorage.setItem('mg_last_email', email);
      
      // Auto-reconnect Drive if it was previously active
      if (localStorage.getItem('drive_sticky_connection') === 'true') {
        connectToDrive(email);
      }
    } catch (err) {
      console.error("Profile sync error:", err);
    } finally {
      setIsInitialLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const page = params.get('p');
    const stripeSessionId = params.get('session_id');

    if (page === 'privacy') setView('privacy');
    if (page === 'terms') setView('terms');

    // Safety fallback for loading screen (max 4 seconds)
    const loadingTimeout = setTimeout(() => {
      setIsInitialLoading(false);
    }, 4000);

    const handleCredentialResponse = async (response: any) => {
      const decoded = JSON.parse(atob(response.credential.split('.')[1]));
      fetchUserProfile(decoded.email, decoded.sub);
      setIsGoogleBusy(false);
      clearTimeout(loadingTimeout);
    };

    const CLIENT_ID = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID;

    const setupGoogle = () => {
      if (!(window as any).google || googleInitialized) return;
      
      try {
        google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: handleCredentialResponse,
          auto_select: true,
          use_fedcm_for_prompt: false
        });
        
        tokenClientRef.current = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: 'email profile openid',
          callback: async (tokenResponse: any) => {
            if (tokenResponse.access_token) {
              const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
              }).then(r => r.json());
              fetchUserProfile(info.email, info.sub);
            }
            setIsGoogleBusy(false);
          },
        });

        googleInitialized = true;
        
        if (!gdriveInitialized) {
          initDrive((token) => setIsDriveConnected(!!token));
          gdriveInitialized = true;
        }

        // Handle auto-login / One Tap
        if (localStorage.getItem('mg_logged_in') === 'true') {
          google.accounts.id.prompt((notification: any) => {
            // If it's displayed, we should hide the loading screen so user sees the prompt overlay
            // If it's skipped or not displayed, hide loading so user can use the manual button
            if (notification.isDisplayed() || notification.isNotDisplayed() || notification.isSkippedMoment()) {
              setIsInitialLoading(false);
            }
          });
        } else {
          setIsInitialLoading(false);
        }

        if (stripeSessionId) {
          addLog("Syncing Pro status...");
        }
      } catch (err) {
        console.error("Google script setup error:", err);
        setIsInitialLoading(false);
      }
    };

    const checkInterval = setInterval(() => {
      if ((window as any).google) {
        setupGoogle();
        clearInterval(checkInterval);
      }
    }, 300);

    return () => {
      clearInterval(checkInterval);
      clearTimeout(loadingTimeout);
    };
  }, []);

  const handleLogin = () => {
    if (isGoogleBusy) return;
    setIsGoogleBusy(true);

    const timeout = setTimeout(() => setIsGoogleBusy(false), 2500);

    try {
      if (tokenClientRef.current) {
        tokenClientRef.current.requestAccessToken({
          hint: localStorage.getItem('mg_last_email') || ''
        });
      } else if ((window as any).google?.accounts?.id) {
        google.accounts.id.prompt();
      } else {
        setIsGoogleBusy(false);
        clearTimeout(timeout);
      }
    } catch (e) {
      console.error("Login trigger failed:", e);
      setIsGoogleBusy(false);
      clearTimeout(timeout);
    }
  };

  const handleConnectDrive = () => {
    if (isGoogleBusy) return;
    setIsGoogleBusy(true);
    setTimeout(() => setIsGoogleBusy(false), 2000);
    connectToDrive(user?.email);
  };

  const handleLogout = () => {
    setUser(null);
    disconnectDrive();
    setIsDriveConnected(false);
    localStorage.removeItem('mg_logged_in');
    localStorage.removeItem('mg_last_email');
    addLog("Logged out.");
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    if (!combinedBlob || !user) { handleLogin(); return; }
    
    if (isDriveConnected) {
      addLog("Verifying cloud access...");
      await ensureValidToken(user.email);
    }

    setLastRequestedMode(mode);
    let finalTitle = title.trim() || "Meeting";
    setTitle(finalTitle);
    setAppState(AppState.PROCESSING);
    setError(null);

    try {
      addLog("Starting analysis...");
      const newData = await processMeetingAudio(combinedBlob, combinedBlob.type || 'audio/webm', 'ALL', selectedModel, addLog, user.uid);
      setMeetingData(newData);
      setAppState(AppState.COMPLETED);
      deleteSessionData(sessionIdRef.current).catch(() => {});
      
      if (isDriveConnected) {
        autoSyncToDrive(newData, finalTitle, combinedBlob);
      }
    } catch (apiError: any) {
      setError(apiError.message || 'Processing failed');
      setAppState(AppState.PAUSED); 
    }
  };

  const autoSyncToDrive = async (data: MeetingData, currentTitle: string, blob: Blob | null) => {
    if (!isDriveConnected) return;
    const startTime = sessionStartTime || new Date();
    const dateTimeStr = startTime.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).replace(' at', '');
    const cleanTitle = currentTitle.replace(/[()]/g, '').trim();
    const safeBaseName = `${cleanTitle} - ${dateTimeStr}`;

    addLog("Syncing to Google Drive...");

    try {
        if (blob) {
          const ext = blob.type.includes('wav') ? 'wav' : blob.type.includes('mp4') ? 'm4a' : 'webm';
          await uploadAudioToDrive(`${safeBaseName} - audio.${ext}`, blob);
        }

        if (data.summary || data.conclusions.length > 0) {
          const md = `# ${cleanTitle} notes\n*Recorded on ${dateTimeStr}*\n\n${data.summary}\n\n## Conclusions\n${data.conclusions.map(i => `- ${i}`).join('\n')}\n\n## Action Items\n${data.actionItems.map(i => `- ${i}`).join('\n')}`;
          await uploadTextToDrive(`${safeBaseName} - notes`, md, 'Notes');
        }

        if (data.transcription?.trim()) {
          const tmd = `# ${cleanTitle} transcript\n*Recorded on ${dateTimeStr}*\n\n${data.transcription}`;
          await uploadTextToDrive(`${safeBaseName} - transcript`, tmd, 'Transcripts');
        }
        addLog("Drive sync completed.");
    } catch (e: any) {
        addLog(`Drive sync error: ${e.message}`);
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
    setDebugLogs([]);
    setTitle("");
    setError(null);
    setCurrentRecordingSeconds(0);
  };

  const handleNavigate = (newView: View) => {
    setView(newView);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (isInitialLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 animate-in fade-in duration-300">
          <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
          <p className="text-slate-500 font-medium">Restoring session...</p>
        </div>
      </div>
    );
  }

  const renderMainView = () => (
    <div className="flex flex-col items-center space-y-8 animate-in fade-in duration-500">
      <div className="w-full max-w-lg space-y-2">
        <label htmlFor="title" className="block text-sm font-semibold text-slate-600 ml-1">Meeting Title</label>
        <input
          type="text"
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Meeting Title"
          className="w-full px-4 py-3 rounded-xl border border-slate-200 shadow-sm focus:ring-2 focus:ring-blue-500 outline-none"
          disabled={appState === AppState.PROCESSING || appState === AppState.RECORDING}
        />
      </div>
      <Recorder 
        appState={appState}
        onChunkReady={(c) => {
          audioChunksRef.current.push(c);
          saveChunkToDB({ sessionId: sessionIdRef.current, index: audioChunksRef.current.length, chunk: c, timestamp: Date.now() });
        }}
        onProcessAudio={handleProcessAudio}
        onDiscard={handleDiscard}
        onRecordingChange={(is) => {
          if (is) {
            if (!user) { handleLogin(); return; }
            sessionIdRef.current = `session_${Date.now()}`;
            audioChunksRef.current = [];
            setSessionStartTime(new Date());
            setAppState(AppState.RECORDING);
          } else if (appState === AppState.RECORDING) {
            setAppState(AppState.PAUSED);
            const blob = new Blob(audioChunksRef.current, { type: audioChunksRef.current[0]?.type || 'audio/webm' });
            setCombinedBlob(blob);
            setAudioUrl(URL.createObjectURL(blob));
            setCurrentRecordingSeconds(0);
          }
        }}
        onFileUpload={(f) => {
          if (!user) { handleLogin(); return; }
          audioChunksRef.current = [];
          setCombinedBlob(f);
          setAudioUrl(URL.createObjectURL(f));
          setAppState(AppState.PAUSED);
          setSessionStartTime(new Date(f.lastModified));
          if (!title) setTitle(f.name.replace(/\.[^/.]+$/, ""));
        }}
        audioUrl={audioUrl}
        debugLogs={debugLogs}
        user={user}
        onUpgrade={() => {}} 
        onLogin={handleLogin}
        onRecordingTick={setCurrentRecordingSeconds}
        isLocked={isGoogleBusy}
      />
      {appState === AppState.IDLE && (
        <div className="w-full max-w-4xl mx-auto mt-20 border-t border-slate-200 pt-16 mb-20">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 text-center">
              <Zap className="w-10 h-10 text-blue-600 mx-auto mb-4" />
              <h3 className="font-bold text-slate-800 mb-2">Instant Summaries</h3>
              <p className="text-sm text-slate-500">Record on phone or laptop to get structured notes and action items.</p>
            </div>
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 text-center">
              <Cloud className="w-10 h-10 text-green-600 mx-auto mb-4" />
              <h3 className="font-bold text-slate-800 mb-2">Drive Integration</h3>
              <p className="text-sm text-slate-500">Securely sync your transcripts and notes directly to your own Google Drive.</p>
            </div>
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 text-center">
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
        onConnectDrive={handleConnectDrive} 
        onDisconnectDrive={handleLogout}
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
            {appState !== AppState.COMPLETED ? renderMainView() : meetingData && <Results data={meetingData} title={title} onReset={handleDiscard} onGenerateMissing={() => {}} isProcessingMissing={false} isDriveConnected={isDriveConnected} onConnectDrive={handleConnectDrive} audioBlob={combinedBlob} initialMode={lastRequestedMode} sessionDateString={sessionStartTime?.toLocaleString()} />}
          </>
        ) : view === 'privacy' ? <PrivacyPolicy onBack={() => handleNavigate('main')} /> : <TermsOfService onBack={() => handleNavigate('main')} />}
      </main>
      <Footer onNavigate={handleNavigate} />
    </div>
  );
};

export default App;
