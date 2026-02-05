import React, { useState } from "react";
import { sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../firebase";
import { useToast } from "../components/toast/ToastProvider.jsx"; // Import the Toast hook

export default function ForgotPassword({ onBack }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast(); // Initialize Toast

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      showToast("Reset link sent! Please check your inbox.", "success");
    } catch (err) {
      showToast(err.message || "Failed to send reset email.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full">
      <div className="flex w-full flex-col justify-center px-4 py-12 lg:w-[45%] lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900">Reset Password</h2>
          <p className="mt-2 text-sm text-gray-500">We'll send a link to your email.</p>
          
          <form onSubmit={onSubmit} className="mt-10 space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-2">Email address</label>
              <input 
                type="email" 
                required 
                placeholder="email@example.com" 
                value={email} 
                onChange={(e) => setEmail(e.target.value)} 
                className="input-standard" 
              />
            </div>
            
            <button 
              type="submit" 
              disabled={busy} 
              className="btn-primary w-full py-2.5"
            >
              {busy ? "Sending..." : "Send Link"}
            </button>
            
            <button 
              type="button"
              onClick={onBack} 
              className="w-full text-center text-sm font-semibold text-indigo-600 mt-4 hover:text-indigo-500"
            >
              &larr; Back to login
            </button>
          </form>
        </div>
      </div>
      <div className="relative hidden w-0 flex-1 lg:block">
        <img 
          className="absolute inset-0 size-full object-cover" 
          src="https://images.unsplash.com/photo-1496917756835-20cb06e75b4e?auto=format&fit=crop&w=1908&q=80" 
          alt="Workspace" 
        />
      </div>
    </div>
  );
}