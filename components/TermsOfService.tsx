
import React from 'react';
import { ArrowLeft, Scale } from 'lucide-react';

interface TermsOfServiceProps {
  onBack: () => void;
}

const TermsOfService: React.FC<TermsOfServiceProps> = ({ onBack }) => {
  return (
    <div className="max-w-3xl mx-auto py-12 px-6">
      <button 
        onClick={onBack}
        className="flex items-center gap-2 text-blue-600 hover:text-blue-800 font-bold mb-8 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to App
      </button>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 md:p-12 prose prose-slate max-w-none">
        <div className="flex items-center gap-3 mb-6 not-prose">
          <Scale className="w-8 h-8 text-blue-600" />
          <h1 className="text-3xl font-bold text-slate-900 m-0">Terms of Service</h1>
        </div>

        <p className="text-slate-500 italic">Last Updated: May 20, 2024</p>

        <h2>1. Agreement to Terms</h2>
        <p>
          By accessing or using MeetingGenius, you agree to be bound by these Terms of Service. If you do not agree, you may not use the service.
        </p>

        <h2>2. Description of Service</h2>
        <p>
          MeetingGenius provides AI-driven transcription and summarization services for meetings. The quality of output depends on audio clarity and the underlying AI models provided by Google Gemini.
        </p>

        <h2>3. Recording Consent - IMPORTANT</h2>
        <p className="bg-amber-50 p-4 border-l-4 border-amber-400 font-medium">
          You are solely responsible for compliance with all local, state, and national laws regarding the recording of conversations. You must obtain consent from all participants before recording any meeting. MeetingGenius is not liable for any unauthorized recordings.
        </p>

        <h2>4. User Accounts and Subscriptions</h2>
        <ul>
          <li>Free accounts are subject to monthly usage limits as specified in the application.</li>
          <li>Pro subscriptions are billed monthly via Stripe. You can cancel at any time.</li>
          <li>You are responsible for maintaining the security of your Google account login.</li>
        </ul>

        <h2>5. Intellectual Property</h2>
        <p>
          You retain all ownership rights to the audio recordings and the generated transcriptions/notes. MeetingGenius owns the application, branding, and underlying code.
        </p>

        <h2>6. Limitation of Liability</h2>
        <p>
          MeetingGenius is provided "as is" without warranties of any kind. We are not responsible for any loss of data, inaccuracies in AI generation, or service interruptions.
        </p>

        <h2>7. Termination</h2>
        <p>
          We reserve the right to suspend or terminate your access to the service for violations of these terms, including any illegal use of the recording features.
        </p>

        <h2>8. Changes to Terms</h2>
        <p>
          We may update these terms from time to time. Continued use of the service after updates constitutes acceptance of the new terms.
        </p>
      </div>
    </div>
  );
};

export default TermsOfService;
