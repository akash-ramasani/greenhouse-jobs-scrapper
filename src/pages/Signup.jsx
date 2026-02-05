import React, { useState } from "react";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "../firebase";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { useToast } from "../components/Toast/ToastProvider.jsx"; // Added Import

export default function Signup({ onSwitch }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const { showToast } = useToast(); // Initialize Toast

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      
      await setDoc(doc(db, "users", cred.user.uid), {
        email: cred.user.email,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        fullName: `${firstName.trim()} ${lastName.trim()}`,
        createdAt: serverTimestamp(),
        lastFetchAt: null
      }, { merge: true });

      showToast("Account created successfully!", "success");
    } catch (e2) {
      const errorMessage = e2.message || "Signup failed";
      setErr(errorMessage);
      showToast(errorMessage, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white">
      <div className="flex w-full flex-col justify-center px-4 py-12 sm:px-6 lg:w-[45%] lg:flex-none lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm">
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-gray-900">Create account</h2>
            <p className="mt-2 text-sm text-gray-500">
              Already have an account?{' '}
              <button onClick={onSwitch} className="font-semibold text-indigo-600 hover:text-indigo-500">
                Sign in instead
              </button>
            </p>
          </div>

          <div className="mt-10">
            <form onSubmit={onSubmit} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-900">First name</label>
                  <div className="mt-2">
                    <input
                      type="text"
                      required
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900">Last name</label>
                  <div className="mt-2">
                    <input
                      type="text"
                      required
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900">Email address</label>
                <div className="mt-2">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900">Password</label>
                <div className="mt-2">
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
                  />
                </div>
              </div>

              {err && <div className="text-red-500 text-sm font-medium">{err}</div>}

              <div>
                <button
                  type="submit"
                  disabled={busy}
                  className="btn-primary w-full py-2.5 text-base"
                >
                  {busy ? "Creating account..." : "Register"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <div className="relative hidden w-0 flex-1 lg:block">
        <img
          alt="Clean workspace"
          src="https://images.unsplash.com/photo-1496917756835-20cb06e75b4e?auto=format&fit=crop&w=1908&q=80"
          className="absolute inset-0 size-full object-cover"
        />
      </div>
    </div>
  );
}