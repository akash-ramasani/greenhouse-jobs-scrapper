import React, { useState } from "react";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "../firebase";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import Card from "../components/Card.jsx";
import TextField from "../components/TextField.jsx";

export default function Signup({ onSwitch }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);

      await setDoc(
        doc(db, "users", cred.user.uid),
        {
          email: cred.user.email,
          createdAt: serverTimestamp(),
          lastFetchAt: null
        },
        { merge: true }
      );
    } catch (e2) {
      setErr(e2.message || "Signup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-2 gap-6 items-start">
      <Card>
        <h1 className="text-2xl font-semibold">Create account</h1>
        <p className="text-sm text-zinc-400 mt-1">Email + password.</p>

        <form onSubmit={onSubmit} className="mt-6 space-y-3">
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />

          {err ? <div className="text-red-400 text-sm">{err}</div> : null}

          <button
            disabled={busy}
            className="w-full px-3 py-2 rounded-xl bg-zinc-100 text-black font-medium hover:bg-white transition disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>

        <button
          onClick={onSwitch}
          className="mt-4 text-sm text-zinc-400 hover:text-zinc-200 transition"
        >
          Already have an account? Login →
        </button>
      </Card>

      <Card>
        <h2 className="font-semibold">Next</h2>
        <p className="mt-3 text-sm text-zinc-400">
          After creating your account, add your Greenhouse links on the dashboard.
          They’ll appear in your profile immediately after saving.
        </p>
      </Card>
    </div>
  );
}
