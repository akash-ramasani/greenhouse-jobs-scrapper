import React, { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase";
import Card from "../components/Card.jsx";
import TextField from "../components/TextField.jsx";

export default function Login({ onSwitch }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (e2) {
      setErr(e2.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-2 gap-6 items-start">
      <Card>
        <h1 className="text-2xl font-semibold">Login</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Sign in to manage your Greenhouse links.
        </p>

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
          />

          {err ? <div className="text-red-400 text-sm">{err}</div> : null}

          <button
            disabled={busy}
            className="w-full px-3 py-2 rounded-xl bg-zinc-100 text-black font-medium hover:bg-white transition disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <button
          onClick={onSwitch}
          className="mt-4 text-sm text-zinc-400 hover:text-zinc-200 transition"
        >
          Need an account? Create one →
        </button>
      </Card>

      <Card className="p-6">
        <h2 className="font-semibold">What you get</h2>
        <ul className="mt-3 space-y-2 text-sm text-zinc-400">
          <li>• Add multiple Greenhouse job JSON feed links</li>
          <li>• Backend polls every 30 minutes</li>
          <li>• New jobs are stored in your profile</li>
        </ul>
      </Card>
    </div>
  );
}