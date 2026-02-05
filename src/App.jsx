// src/App.jsx
import React, { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { auth, db } from "./firebase";

// Components
import TopBar from "./components/TopBar.jsx";

// Pages
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import Home from "./pages/Home.jsx"; // This is now your main landing page
import Jobs from "./pages/Jobs.jsx";
import Profile from "./pages/Profile.jsx";
import FetchHistory from "./pages/FetchHistory.jsx";

// Import ToastProvider (Capital 'Toast' for Case Sensitivity Fix)
import { ToastProvider } from "./components/Toast/ToastProvider.jsx";

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
      // If user logs out, reset to home and login mode
      if (!u) {
        setPage("home");
        setMode("login");
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) {
      setUserMeta(null);
      return;
    }
    const ref = doc(db, "users", user.uid);
    return onSnapshot(ref, (snap) => setUserMeta(snap.exists() ? snap.data() : null));
  }, [user]);

  const content = useMemo(() => {
    if (loading) {
      return (
        <div className="flex h-screen items-center justify-center bg-white">
          <div className="text-sm font-medium text-gray-400 animate-pulse tracking-widest uppercase">
            Loading JobWatch...
          </div>
        </div>
      );
    }

    if (!user) {
      if (mode === "login") return <Login onSwitch={() => setMode("signup")} onForgot={() => setMode("forgot")} />;
      if (mode === "signup") return <Signup onSwitch={() => setMode("login")} />;
      if (mode === "forgot") return <ForgotPassword onBack={() => setMode("login")} />;
    }

    // Authenticated Navigation
    switch (page) {
      case "jobs":
        return <Jobs user={user} userMeta={userMeta} />;
      case "profile":
        return <Profile user={user} userMeta={userMeta} />;
      case "history":
        return <FetchHistory user={user} />;
      default:
        return <Home user={user} />;
    }
  }, [loading, user, mode, page, userMeta]);

  return (
    <ToastProvider>
      <div className="h-full bg-white">
        {user && (
          <TopBar 
            user={user} 
            userMeta={userMeta} 
            page={page} 
            setPage={setPage} 
            onLogout={() => signOut(auth)} 
          />
        )}

        {!user ? (
          <div className="h-full">{content}</div>
        ) : (
          <main className="py-10">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <AnimatePresence mode="wait">
                <motion.div 
                  key={page} 
                  initial={{ opacity: 0, y: 10 }} 
                  animate={{ opacity: 1, y: 0 }} 
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  {content}
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        )}
      </div>
    </ToastProvider>
  );
}