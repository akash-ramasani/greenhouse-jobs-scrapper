import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

export default function TopBar({ user, userMeta, page, setPage, onLogout }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-gray-200 bg-white/80 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-10">
            <button 
              onClick={() => setPage("home")} 
              className="flex items-center gap-2 transition-opacity hover:opacity-80"
            >
              <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
                <span className="text-white font-bold text-lg">J</span>
              </div>
              <span className="text-xl font-bold tracking-tight text-gray-900">JobWatch</span>
            </button>

            {user && (
              <div className="hidden md:flex items-center gap-1">
                <NavButton active={page === "home"} onClick={() => setPage("home")}>Dashboard</NavButton>
                <NavButton active={page === "jobs"} onClick={() => setPage("jobs")}>Jobs</NavButton>
                <NavButton active={page === "profile"} onClick={() => setPage("profile")}>Settings</NavButton>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-6">
                <div className="hidden md:flex flex-col items-end">
                  <span className="text-sm font-semibold text-gray-900">
                    {userMeta?.firstName || "User"}
                  </span>
                  <button 
                    onClick={onLogout}
                    className="text-[11px] font-bold uppercase tracking-wider text-gray-400 hover:text-indigo-600 transition-colors"
                  >
                    Sign Out &rarr;
                  </button>
                </div>
                
                <button className="md:hidden p-2 text-gray-500" onClick={() => setIsMenuOpen(!isMenuOpen)}>
                  <span className="text-2xl">{isMenuOpen ? "✕" : "☰"}</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isMenuOpen && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="md:hidden border-t border-gray-100 bg-white"
          >
            <div className="space-y-1 px-4 py-4">
              <MobileNavButton active={page === "home"} onClick={() => { setPage("home"); setIsMenuOpen(false); }}>Dashboard</MobileNavButton>
              <MobileNavButton active={page === "jobs"} onClick={() => { setPage("jobs"); setIsMenuOpen(false); }}>Jobs</MobileNavButton>
              <MobileNavButton active={page === "profile"} onClick={() => { setPage("profile"); setIsMenuOpen(false); }}>Settings</MobileNavButton>
              <button onClick={onLogout} className="w-full mt-4 rounded-lg bg-gray-50 px-4 py-3 text-left text-sm font-semibold text-red-600">Sign Out</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}

function NavButton({ active, children, onClick }) {
  return (
    <button onClick={onClick} className={`relative px-4 py-2 text-sm font-medium transition-colors ${active ? "text-indigo-600" : "text-gray-500 hover:text-gray-900"}`}>
      {children}
      {active && <motion.div layoutId="activeNav" className="absolute bottom-[-22px] left-0 right-0 h-[2px] bg-indigo-600" />}
    </button>
  );
}

function MobileNavButton({ active, children, onClick }) {
  return (
    <button onClick={onClick} className={`block w-full rounded-lg px-4 py-3 text-left text-base font-medium ${active ? "bg-indigo-50 text-indigo-700" : "text-gray-600 hover:bg-gray-50"}`}>
      {children}
    </button>
  );
}