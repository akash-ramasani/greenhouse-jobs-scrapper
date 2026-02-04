import React, { useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "./firebase";
import { AnimatePresence, motion } from "framer-motion";
import TopBar from "./components/TopBar.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import Dashboard from "./pages/Dashboard.jsx";

export default function App() {
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState("login");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  return (
    <div className="min-h-screen bg-glow">
      <TopBar user={user} onLogout={() => signOut(auth)} />

      <div className="max-w-5xl mx-auto px-4 py-10">
        {loading ? (
          <div className="grid place-items-center py-24 text-zinc-500">Loading…</div>
        ) : (
          <AnimatePresence mode="wait">
            {user ? (
              <motion.div
                key="dash"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.25 }}
              >
                <Dashboard user={user} />
              </motion.div>
            ) : mode === "login" ? (
              <motion.div
                key="login"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.25 }}
              >
                <Login onSwitch={() => setMode("signup")} />
              </motion.div>
            ) : (
              <motion.div
                key="signup"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.25 }}
              >
                <Signup onSwitch={() => setMode("login")} />
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}