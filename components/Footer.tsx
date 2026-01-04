
import React from 'react';
import { Bot } from 'lucide-react';

interface FooterProps {
  onNavigate: (view: 'privacy' | 'terms') => void;
}

const Footer: React.FC<FooterProps> = ({ onNavigate }) => {
  return (
    <footer className="w-full py-12 px-8 bg-white border-t border-slate-200 mt-auto">
      <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-8">
        <div className="flex items-center gap-2 opacity-50 grayscale hover:grayscale-0 transition-all cursor-default">
          <Bot className="w-5 h-5 text-blue-600" />
          <span className="font-bold text-slate-800">MeetingGenius</span>
        </div>
        
        <div className="flex items-center gap-8 text-sm font-medium text-slate-500">
          <button onClick={() => onNavigate('privacy')} className="hover:text-blue-600 transition-colors">Privacy Policy</button>
          <button onClick={() => onNavigate('terms')} className="hover:text-blue-600 transition-colors">Terms of Service</button>
          <a href="mailto:support@meetinggenius.ai" className="hover:text-blue-600 transition-colors">Contact Support</a>
        </div>

        <div className="text-slate-400 text-xs font-medium">
          © {new Date().getFullYear()} MeetingGenius. All rights reserved.
        </div>
      </div>
      <div className="max-w-5xl mx-auto mt-8 pt-8 border-t border-slate-100 text-center">
        <p className="text-[10px] text-slate-400 leading-relaxed max-w-2xl mx-auto">
          MeetingGenius uses the Google Drive API to save your notes and transcriptions directly to your account. 
          We adhere to the Google API Services User Data Policy, including the Limited Use requirements.
        </p>
      </div>
    </footer>
  );
};

export default Footer;
