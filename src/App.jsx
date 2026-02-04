import React, { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { auth, db } from "./firebase";

import TopBar from "./components/TopBar.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import Home from "./pages/Home.jsx";
import Jobs from "./pages/Jobs.jsx";
import Profile from "./pages/Profile.jsx";

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
    if (loading) return <div className="py-24 text-center text-gray-500">Loading…</div>;
    if (!user) return mode === "login" ? <Login onSwitch={() => setMode("signup")} /> : <Signup onSwitch={() => setMode("login")} />;

    if (page === "jobs") return <Jobs user={user} />;
    if (page === "profile") return <Profile user={user} userMeta={userMeta} />;
    return <Home user={user} userMeta={userMeta} />;
  }, [loading, user, mode, page, userMeta]);

  return (
    <div className="min-h-screen bg-gray-50">
      <TopBar 
        user={user} 
        userMeta={userMeta} 
        page={page} 
        setPage={setPage} 
        onLogout={() => signOut(auth)} 
      />
      <main className="py-10">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={`${user ? "authed" : "anon"}-${page}-${mode}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22 }}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}