
import React from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

interface PrivacyPolicyProps {
  onBack: () => void;
}

const PrivacyPolicy: React.FC<PrivacyPolicyProps> = ({ onBack }) => {
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
          <ShieldCheck className="w-8 h-8 text-blue-600" />
          <h1 className="text-3xl font-bold text-slate-900 m-0">Privacy Policy</h1>
        </div>

        <p className="text-slate-500 italic">Last Updated: January 4, 2026</p>

        <h2>1. Introduction</h2>
        <p>
          MeetingGenius ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our AI-powered meeting assistant.
        </p>

        <h2>2. Data We Collect</h2>
        <ul>
          <li><strong>Google Account Information:</strong> When you sign in with Google, we collect your email address and basic profile information (name, profile picture) to identify your account and manage your subscription.</li>
          <li><strong>Audio Data:</strong> We collect the audio recordings you provide (via microphone or file upload) solely to generate transcriptions and notes.</li>
          <li><strong>Google Drive Access:</strong> If you choose to connect Google Drive, we request access to the <code>drive.file</code> scope, allowing us to create and update only the specific files created by MeetingGenius.</li>
        </ul>

        <h2>3. How We Process Your Data</h2>
        <p>
          Your audio data is processed using the <strong>Google Gemini API</strong>. We do not use your personal audio recordings or transcriptions to train our own AI models. The data is sent to Google's servers for temporary processing and returned to you as text.
        </p>

        <h2>4. Data Storage and Retention</h2>
        <ul>
          <li><strong>Temporary Storage:</strong> Audio chunks are stored temporarily in Netlify Blobs during the processing phase and are deleted once analysis is complete or the session is discarded.</li>
          <li><strong>Results:</strong> Transcriptions and summaries are stored in your local browser storage and, if connected, your personal Google Drive account. We do not maintain a permanent database of your meeting contents on our servers.</li>
        </ul>

        <h2>5. Third-Party Services</h2>
        <p>We use the following third-party services:</p>
        <ul>
          <li><strong>Google Cloud Platform:</strong> For Authentication, Gemini AI processing, and Google Drive integration.</li>
          <li><strong>Stripe:</strong> For processing subscription payments. We do not store your credit card details on our servers.</li>
          <li><strong>Netlify:</strong> For hosting and serverless function execution.</li>
        </ul>

        <h2>6. Your Rights</h2>
        <p>
          You have the right to access, correct, or delete your personal data. You can disconnect Google Drive or delete your account at any time within the application settings or by contacting us.
        </p>

        <h2>7. Contact Us</h2>
        <p>
          If you have questions about this Privacy Policy, please contact us at roebroek.erik@gmail.com.
        </p>
      </div>
    </div>
  );
};

export default PrivacyPolicy;
