
import React from 'react';
import { CheckCircle2, Bot, ChevronDown, Crown, User as UserIcon } from 'lucide-react';
import { GeminiModel, UserProfile, FREE_LIMIT_SECONDS } from '../types';

interface HeaderProps {
  isDriveConnected: boolean;
  onConnectDrive: () => void;
  onDisconnectDrive: () => void;
  selectedModel: GeminiModel;
  onModelChange: (model: GeminiModel) => void;
  user: UserProfile | null;
  onLogin: () => void;
  onLogout: () => void;
  onUpgrade: () => void;
  currentRecordingSeconds?: number;
}

const Header: React.FC<HeaderProps> = ({ 
  isDriveConnected, 
  onConnectDrive, 
  onDisconnectDrive,
  selectedModel,
  onModelChange,
  user,
  onLogin,
  onLogout,
  onUpgrade,
  currentRecordingSeconds = 0
}) => {
  const totalUsed = (user?.secondsUsed || 0) + currentRecordingSeconds;
  const remainingSeconds = Math.max(0, FREE_LIMIT_SECONDS - totalUsed);
  const remainingPercent = (remainingSeconds / FREE_LIMIT_SECONDS) * 100;
  
  const formatRemaining = (s: number) => {
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    
    if (hours > 0) return `${hours}h ${minutes}m left`;
    if (minutes > 0) return `${minutes}m ${seconds}s left`;
    return `${seconds}s left`;
  };

  return (
    <header className="w-full py-4 md:py-6 px-4 md:px-8 bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-blue-600 shrink-0">
          <div className="p-2 bg-blue-600 rounded-lg shadow-sm">
            <Bot className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-lg md:text-2xl font-bold tracking-tight text-slate-800">
            Meeting<span className="text-blue-600">Genius</span>
          </h1>
        </div>

        <div className="flex items-center gap-2 md:gap-4 overflow-x-auto max-w-full pb-1 md:pb-0">
            {user && (
              <div className="hidden sm:flex items-center gap-3 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full">
                {user.isPro ? (
                  <div className="flex items-center gap-1.5 text-blue-700 font-bold text-xs uppercase tracking-wider">
                    <Crown className="w-3.5 h-3.5 fill-current" />
                    Pro Plan
                  </div>
                ) : (
                  <div className="flex items-center gap-2 min-w-[140px]">
                    <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden w-16">
                      <div 
                        className="h-full bg-blue-500 transition-all duration-300" 
                        style={{ width: `${remainingPercent}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-bold text-slate-500 whitespace-nowrap">
                      {formatRemaining(remainingSeconds)}
                    </span>
                  </div>
                )}
                {!user.isPro && (
                  <button 
                    onClick={onUpgrade}
                    className="text-[10px] font-bold text-white bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded-md transition-colors shadow-sm"
                  >
                    Upgrade
                  </button>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
                <div className="flex relative group shrink-0">
                    <div className="flex items-center gap-2 text-xs md:text-sm font-medium text-slate-600 bg-white px-2 md:px-3 py-1.5 rounded-full border border-slate-200 hover:border-slate-300 transition-colors shadow-sm">
                        <span className="hidden xs:inline">Model:</span>
                        <select 
                            value={selectedModel}
                            onChange={(e) => onModelChange(e.target.value as GeminiModel)}
                            className="bg-transparent outline-none text-slate-800 font-semibold cursor-pointer appearance-none pr-4 max-w-[100px] md:max-w-none text-ellipsis overflow-hidden"
                        >
                            <option value="gemini-3-pro-preview">Gemini 3 Pro</option>
                            <option value="gemini-3-flash-preview">Gemini 3 Flash</option>
                            <option value="gemini-flash-lite-latest">Gemini Flash Lite</option>
                            <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                            <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                        </select>
                        <ChevronDown className="w-3 h-3 absolute right-2 md:right-3 pointer-events-none text-slate-400" />
                    </div>
                </div>

                <button 
                    onClick={isDriveConnected ? onDisconnectDrive : onConnectDrive}
                    className={`group flex items-center gap-2 px-3 py-1.5 rounded-full text-xs md:text-sm font-medium border transition-all shadow-sm shrink-0 ${
                        isDriveConnected 
                        ? 'bg-green-50 border-green-200 text-green-700 hover:bg-red-50 hover:border-red-200 hover:text-red-600' 
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                >
                    {isDriveConnected ? <CheckCircle2 className="w-4 h-4" /> : <img src="https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" alt="GD" className="w-4 h-4" />}
                    <span className="hidden sm:inline">{isDriveConnected ? 'Connected' : 'Drive'}</span>
                </button>

                {user ? (
                   <button 
                    onClick={onLogout}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition-all border border-slate-200 text-xs md:text-sm font-bold shadow-md"
                   >
                     <UserIcon className="w-4 h-4" />
                     <span>Sign Out</span>
                   </button>
                ) : (
                  <button 
                    onClick={onLogin}
                    className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 text-white rounded-full text-xs md:text-sm font-bold shadow-md hover:bg-blue-700 transition-all"
                  >
                    <UserIcon className="w-4 h-4" />
                    <span>Sign In</span>
                  </button>
                )}
            </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
