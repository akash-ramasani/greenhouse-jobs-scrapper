import React, { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx"; // Import the Toast hook

export default function Login({ onSwitch, onForgot }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const { showToast } = useToast(); // Using the showToast hook

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      showToast("Logged in successfully!", "success"); // Success toast
    } catch (e2) {
      setErr(e2.message || "Login failed");
      showToast("Login failed. Please try again.", "error"); // Error toast
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full">
      <div className="flex w-full flex-col justify-center px-4 py-12 sm:px-6 lg:w-[45%] lg:flex-none lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900">Sign in</h2>
          <p className="mt-2 text-sm text-gray-500">
            New here? <button onClick={onSwitch} className="font-semibold text-indigo-600 hover:text-indigo-500">Create account</button>
          </p>

          <form onSubmit={onSubmit} className="mt-10 space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-900">Email address</label>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input-standard mt-2" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-900">Password</label>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="input-standard mt-2" />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <input id="remember" type="checkbox" className="size-4 rounded border-gray-300 text-indigo-600" />
                <label htmlFor="remember" className="text-sm text-gray-900">Remember me</label>
              </div>
              <button onClick={onForgot} className="text-sm font-semibold text-indigo-600">Forgot password?</button>
            </div>
            {err && <div className="text-red-500 text-sm">{err}</div>}
            <button type="submit" disabled={busy} className="btn-primary py-2.5">{busy ? "Signing in..." : "Sign in"}</button>
          </form>
        </div>
      </div>
      <div className="relative hidden w-0 flex-1 lg:block">
        <img className="absolute inset-0 size-full object-cover" src="https://images.unsplash.com/photo-1496917756835-20cb06e75b4e?auto=format&fit=crop&w=1908&q=80" alt="Workspace" />
      </div>
    </div>
  );
}
