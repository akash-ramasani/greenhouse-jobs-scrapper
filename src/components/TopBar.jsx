import React from "react";
import { motion } from "framer-motion";

export default function TopBar({ user, onLogout }) {
  return (
    <div className="sticky top-0 z-20 border-b border-zinc-900 bg-black/60 backdrop-blur">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="flex items-baseline gap-2"
          >
            <span className="font-semibold tracking-tight">Job Watch</span>
            <span className="text-xs text-zinc-500">Greenhouse feeds</span>
          </motion.div>
        </div>

        {user ? (
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500 hidden sm:block">{user.email}</span>
            <button
              onClick={onLogout}
              className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-sm transition"
            >
              Logout
            </button>
          </div>
        ) : (
          <span className="text-xs text-zinc-600">Auth</span>
        )}
      </div>
    </div>
  );
}