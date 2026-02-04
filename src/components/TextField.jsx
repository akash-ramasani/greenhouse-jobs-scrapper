import React from "react";

export default function TextField({ label, ...props }) {
  return (
    <label className="block">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <input
        {...props}
        className={
          "w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 " +
          "focus:outline-none focus:border-zinc-600 transition"
        }
      />
    </label>
  );
}