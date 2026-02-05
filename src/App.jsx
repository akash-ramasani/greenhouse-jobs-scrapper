// src/App.jsx
import React, { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { auth, db } from "./firebase";

// Importing components
import TopBar from "./components/TopBar.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import Home from "./pages/Home.jsx";
import Jobs from "./pages/Jobs.jsx";
import Profile from "./pages/Profile.jsx";
import FetchHistory from "./pages/FetchHistory.jsx";

// Import ToastProvider for the app's toasts
import ToastProvider from "./components/toast/ToastProvider";

export default function App() {
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState("login");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("home");
  const [userMeta, setUserMeta] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
      if (!u) setPage("home");
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return;
    const ref = doc(db, "users", user.uid);
    return onSnapshot(ref, (snap) => setUserMeta(snap.exists() ? snap.data() : null));
  }, [user]);

  const content = useMemo(() => {
    if (loading) return <div className="flex h-full items-center justify-center text-gray-400">Loading JobWatch...</div>;

    if (!user) {
      if (mode === "login") return <Login onSwitch={() => setMode("signup")} onForgot={() => setMode("forgot")} />;
      if (mode === "signup") return <Signup onSwitch={() => setMode("login")} />;
      if (mode === "forgot") return <ForgotPassword onBack={() => setMode("login")} />;
    }

    if (page === "jobs") return <Jobs user={user} userMeta={userMeta} />;
    if (page === "profile") return <Profile user={user} userMeta={userMeta} />;
    if (page === "history") return <FetchHistory user={user} />;
    return <Home user={user} />;
  }, [loading, user, mode, page, userMeta]);

  return (
    // Wrap the entire app with ToastProvider for global toast usage
    <ToastProvider>
      <div className="h-full">
        {user && <TopBar user={user} userMeta={userMeta} page={page} setPage={setPage} onLogout={() => signOut(auth)} />}

        {!user ? (
          <div className="h-full">{content}</div>
        ) : (
          <main className="py-10">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <AnimatePresence mode="wait">
                <motion.div key={page} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
                  {content}
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        )}
      </div>
    </ToastProvider> // Ensure this wraps your whole app
  );
}
